import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, FileBucket } from '../backend/storage.js';
import { AuditLog, digest } from '../backend/security.js';
import { ComplianceService, verifyComplianceExport } from '../backend/compliance.js';
import { detectSensitive, evaluatePolicy, validatePolicy } from '../backend/compliance/policies.js';

const admin={userId:'admin',role:'admin'},auditor={userId:'auditor',role:'user'},owner={userId:'owner',role:'user'},scope='user:owner',DAY=86400000;
function fixture(t,{filename=':memory:',env={}}={}){
  const directory=mkdtempSync(join(tmpdir(),'avenor-compliance-')),db=openDatabase(filename),audit=new AuditLog(db),key=Buffer.alloc(32,18).toString('base64'),bucket=new FileBucket(directory,key);
  for(const user of [admin,auditor,owner])db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?)').run(user.userId,user.userId+'@example.test',user.userId,Date.now());
  const service=new ComplianceService({db,audit,bucket,env:{DATA_KEY:key,...env},authorize:async args=>args.user?.userId==='owner'&&args.scope===scope});service.migrate();
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const call=async(path,body,user=admin,method=body===undefined?'GET':'POST')=>{const request=new Request('https://avenor.example/api/compliance/'+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return service.handle(request,user);};
  const json=async(...args)=>(await call(...args)).json();
  const insert=(id='message',data={subject:'Original subject',body:'Original body'},updated=Date.now())=>db.prepare('INSERT INTO records VALUES (?,?,?,\'message\',?,1,?,0)').run(id,'owner',scope,JSON.stringify(data),updated);
  const update=(id,data)=>db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data),Date.now(),id);
  const createCase=async(scopes=[scope])=>(await json('cases',{name:'Case Alpha',reason:'Investigate a documented incident',scopes})).case;
  const grant=rights=>json('grants',{userId:'auditor',scope,rights});
  return {db,audit,bucket,service,call,json,insert,update,createCase,grant};
}

test('revision triggers capture committed inserts, edits, soft deletes and hard deletes; rollback leaves no evidence of uncommitted data',async t=>{
  const f=fixture(t);f.insert();f.update('message',{subject:'Revised',body:'Updated'});
  f.db.prepare('UPDATE records SET deleted=1,version=version+1 WHERE id=?').run('message');
  f.db.prepare('DELETE FROM records WHERE id=?').run('message');
  f.db.exec('BEGIN IMMEDIATE');f.insert('rolledback');f.db.exec('ROLLBACK');
  const rows=f.db.prepare('SELECT * FROM compliance_revisions ORDER BY sequence').all();
  assert.deepEqual(rows.map(row=>row.operation),['insert','update','update','delete']);
  assert.deepEqual(rows.map(row=>row.deleted),[0,0,1,1]);
  assert.equal(f.service.verifyRevisions().valid,true);
  assert.equal(f.service.verifyRevisions().count,4);
  assert.throws(()=>f.db.prepare('UPDATE compliance_revision_data SET data=? WHERE sequence=1').run('{}'),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM compliance_revisions WHERE sequence=1').run(),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM compliance_revision_data WHERE sequence=1').run(),/authorization/);
});

test('migration snapshots preexisting records exactly once across service restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'avenor-compliance-db-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'records.sqlite'),db=openDatabase(file);
  db.prepare('INSERT INTO records VALUES (?,?,?,\'message\',?,1,?,0)').run('old','owner',scope,'{"subject":"Before installation"}',Date.now());db.close();
  const f=fixture(t,{filename:file});f.service.migrate();assert.equal(f.db.prepare('SELECT count(*) AS n FROM compliance_revisions').get().n,1);assert.equal(f.service.verifyRevisions().valid,true);
});

test('case holds preserve historical snapshots while allowing content edits and block deletion in SQL and API checks',async t=>{
  const f=fixture(t);f.insert();const entry=await f.createCase(),hold=(await f.json('holds',{caseId:entry.id,scope,recordId:'message',reason:'Preserve correspondence'})).hold;
  f.update('message',{subject:'Edited while held'});
  assert.equal(f.service.canDelete(scope,'message').allowed,false);
  assert.throws(()=>f.db.prepare('DELETE FROM records WHERE id=?').run('message'),/legal hold/);
  assert.throws(()=>f.db.prepare('UPDATE records SET deleted=1 WHERE id=?').run('message'),/legal hold/);
  assert.throws(()=>f.db.prepare('UPDATE records SET scope=? WHERE id=?').run('user:another','message'),/legal hold/);
  const result=await f.service.search(admin,{caseId:entry.id,recordId:'message'});assert.equal(result.entries.length,2);assert.equal(result.entries[0].data.subject,'Original subject');
  await assert.rejects(f.call('holds/'+hold.id,{reason:'release'},owner,'DELETE'),{status:403});
  await f.call('holds/'+hold.id,{reason:'Counsel approved release'},admin,'DELETE');assert.equal(f.service.canDelete(scope,'message').allowed,true);
});

test('scope holds cover future records and closing a case does not release them',async t=>{
  const f=fixture(t),entry=await f.createCase();await f.json('holds',{caseId:entry.id,scope,reason:'Entire mailbox'});f.insert('future');
  await f.call('cases/'+entry.id,{status:'closed'},admin,'PATCH');assert.equal(f.service.canDelete(scope,'future').allowed,false);
  await assert.rejects(f.json('holds',{caseId:entry.id,scope,reason:'new hold'}),{status:409});
});

test('ordinary mailbox ownership does not grant eDiscovery rights and auditor grants cannot cross scope boundaries',async t=>{
  const f=fixture(t);f.insert();const entry=await f.createCase();
  await assert.rejects(f.service.search(owner,{scopes:[scope]}),{status:403});
  await f.grant(['read']);assert.equal((await f.service.search(auditor,{caseId:entry.id})).entries.length,1);
  await assert.rejects(f.service.search(auditor,{scopes:['user:admin']}),{status:403});
  await assert.rejects(f.json('exports',{caseId:entry.id},auditor),{status:403});
  await assert.rejects(f.json('grants',{userId:'auditor',scope:'user:admin',rights:['export']},auditor),{status:403});
  await f.call('grants',{userId:'auditor',scope},admin,'DELETE');await assert.rejects(f.service.search(auditor,{caseId:entry.id}),{status:403});
});

test('literal eDiscovery search safely treats SQL injection, percent and underscore as literal data',async t=>{
  const f=fixture(t);f.insert('one',{subject:'Sale 50%_off',body:"needle ' OR 1=1 --"});f.insert('two',{subject:'unrelated'});
  assert.equal((await f.service.search(admin,{scopes:[scope],query:"' OR 1=1 --"})).entries.length,1);
  assert.equal((await f.service.search(admin,{scopes:[scope],query:'%_'})).entries.length,1);
  assert.equal((await f.service.search(admin,{scopes:[scope],query:"missing' UNION SELECT * FROM users --"})).entries.length,0);
  await assert.rejects(f.service.search(admin,{scopes:[scope],limit:-1}),{status:400});
});

test('eDiscovery exports contain versioned records and attachment bytes, deterministic manifests, and encrypted persisted packages',async t=>{
  const f=fixture(t),bytes=Buffer.from('Evidence attachment bytes');await f.bucket.put('attachment',bytes);f.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run('attachment','owner',scope,'evidence.txt','text/plain',bytes.length,Date.now());
  f.insert('message',{subject:'Sensitive private evidence',body:'Record body',attachments:[{id:'attachment',name:'evidence.txt'}]});f.update('message',{subject:'Second version',attachments:[{id:'attachment',name:'evidence.txt'}]});
  const entry=await f.createCase(),a=await f.service.createExport(admin,{caseId:entry.id}),b=await f.service.createExport(admin,{caseId:entry.id});assert.equal(a.manifestHash,b.manifestHash);
  const stored=f.db.prepare('SELECT * FROM compliance_exports WHERE id=?').get(a.id);assert.equal(stored.encrypted.includes('Sensitive private evidence'),false);
  const response=await f.service.downloadExport(admin,a.id),bundle=await response.json();assert.equal(response.headers.get('X-Avenor-Manifest-SHA256'),a.manifestHash);assert.equal(bundle.entries.length,2);assert.equal(bundle.attachments.length,1);assert.equal(bundle.attachments[0].sha256,digest(bytes));assert.equal(verifyComplianceExport(bundle,a.manifestHash).valid,true);
  const changed=structuredClone(bundle);changed.entries[0].data.subject='Tampered';assert.equal(verifyComplianceExport(changed,a.manifestHash).valid,false);
  const changedFile=structuredClone(bundle);changedFile.attachments[0].base64=Buffer.from('changed').toString('base64');assert.equal(verifyComplianceExport(changedFile).valid,false);
  const changedManifest=structuredClone(bundle);changedManifest.manifest.entries=[];assert.equal(verifyComplianceExport(changedManifest).valid,false);
  f.db.prepare('UPDATE compliance_exports SET encrypted=? WHERE id=?').run(stored.encrypted.slice(0,-8)+'AAAAAAAA',a.id);await assert.rejects(f.service.downloadExport(admin,a.id),/integrity/);
});

test('export access is checked again after revocation, exports never quietly omit missing evidence attachments',async t=>{
  const f=fixture(t);f.insert();const entry=await f.createCase();await f.grant(['export']);const exported=await f.service.createExport(auditor,{caseId:entry.id});await f.call('grants',{userId:'auditor',scope},admin,'DELETE');await assert.rejects(f.service.downloadExport(auditor,exported.id),{status:403});
  f.update('message',{subject:'Missing attachment',attachments:[{id:'not-present'}]});await assert.rejects(f.service.createExport(admin,{caseId:entry.id}),/attachment is missing/);assert.equal(f.db.prepare("SELECT count(*) AS n FROM compliance_exports WHERE status='failed'").get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM compliance_export_refs').get().n,0);
});

test('retention purges expired live data and snapshot payloads while retaining verified hash and purge ledgers, with hold exceptions',async t=>{
  const f=fixture(t),now=Date.now();f.insert('expired',{subject:'erase after retention'},now-40*DAY);f.insert('held',{subject:'preserve'},now-40*DAY);f.insert('recent',{subject:'recent'},now-5*DAY);
  f.db.prepare('INSERT INTO policies VALUES (?,30,0,?)').run(scope,now);const entry=await f.createCase();await f.json('holds',{caseId:entry.id,scope,recordId:'held',reason:'Preserve despite retention'});
  const result=await f.service.enforceRetention({now});assert.equal(result.deleted,1);assert.equal(result.purged,2);assert.equal(f.db.prepare('SELECT 1 FROM records WHERE id=?').get('expired'),undefined);assert.ok(f.db.prepare('SELECT 1 FROM records WHERE id=?').get('held'));assert.ok(f.db.prepare('SELECT 1 FROM records WHERE id=?').get('recent'));
  const verification=f.service.verifyRevisions();assert.equal(verification.valid,true);assert.equal(verification.purged,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM compliance_purge_permits').get().n,0);
  const evidence=await f.service.search(admin,{scopes:[scope],recordId:'expired',includePurged:true});assert.equal(evidence.entries.length,2);assert.ok(evidence.entries.every(row=>row.purged&&row.data===null));
});

test('legacy scope legal hold also prevents background retention and low-level hard deletion',async t=>{
  const f=fixture(t);f.insert('held',{subject:'Held'},Date.now()-50*DAY);f.db.prepare('INSERT INTO policies VALUES (?,30,1,?)').run(scope,Date.now());assert.equal((await f.service.enforceRetention()).deleted,0);assert.throws(()=>f.db.prepare('DELETE FROM records WHERE id=?').run('held'),/legal hold/);
});

test('DLP detects validated card numbers, IBAN, SSN and private keys without exposing raw matched secrets',()=>{
  assert.deepEqual(detectSensitive('Card 4111 1111 1111 1111'),['credit-card']);assert.deepEqual(detectSensitive('Card 4111 1111 1111 1112'),[]);
  assert.ok(detectSensitive('Account GB82 WEST 1234 5698 7654 32').includes('iban'));assert.ok(detectSensitive('SSN 123-45-6789').includes('us-ssn'));assert.ok(detectSensitive('-----BEGIN PRIVATE KEY-----').includes('secret-key'));
  const policy=validatePolicy({internalDomains:['example.test'],rules:[{id:'card',action:'block',match:{detectors:['credit-card'],externalOnly:true}}]});const result=evaluatePolicy(policy,{to:['outside@external.test'],body:'4111 1111 1111 1111'});assert.equal(result.matches.length,1);assert.equal(JSON.stringify(result.matches).includes('4111'),false);
});

test('DLP policy matching uses AND between conditions, OR within lists, exact domains, literal terms and attachment limits',()=>{
  const policy=validatePolicy({internalDomains:['example.test'],rules:[{id:'outbound',action:'block',match:{classifications:['confidential'],terms:['project [alpha]'],externalOnly:true,recipientDomains:['vendor.test'],attachmentExtensions:['.exe'],maxAttachmentBytes:10}}]});
  const message={to:['vendor@vendor.test'],classification:'confidential',body:'Project [alpha]',attachments:[{name:'tool.exe',size:11}]};assert.equal(evaluatePolicy(policy,message).matches.length,1);assert.equal(evaluatePolicy(policy,{...message,to:['vendor@sub.vendor.test']}).matches.length,0);assert.equal(evaluatePolicy(policy,{...message,body:'Project a'}).matches.length,0);
  assert.throws(()=>validatePolicy({rules:[{id:'bad',action:'block',match:{regex:'(a+)+$'}}]}),/Unknown/);
});

test('outbound DLP blocks and requires content-bound warning acknowledgment; policy updates use compare-and-swap',async t=>{
  const f=fixture(t);f.insert();const warningPolicy={internalDomains:['example.test'],rules:[{id:'external',action:'warn',match:{externalOnly:true,classifications:['confidential']}}]};
  await f.json('dlp',{scope,version:0,policy:warningPolicy});await assert.rejects(f.json('dlp',{scope,version:0,policy:warningPolicy}),{status:409});
  const args={user:owner,scope,recordId:'message',message:{to:['external@other.test'],subject:'Private',body:'Data',classification:'confidential'}};
  let warning;try{await f.service.evaluateOutbound(args);}catch(cause){warning=cause;}assert.equal(warning.code,'dlp_warning');assert.equal(warning.warnings.length,1);
  assert.equal((await f.service.evaluateOutbound({...args,acknowledged:[warning.acknowledgment]})).matches.length,1);
  await assert.rejects(f.service.evaluateOutbound({...args,message:{...args.message,body:'Changed'},acknowledged:[warning.acknowledgment]}),{code:'dlp_warning'});
  await f.json('dlp',{scope,version:1,policy:{...warningPolicy,rules:[{id:'external',action:'block',match:{externalOnly:true}}]}});await assert.rejects(f.service.evaluateOutbound({...args,acknowledged:[warning.acknowledgment]}),{status:422,code:'dlp_blocked'});
  await assert.rejects(f.service.evaluateOutbound({...args,user:auditor}),{status:403});
  const logs=f.db.prepare("SELECT * FROM audit_log WHERE action='compliance.dlp.evaluated'").all();assert.equal(logs.length,4);assert.equal(logs.some(row=>row.detail.includes('Private')),false);
});

test('audit sink uses signed idempotent batches and advances only after an exact acknowledged chain receipt',async t=>{
  const f=fixture(t,{env:{AUDIT_SINK_URL:'https://archive.example.test/append',AUDIT_SINK_TOKEN:'test-token',AUDIT_SINK_HMAC_KEY:'test-hmac'}});f.audit.append('owner','record.created',scope,{id:'message'});f.audit.append('owner','record.updated',scope,{id:'message'});let calls=0,firstKey;
  const fake=async(url,options)=>{calls++;assert.equal(url.protocol,'https:');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-token');assert.match(options.headers['X-Avenor-Signature'],/^sha256=[a-f0-9]{64}$/);const batch=JSON.parse(options.body);if(calls===1){firstKey=options.headers['Idempotency-Key'];return Response.json({acceptedThrough:batch.last,head:'incorrect'});}assert.equal(options.headers['Idempotency-Key'],firstKey);return Response.json({acceptedThrough:batch.last,head:batch.head});};
  await assert.rejects(f.service.flushAuditSink({fetchImpl:fake}),/invalid checkpoint/);assert.equal(f.db.prepare('SELECT sequence FROM compliance_sink').get().sequence,0);
  const result=await f.service.flushAuditSink({fetchImpl:fake});assert.equal(result.sent,2);assert.equal((await f.service.flushAuditSink({fetchImpl:()=>assert.fail('no request expected')})).sent,0);
  assert.throws(()=>f.db.prepare('UPDATE audit_log SET detail=? WHERE sequence=1').run('{}'),/immutable/);
});

test('audit sink configuration is optional and unsafe or anonymous endpoints are rejected before network access',async t=>{
  const f=fixture(t);assert.deepEqual(await f.service.flushAuditSink({fetchImpl:()=>assert.fail()}),{configured:false});f.service.env.AUDIT_SINK_URL='http://archive.test/append';await assert.rejects(f.service.flushAuditSink({fetchImpl:()=>assert.fail()}),{status:503});
});

test('unrelated requests return null and anonymous compliance requests cannot enumerate records',async t=>{
  const f=fixture(t);assert.equal(await f.service.handle(new Request('https://avenor.example/api/record'),admin),null);await assert.rejects(f.call('cases',undefined,null),{status:401});
});

test('in-progress exports prevent retention races until immutable attachment evidence is copied',async t=>{
  const f=fixture(t),now=Date.now(),bytes=Buffer.from('Frozen evidence');await f.bucket.put('slow-attachment',bytes);f.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run('slow-attachment','owner',scope,'slow.txt','text/plain',bytes.length,now-40*DAY);f.insert('old',{subject:'Old',attachments:[{id:'slow-attachment'}]},now-40*DAY);f.db.prepare('INSERT INTO policies VALUES (?,30,0,?)').run(scope,now);const entry=await f.createCase();
  const originalGet=f.bucket.get.bind(f.bucket);let release,started;const began=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});f.bucket.get=async id=>{started();await gate;return originalGet(id);};
  const pending=f.service.createExport(admin,{caseId:entry.id});await began;assert.equal(f.service.canPurge(scope,'old').allowed,false);assert.equal((await f.service.enforceRetention({now})).deleted,0);release();const result=await pending;assert.equal(result.status,'ready');assert.equal((await f.service.enforceRetention({now})).deleted,1);assert.equal(f.service.wasPurged('old'),true);
});

test('retention garbage collection removes only expired unreferenced attachments and persists failed deletion retries',async t=>{
  const f=fixture(t),now=Date.now();for(const id of ['orphan','protected','retry']){await f.bucket.put(id,Buffer.from('Stored '+id));f.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run(id,'owner',scope,id+'.txt','text/plain',20,now-40*DAY);}
  f.insert('live',{subject:'Recent message',attachments:[{id:'protected'}]},now);f.db.prepare('INSERT INTO policies VALUES (?,30,0,?)').run(scope,now);
  const originalDelete=f.bucket.delete.bind(f.bucket);f.bucket.delete=async id=>{if(id==='retry')throw Error('Temporary object storage failure');return originalDelete(id);};
  const first=await f.service.enforceRetention({now});assert.equal(first.filesPurged,1);assert.equal(first.filesPending,1);assert.equal(await f.bucket.get('orphan'),null);assert.ok(await f.bucket.get('protected'));assert.ok(await f.bucket.get('retry'));
  f.bucket.delete=originalDelete;const retry=await f.service.enforceRetention({now});assert.equal(retry.filesPurged,1);assert.equal(retry.filesPending,0);assert.equal(await f.bucket.get('retry'),null);
  assert.throws(()=>f.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run('orphan','owner',scope,'resurrected.txt','text/plain',1,now),/cannot be reused/);
});

test('abandoned export leases expire so a restarted worker can resume policy enforcement',async t=>{
  const f=fixture(t),now=Date.now();f.insert('expired',{subject:'Old'},now-40*DAY);f.db.prepare('INSERT INTO policies VALUES (?,30,0,?)').run(scope,now);const entry=await f.createCase();f.db.prepare("INSERT INTO compliance_exports(id,case_id,scopes,status,created,created_by) VALUES (?,?,?,'building',?,?)").run('abandoned',entry.id,JSON.stringify([scope]),now-16*60000,'admin');f.db.prepare('INSERT INTO compliance_export_refs VALUES (?,?)').run('abandoned',1);
  const result=await f.service.enforceRetention({now});assert.equal(result.deleted,1);assert.equal(f.db.prepare('SELECT status FROM compliance_exports WHERE id=?').get('abandoned').status,'failed');assert.equal(f.db.prepare('SELECT count(*) AS n FROM compliance_export_refs').get().n,0);
});

test('DLP reads textual attachment bytes and detects entity-obfuscated HTML while explicitly classifying unscannable binaries',async t=>{
  const f=fixture(t);f.insert();await f.bucket.put('text',Buffer.from('4111 1111 1111 1111'));f.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?)').run('text','owner',scope,'numbers.txt','text/plain',19,Date.now());
  await f.json('dlp',{scope,version:0,policy:{internalDomains:[],rules:[{id:'secrets',action:'block',match:{detectors:['credit-card','unscannable-attachment']}}]}});
  await assert.rejects(f.service.evaluateOutbound({user:owner,scope,recordId:'message',message:{to:['other@test.example'],body:'Numbers attached',attachments:[{id:'text'}]}}),{code:'dlp_blocked'});
  await assert.rejects(f.service.evaluateOutbound({user:owner,scope,recordId:'message',message:{to:['other@test.example'],body:'&#52;111 <span>1111</span> 1111 1111'}}),{code:'dlp_blocked'});
  await assert.rejects(f.service.evaluateOutbound({user:owner,scope,recordId:'message',message:{to:['other@test.example'],attachments:[{name:'encrypted.pdf',size:200,type:'application/pdf'}]}}),{code:'dlp_blocked'});
});
