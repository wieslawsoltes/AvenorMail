import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderService } from '../backend/providers/index.js';
import { ProviderLeases } from '../backend/providers/lease.js';
import { seal, unseal } from '../backend/providers/security.js';

const user={userId:'owner'},env={DATA_KEY:Buffer.alloc(32,9).toString('base64'),GOOGLE_CLIENT_ID:'app',GOOGLE_CLIENT_SECRET:'secret',PUBLIC_URL:'https://backend.example.com'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const json=(body,status=200)=>new Response(body===null?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture(t,fetchImpl){const dir=mkdtempSync(join(tmpdir(),'avenor-provider-lease-')),path=join(dir,'mail.db');const db1=new DatabaseSync(path),db2=new DatabaseSync(path);db1.exec('PRAGMA journal_mode=WAL');db1.exec('PRAGMA busy_timeout=5000');db2.exec('PRAGMA busy_timeout=5000');
  t.after(()=>{db1.close();db2.close();rmSync(dir,{recursive:true,force:true});});
  const services=[db1,db2].map(db=>{const service=new ProviderService({db,env,fetchImpl});service.migrate();return service;});
  const secret=seal({accessToken:'expired-token',refreshToken:'refresh-old',expiresAt:0,scope:'https://www.googleapis.com/auth/gmail.modify'},env,'account:owner:account:google');
  db1.prepare('INSERT INTO provider_accounts(id,owner,provider,email,display_name,encrypted_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('account','owner','google','owner@example.com','Owner',secret,Date.now(),Date.now());
  return {db1,db2,first:services[0],second:services[1]};
}

test('separate provider instances and SQLite connections serialize rotating credential refresh',async t=>{
  let requests=0;const {first,second}=fixture(t,async()=>{requests++;await pause(80);return json({access_token:'fresh-token',refresh_token:'refresh-new',expires_in:3600});});
  const [a,b]=await Promise.all([first.accessToken(first.account(user,'account')),second.accessToken(second.account(user,'account'))]);
  assert.equal(a,'fresh-token');assert.equal(b,'fresh-token');assert.equal(requests,1);
  const secret=unseal(second.account(user,'account').encrypted_secret,env,'account:owner:account:google');assert.equal(secret.refreshToken,'refresh-new');
});

test('separate nodes serialize mailbox writes and preserve operation order',async t=>{
  const writes=[];const {first,second,db1}=fixture(t,async(input,init={})=>{
    if(String(input).includes('oauth2'))return json({access_token:'token',refresh_token:'refresh',expires_in:3600});
    if(init.method==='POST'){const data=JSON.parse(init.body);writes.push(data);await pause(60);return json({id:'mail-id'});}return json({id:'mail-id',labelIds:['INBOX','UNREAD']});
  });
  const [a,b]=await Promise.all([first.updateMessage(user,'account','mail-id',{read:true},{idempotencyKey:'first-operation'}),second.updateMessage(user,'account','mail-id',{read:false},{idempotencyKey:'second-operation'})]);
  assert.equal(a.status,'applied');assert.equal(b.status,'applied');assert.deepEqual(writes.map(w=>w.addLabelIds),[[],['UNREAD']]);
  assert.equal(db1.prepare("SELECT count(*) AS n FROM provider_mutations WHERE status='applied'").get().n,2);
});

test('parallel send submissions with identical keys share a persisted acceptance across nodes',async t=>{
  let sends=0;const {first,second}=fixture(t,async(input)=>{if(String(input).includes('oauth2'))return json({access_token:'token',refresh_token:'refresh',expires_in:3600});sends++;await pause(50);return json({id:'sent-message'});});
  const input={user,accountId:'account',message:{to:'recipient@example.com',subject:'One message',body:'Body'},idempotencyKey:'same-send-key'};
  assert.deepEqual(await Promise.all([first.sendMail(input),second.sendMail(input)]),[{status:'accepted',providerId:'sent-message'},{status:'accepted',providerId:'sent-message'}]);assert.equal(sends,1);
});

test('expired lease can be recovered; former owner cannot release a successor lock',async t=>{
  const {db1,db2}=fixture(t,async()=>json({}));const a=new ProviderLeases(db1),b=new ProviderLeases(db2);a.migrate();let release;
  const held=a.run('test',async()=>{await new Promise(resolve=>{release=resolve;});a.assertCurrent();});
  await pause(5);db2.prepare('UPDATE provider_leases SET expires_at=0 WHERE lease_key=?').run('test');
  await b.run('test',async()=>{const token=db2.prepare('SELECT owner_token FROM provider_leases WHERE lease_key=?').get('test').owner_token;release();await assert.rejects(held,{code:'provider_lease_lost',uncertain:true});assert.equal(db2.prepare('SELECT owner_token FROM provider_leases WHERE lease_key=?').get('test').owner_token,token);b.assertCurrent();});
});

test('lease contention expires as a retryable busy response without entering protected operation',async t=>{
  const {db1,db2}=fixture(t,async()=>json({}));const a=new ProviderLeases(db1),b=new ProviderLeases(db2);b.wait=20;let entered=false;
  await a.run('busy',async()=>{await assert.rejects(b.run('busy',async()=>{entered=true;}),{code:'provider_busy',uncertain:false,retryable:true});});assert.equal(entered,false);
});

test('disconnect waits for in-flight mailbox operations instead of invalidating another node mid-send',async t=>{
  let sending=false,finished=false;const {first,second}=fixture(t,async(input)=>{if(String(input).includes('oauth2'))return json({access_token:'token',refresh_token:'refresh',expires_in:3600});sending=true;await pause(80);finished=true;return json({id:'sent-message'});});
  const pending=first.sendMail({user,accountId:'account',message:{to:'recipient@example.com',subject:'Active',body:'Body'},idempotencyKey:'inflight-send'});
  while(!sending)await pause(5);
  const removed=second.handle(new Request(env.PUBLIC_URL+'/api/accounts/account',{method:'DELETE'}),user);
  assert.equal((await pending).status,'accepted');await removed;assert.equal(finished,true);assert.deepEqual(second.listAccounts(user),[]);
});

test('refresh without an explicit scope preserves the originally granted narrow scope',async t=>{
  const {first}=fixture(t,async()=>json({access_token:'new-token',refresh_token:'new-refresh',expires_in:3600}));
  await first.accessToken(first.account(user,'account'));
  const secret=unseal(first.account(user,'account').encrypted_secret,env,'account:owner:account:google');
  assert.equal(secret.scope,'https://www.googleapis.com/auth/gmail.modify');assert.equal(secret.scopeProvided,undefined);
});
