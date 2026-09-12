import { randomUUID, createHmac } from 'node:crypto';
import { digest, error, secretBox } from './security.js';
import { canonical, evaluatePolicy, validatePolicy } from './compliance/policies.js';

const DAY=86400000, LIMIT=10000;
const readBody=async request=>{try{return await request.json();}catch{throw error('A JSON request body is required');}};
const metadata=row=>({sequence:row.sequence,recordId:row.record_id,scope:row.scope,kind:row.kind,owner:row.owner,version:row.version,updated:row.record_updated,deleted:row.deleted,operation:row.operation,captured:row.captured});
const requireText=(value,name,max=500)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw error(name+' is required (maximum '+max+' characters)');return value.trim();};
const placeholders=values=>values.map(()=>'?').join(',');
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(cause){db.exec('ROLLBACK');throw cause;}}
const unpack=row=>row?{...row,scopes:JSON.parse(row.scopes||'[]')}:null;

/** Validate an exported package without relying on the originating database. */
export function verifyComplianceExport(bundle, expectedHash) {
  try {
    if(bundle.schema!=='avenor.ediscovery.v1'||!Array.isArray(bundle.entries)||!Array.isArray(bundle.attachments))return {valid:false,reason:'Unsupported package'};
    for(const entry of bundle.entries){
      if(digest(canonical(entry.data))!==entry.integrity.dataHash)return {valid:false,reason:'Record payload hash mismatch',sequence:entry.revision.sequence};
      if(digest(canonical({...entry.revision,dataHash:entry.integrity.dataHash,previous:entry.integrity.previous}))!==entry.integrity.hash)return {valid:false,reason:'Record chain hash mismatch',sequence:entry.revision.sequence};
    }
    for(const file of bundle.attachments)if(digest(Buffer.from(file.base64,'base64'))!==file.sha256)return {valid:false,reason:'Attachment hash mismatch',id:file.id};
    const manifest={schema:bundle.schema,case:bundle.case,criteria:bundle.criteria,cutoff:bundle.cutoff,chainHead:bundle.chainHead,entries:bundle.entries.map(entry=>({sequence:entry.revision.sequence,hash:entry.integrity.hash})),attachments:bundle.attachments.map(({base64:_base64,...file})=>file)};
    if(canonical(manifest)!==canonical(bundle.manifest))return {valid:false,reason:'Manifest contents mismatch'};
    const hash=digest(canonical(manifest));
    if(hash!==bundle.manifestHash||expectedHash&&hash!==expectedHash)return {valid:false,reason:'Manifest hash mismatch'};
    return {valid:true,manifestHash:hash,records:bundle.entries.length,attachments:bundle.attachments.length};
  }catch{return {valid:false,reason:'Invalid package structure'};}
}

/** SQLite/libSQL storage: no custom SQL functions, native extensions, or process-local authorization state. */
export class ComplianceService {
  constructor({db,env={},audit,authorize=async()=>false,bucket,emit=()=>{}}){this.db=db;this.env=env;this.audit=audit;this.authorize=authorize;this.bucket=bucket;this.emit=emit;this.vault=secretBox(env.DATA_KEY);}
  migrate(){
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policies(scope TEXT PRIMARY KEY,retention_days INTEGER NOT NULL DEFAULT 0,legal_hold INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS compliance_grants(user_id TEXT NOT NULL,scope TEXT NOT NULL,rights TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user_id,scope));
      CREATE TABLE IF NOT EXISTS compliance_cases(id TEXT PRIMARY KEY,name TEXT NOT NULL,reason TEXT NOT NULL,scopes TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created INTEGER NOT NULL,created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compliance_holds(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES compliance_cases(id),scope TEXT NOT NULL,record_id TEXT,reason TEXT NOT NULL,created INTEGER NOT NULL,created_by TEXT NOT NULL,released INTEGER,released_by TEXT);
      CREATE INDEX IF NOT EXISTS compliance_holds_scope ON compliance_holds(scope,record_id,released);
      CREATE TABLE IF NOT EXISTS compliance_revisions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,owner TEXT NOT NULL,version INTEGER NOT NULL,record_updated INTEGER NOT NULL,deleted INTEGER NOT NULL,operation TEXT NOT NULL,captured INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS compliance_revisions_record ON compliance_revisions(record_id,sequence);
      CREATE INDEX IF NOT EXISTS compliance_revisions_scope ON compliance_revisions(scope,sequence);
      CREATE TABLE IF NOT EXISTS compliance_revision_data(sequence INTEGER PRIMARY KEY REFERENCES compliance_revisions(sequence),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compliance_revision_hashes(sequence INTEGER PRIMARY KEY REFERENCES compliance_revisions(sequence),data_hash TEXT NOT NULL,previous TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compliance_purge_permits(sequence INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS compliance_purges(sequence INTEGER PRIMARY KEY REFERENCES compliance_revisions(sequence),created INTEGER NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compliance_exports(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES compliance_cases(id),scopes TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,created_by TEXT NOT NULL,manifest_hash TEXT,encrypted TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS compliance_export_refs(export_id TEXT NOT NULL REFERENCES compliance_exports(id),sequence INTEGER NOT NULL REFERENCES compliance_revisions(sequence),PRIMARY KEY(export_id,sequence));
      CREATE TABLE IF NOT EXISTS compliance_dlp(scope TEXT PRIMARY KEY,policy TEXT NOT NULL,version INTEGER NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compliance_file_purges(id TEXT PRIMARY KEY,scope TEXT NOT NULL,created INTEGER NOT NULL,status TEXT NOT NULL,last_error TEXT);
      CREATE TRIGGER IF NOT EXISTS compliance_file_purge_insert BEFORE INSERT ON files WHEN EXISTS(SELECT 1 FROM compliance_file_purges WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'An expired attachment identifier cannot be reused'); END;
      CREATE TABLE IF NOT EXISTS compliance_sink(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL DEFAULT 0,head TEXT NOT NULL DEFAULT '',lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO compliance_sink(id) VALUES (1);
      CREATE TRIGGER IF NOT EXISTS compliance_revision_immutable_update BEFORE UPDATE ON compliance_revisions BEGIN SELECT RAISE(ABORT,'Compliance revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_revision_immutable_delete BEFORE DELETE ON compliance_revisions BEGIN SELECT RAISE(ABORT,'Compliance revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_revision_data_immutable BEFORE UPDATE ON compliance_revision_data BEGIN SELECT RAISE(ABORT,'Compliance snapshots are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_revision_data_delete BEFORE DELETE ON compliance_revision_data WHEN NOT EXISTS(SELECT 1 FROM compliance_purge_permits WHERE sequence=OLD.sequence) BEGIN SELECT RAISE(ABORT,'Snapshot purge requires retention authorization'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_hash_immutable_update BEFORE UPDATE ON compliance_revision_hashes BEGIN SELECT RAISE(ABORT,'Compliance hashes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_hash_immutable_delete BEFORE DELETE ON compliance_revision_hashes BEGIN SELECT RAISE(ABORT,'Compliance hashes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_purge_immutable_update BEFORE UPDATE ON compliance_purges BEGIN SELECT RAISE(ABORT,'Compliance purge ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_purge_immutable_delete BEFORE DELETE ON compliance_purges BEGIN SELECT RAISE(ABORT,'Compliance purge ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_record_hold_delete BEFORE DELETE ON records WHEN EXISTS(SELECT 1 FROM policies WHERE scope=OLD.scope AND legal_hold=1) OR EXISTS(SELECT 1 FROM compliance_holds WHERE scope=OLD.scope AND released IS NULL AND (record_id IS NULL OR record_id=OLD.id)) BEGIN SELECT RAISE(ABORT,'Record is under a legal hold'); END;
      CREATE TRIGGER IF NOT EXISTS compliance_record_hold_update BEFORE UPDATE ON records WHEN (NEW.deleted<>OLD.deleted OR NEW.scope<>OLD.scope OR NEW.id<>OLD.id) AND (EXISTS(SELECT 1 FROM policies WHERE scope=OLD.scope AND legal_hold=1) OR EXISTS(SELECT 1 FROM compliance_holds WHERE scope=OLD.scope AND released IS NULL AND (record_id IS NULL OR record_id=OLD.id))) BEGIN SELECT RAISE(ABORT,'Record is under a legal hold'); END;
    `);
    const snapshot=(ref,operation)=>`INSERT INTO compliance_revisions(record_id,scope,kind,owner,version,record_updated,deleted,operation,captured) VALUES (${ref}.id,${ref}.scope,${ref}.kind,${ref}.owner,${ref}.version,${ref}.updated,${operation==='delete'?1:ref+'.deleted'},'${operation}',CAST(strftime('%s','now') AS INTEGER)*1000);INSERT INTO compliance_revision_data(sequence,data) VALUES (last_insert_rowid(),${ref}.data);`;
    transaction(this.db,()=>{
      // Seed only records that predate revision capture; triggers and the initial copy commit together.
      const initial=this.db.prepare('SELECT * FROM records r WHERE NOT EXISTS(SELECT 1 FROM compliance_revisions c WHERE c.record_id=r.id)').all();
      const insert=this.db.prepare('INSERT INTO compliance_revisions(record_id,scope,kind,owner,version,record_updated,deleted,operation,captured) VALUES (?,?,?,?,?,?,?,\'baseline\',?)');
      for(const row of initial){const result=insert.run(row.id,row.scope,row.kind,row.owner,row.version,row.updated,row.deleted,Date.now());this.db.prepare('INSERT INTO compliance_revision_data(sequence,data) VALUES (?,?)').run(Number(result.lastInsertRowid),row.data);}
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS compliance_capture_insert AFTER INSERT ON records BEGIN ${snapshot('NEW','insert')} END;CREATE TRIGGER IF NOT EXISTS compliance_capture_update AFTER UPDATE ON records BEGIN ${snapshot('NEW','update')} END;CREATE TRIGGER IF NOT EXISTS compliance_capture_delete AFTER DELETE ON records BEGIN ${snapshot('OLD','delete')} END;`);
    });
    // Protect application audit evidence from ordinary SQL mutation too. Operators with database ownership can still drop triggers.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS compliance_audit_immutable_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;CREATE TRIGGER IF NOT EXISTS compliance_audit_immutable_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;`);
    this.sealRevisions();
  }
  sealRevisions(){return transaction(this.db,()=>this._seal());}
  _seal(){
    let previous=this.db.prepare('SELECT hash FROM compliance_revision_hashes ORDER BY sequence DESC LIMIT 1').get()?.hash||'';
    const pending=this.db.prepare('SELECT r.*,d.data FROM compliance_revisions r JOIN compliance_revision_data d ON d.sequence=r.sequence LEFT JOIN compliance_revision_hashes h ON h.sequence=r.sequence WHERE h.sequence IS NULL ORDER BY r.sequence').all();
    for(const row of pending){const dataHash=digest(canonical(JSON.parse(row.data)));const hash=digest(canonical({...metadata(row),dataHash,previous}));this.db.prepare('INSERT INTO compliance_revision_hashes VALUES (?,?,?,?)').run(row.sequence,dataHash,previous,hash);previous=hash;}
    return {count:pending.length,head:previous};
  }
  verifyRevisions(){return transaction(this.db,()=>{this._seal();return this._verify();});}
  _verify(){
    let previous='',count=0,purged=0;
    for(const row of this.db.prepare('SELECT r.*,d.data,h.data_hash,h.previous,h.hash,p.created AS purged_at FROM compliance_revisions r LEFT JOIN compliance_revision_data d ON d.sequence=r.sequence JOIN compliance_revision_hashes h ON h.sequence=r.sequence LEFT JOIN compliance_purges p ON p.sequence=r.sequence ORDER BY r.sequence').all()){
      if(row.previous!==previous||digest(canonical({...metadata(row),dataHash:row.data_hash,previous:row.previous}))!==row.hash)return {valid:false,sequence:row.sequence,reason:'Revision chain mismatch'};
      if(row.data===null){if(!row.purged_at)return {valid:false,sequence:row.sequence,reason:'Missing payload without purge evidence'};purged++;}
      else if(digest(canonical(JSON.parse(row.data)))!==row.data_hash)return {valid:false,sequence:row.sequence,reason:'Revision payload mismatch'};
      previous=row.hash;count++;
    }
    return {valid:true,head:previous,count,purged};
  }
  held(scope,recordId){return !!this.db.prepare('SELECT 1 FROM policies WHERE scope=? AND legal_hold=1 UNION ALL SELECT 1 FROM compliance_holds WHERE scope=? AND released IS NULL AND (record_id IS NULL OR record_id=?) LIMIT 1').get(scope,scope,recordId||'');}
  wasPurged(recordId){return !!this.db.prepare('SELECT 1 FROM compliance_revisions r JOIN compliance_purges p ON p.sequence=r.sequence WHERE r.record_id=? AND NOT EXISTS(SELECT 1 FROM records WHERE id=r.record_id) LIMIT 1').get(recordId);}
  canDelete(scope,recordId){return this.held(scope,recordId)?{allowed:false,reason:'This record is protected by a legal hold'}:{allowed:true};}
  canPurge(scope,recordId,{now=Date.now()}={}){
    const held=this.canDelete(scope,recordId);if(!held.allowed)return held;
    const days=this.db.prepare('SELECT retention_days FROM policies WHERE scope=?').get(scope)?.retention_days||0;
    if(days<=0)return {allowed:false,reason:'No expiration policy is configured'};
    const latest=this.db.prepare('SELECT record_updated FROM compliance_revisions WHERE scope=? AND record_id=? ORDER BY sequence DESC LIMIT 1').get(scope,recordId);
    if(!latest||latest.record_updated>now-days*DAY)return {allowed:false,reason:'The retention period has not elapsed'};
    if(this.db.prepare("SELECT 1 FROM compliance_exports e,json_each(e.scopes) s WHERE e.status='building' AND s.value=? LIMIT 1").get(scope))return {allowed:false,reason:'An evidence export is in progress'};
    if(this.db.prepare("SELECT 1 FROM compliance_export_refs f JOIN compliance_revisions r ON r.sequence=f.sequence JOIN compliance_exports e ON e.id=f.export_id WHERE r.scope=? AND r.record_id=? AND e.status='building' LIMIT 1").get(scope,recordId))return {allowed:false,reason:'An evidence export is in progress'};
    return {allowed:true};
  }
  requireAdmin(user){if(!user)throw error('Sign in required',401);if(user.role!=='admin')throw error('Administrator access is required',403);}
  async requireScope(user,scope,right='read'){
    if(!user)throw error('Sign in required',401);
    if(typeof scope!=='string'||!/^(user|team):[^\s]{1,200}$/.test(scope))throw error('An explicit valid workspace scope is required');
    if(user.role==='admin')return;
    const grant=this.db.prepare('SELECT rights FROM compliance_grants WHERE user_id=? AND scope=?').get(user.userId,scope);
    if(!grant||!JSON.parse(grant.rights).includes(right))throw error('Scoped compliance '+right+' access is required',403);
  }
  async caseFor(user,id,right='read'){
    const entry=unpack(this.db.prepare('SELECT * FROM compliance_cases WHERE id=?').get(id));
    if(!entry)throw error('Case not found',404);
    for(const scope of entry.scopes)await this.requireScope(user,scope,right);
    return entry;
  }
  log(user,action,scope,detail){return this.audit.append(user?.userId||'system','compliance.'+action,scope||'',detail);}
  async search(user,{scopes,caseId,query='',kind,recordId,from=0,to=Number.MAX_SAFE_INTEGER,after=0,limit=100,includePurged=false}={}){
    if(caseId)scopes=(await this.caseFor(user,caseId)).scopes;
    if(!Array.isArray(scopes)||!scopes.length||scopes.length>100)throw error('Select between 1 and 100 explicit scopes');
    scopes=[...new Set(scopes)];for(const scope of scopes)await this.requireScope(user,scope);
    if(typeof query!=='string'||query.length>500)throw error('Search terms must be at most 500 characters');
    for(const value of [from,to,after,limit])if(!Number.isSafeInteger(Number(value))||Number(value)<0)throw error('Invalid numeric search boundary');
    limit=Math.max(1,Math.min(Number(limit),500));
    const clauses=[`r.scope IN (${placeholders(scopes)})`,'r.sequence>?','r.captured>=?','r.captured<=?'],args=[...scopes,Number(after),Number(from),Number(to)];
    if(kind){if(!['message','event','contact','task','settings'].includes(kind))throw error('Invalid record kind');clauses.push('r.kind=?');args.push(kind);}
    if(recordId){clauses.push('r.record_id=?');args.push(String(recordId));}
    if(!includePurged)clauses.push('d.data IS NOT NULL');
    if(query){clauses.push("lower(COALESCE(d.data,'')) LIKE ? ESCAPE '\\'");args.push('%'+query.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%');}
    const rows=this.db.prepare(`SELECT r.*,d.data,h.data_hash,h.previous,h.hash FROM compliance_revisions r LEFT JOIN compliance_revision_data d ON d.sequence=r.sequence LEFT JOIN compliance_revision_hashes h ON h.sequence=r.sequence WHERE ${clauses.join(' AND ')} ORDER BY r.sequence LIMIT ?`).all(...args,limit+1);
    this.log(user,'search',scopes.join(','),{caseId,queryHash:digest(query),kind,recordId,from,to,after,count:Math.min(rows.length,limit)});
    return {entries:rows.slice(0,limit).map(row=>({revision:metadata(row),data:row.data===null?null:JSON.parse(row.data),integrity:row.hash?{hash:row.hash,dataHash:row.data_hash,previous:row.previous}:null,purged:row.data===null})),next:rows.length>limit?rows[limit-1].sequence:null};
  }
  async createExport(user,{caseId,query='',kind,recordId,from=0,to=Number.MAX_SAFE_INTEGER,includeAttachments=true}={}){
    const entry=await this.caseFor(user,caseId,'export');if(entry.status!=='open')throw error('Reopen the case before creating an export',409);
    const id=randomUUID(),criteria={query,kind,recordId,from:Number(from),to:Number(to),includeAttachments:!!includeAttachments};
    const {verification,cutoff}=transaction(this.db,()=>{this._seal();const verification=this._verify();if(!verification.valid)throw error('Revision integrity verification failed',409);const cutoff=this.db.prepare('SELECT MAX(sequence) AS n FROM compliance_revisions').get().n||0;this.db.prepare('INSERT INTO compliance_exports(id,case_id,scopes,status,created,created_by) VALUES (?,?,?,\'building\',?,?)').run(id,entry.id,JSON.stringify(entry.scopes),Date.now(),user.userId);return {verification,cutoff};});
    try{
    // Reuse scoped literal search validation, then hold each selected revision while attachment bytes are read.
    const entries=[];let after=0;
    do{const page=await this.search(user,{caseId,...criteria,after,limit:500});entries.push(...page.entries.filter(item=>item.revision.sequence<=cutoff));after=page.next;if(entries.length>LIMIT)throw error('This export exceeds 10,000 revisions; narrow the case search',413);}while(after&&after<cutoff);
    const byteLimit=Number(this.env.COMPLIANCE_EXPORT_MAX_BYTES)||50*1024*1024;
    let size=Buffer.byteLength(canonical(entries));if(size>byteLimit)throw error('Export size limit exceeded; narrow the search',413);
    transaction(this.db,()=>{
      for(const item of entries)if(!this.db.prepare('SELECT 1 FROM compliance_revision_data WHERE sequence=?').get(item.revision.sequence))throw error('A retention purge changed the search; please retry',409);
      for(const item of entries)this.db.prepare('INSERT INTO compliance_export_refs VALUES (?,?)').run(id,item.revision.sequence);
    });
    this.log(user,'export.started',entry.scopes.join(','),{caseId,id,count:entries.length,cutoff});
      const attachments=[],fileIds=new Set();
      if(includeAttachments)for(const item of entries)for(const attachment of item.data?.attachments||[]){
        if(fileIds.has(attachment.id))continue;fileIds.add(attachment.id);
        const file=this.db.prepare('SELECT * FROM files WHERE id=?').get(attachment.id);
        if(!file||file.scope!==item.revision.scope)throw error('An evidence attachment is missing or belongs to another scope',409);
        const stored=await this.bucket?.get(file.id);if(!stored)throw error('An evidence attachment is unavailable: '+file.id,409);
        const bytes=Buffer.from(await stored.arrayBuffer());size+=Math.ceil(bytes.length/3)*4;if(size>byteLimit)throw error('Export size limit exceeded; narrow the search',413);
        attachments.push({id:file.id,name:file.name,type:file.type,size:bytes.length,sha256:digest(bytes),base64:bytes.toString('base64')});
      }
      // Scope revocation during a slow attachment read must stop the export.
      await this.caseFor(user,caseId,'export');
      const bundle={schema:'avenor.ediscovery.v1',case:{id:entry.id,name:entry.name,reason:entry.reason,scopes:entry.scopes},criteria,cutoff,chainHead:verification.head,entries,attachments:attachments.sort((a,b)=>a.id.localeCompare(b.id))};
      bundle.manifest={schema:bundle.schema,case:bundle.case,criteria,cutoff,chainHead:bundle.chainHead,entries:entries.map(item=>({sequence:item.revision.sequence,hash:item.integrity.hash})),attachments:bundle.attachments.map(({base64:_base64,...file})=>file)};
      bundle.manifestHash=digest(canonical(bundle.manifest));
      const ready=this.db.prepare("UPDATE compliance_exports SET status='ready',manifest_hash=?,encrypted=? WHERE id=? AND status='building'").run(bundle.manifestHash,this.vault.seal(bundle),id);if(!ready.changes)throw error('The export lease expired; retry with a narrower search',409);
      this.db.prepare('DELETE FROM compliance_export_refs WHERE export_id=?').run(id);
      this.log(user,'export.completed',entry.scopes.join(','),{caseId,id,count:entries.length,manifestHash:bundle.manifestHash});
      return {id,status:'ready',manifestHash:bundle.manifestHash,records:entries.length,attachments:attachments.length};
    }catch(cause){this.db.prepare("UPDATE compliance_exports SET status='failed',error=? WHERE id=?").run(String(cause.message).slice(0,500),id);this.db.prepare('DELETE FROM compliance_export_refs WHERE export_id=?').run(id);this.log(user,'export.failed',entry.scopes.join(','),{caseId,id,error:String(cause.message).slice(0,500)});throw cause;}
  }
  async downloadExport(user,id){
    const row=this.db.prepare('SELECT * FROM compliance_exports WHERE id=?').get(id);if(!row)throw error('Export not found',404);await this.caseFor(user,row.case_id,'export');
    if(row.status!=='ready')throw error('Export is not ready',409);let value;try{value=this.vault.open(row.encrypted);}catch{throw error('Encrypted export integrity check failed',409);}
    const verification=verifyComplianceExport(value,row.manifest_hash);if(!verification.valid)throw error('Export integrity check failed: '+verification.reason,409);
    this.log(user,'export.downloaded',JSON.parse(row.scopes).join(','),{id,manifestHash:row.manifest_hash});
    return new Response(canonical(value),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="avenor-evidence-'+id+'.json"','Cache-Control':'private, no-store','X-Avenor-Manifest-SHA256':row.manifest_hash}});
  }
  _expireExports(now=Date.now()){const stale=this.db.prepare("SELECT id FROM compliance_exports WHERE status='building' AND created<?").all(now-15*60000);for(const row of stale){this.db.prepare("UPDATE compliance_exports SET status='failed',error='Export lease expired after an interrupted build' WHERE id=?").run(row.id);this.db.prepare('DELETE FROM compliance_export_refs WHERE export_id=?').run(row.id);this.log(null,'export.expired','',{id:row.id});}return stale.length;}
  retentionPreview({now=Date.now()}={}){return {at:now,scopes:this.db.prepare('SELECT * FROM policies WHERE retention_days>0 ORDER BY scope').all().map(policy=>{const rows=this.db.prepare('SELECT id FROM records WHERE scope=? AND updated<?').all(policy.scope,now-policy.retention_days*DAY);let held=0,eligible=0;for(const row of rows){if(this.held(policy.scope,row.id))held++;else if(this.canPurge(policy.scope,row.id,{now}).allowed)eligible++;}return {scope:policy.scope,retentionDays:policy.retention_days,expiredRecords:rows.length,held,eligible,exportProtected:rows.length-held-eligible};})};}
  async enforceRetention({now=Date.now(),limit=500}={}){
    if(!Number.isSafeInteger(now)||!Number.isInteger(limit)||limit<1||limit>10000)throw error('Invalid retention batch');
    const expired=[];const result=transaction(this.db,()=>{
      this._expireExports(now);this._seal();let deleted=0,purged=0,held=0;
      const policies=this.db.prepare('SELECT * FROM policies WHERE retention_days>0').all();
      for(const policy of policies){
        const records=this.db.prepare('SELECT * FROM records WHERE scope=? AND updated<? ORDER BY updated LIMIT ?').all(policy.scope,now-policy.retention_days*DAY,limit-deleted);
        for(const row of records){if(this.held(row.scope,row.id)){held++;continue;}if(!this.canPurge(row.scope,row.id,{now}).allowed)continue;
          this.db.prepare('DELETE FROM records WHERE id=?').run(row.id);expired.push(row.id);deleted++;
        }
        if(deleted>=limit)break;
      }
      this._seal();
      for(const policy of policies){
        const rows=this.db.prepare("SELECT r.* FROM compliance_revisions r JOIN compliance_revision_data d ON d.sequence=r.sequence WHERE r.scope=? AND r.record_updated<? AND NOT EXISTS(SELECT 1 FROM records current WHERE current.id=r.record_id) AND NOT EXISTS(SELECT 1 FROM compliance_export_refs f JOIN compliance_exports e ON e.id=f.export_id WHERE f.sequence=r.sequence AND e.status='building') AND NOT EXISTS(SELECT 1 FROM compliance_exports e,json_each(e.scopes) s WHERE e.status='building' AND s.value=r.scope) ORDER BY r.sequence LIMIT ?").all(policy.scope,now-policy.retention_days*DAY,limit*100);
        for(const row of rows){if(this.held(row.scope,row.record_id)){held++;continue;}this.db.prepare('INSERT INTO compliance_purge_permits VALUES (?)').run(row.sequence);this.db.prepare('DELETE FROM compliance_revision_data WHERE sequence=?').run(row.sequence);this.db.prepare('INSERT INTO compliance_purges VALUES (?,?,?,?)').run(row.sequence,now,'Retention expired after '+policy.retention_days+' days','system');this.db.prepare('DELETE FROM compliance_purge_permits WHERE sequence=?').run(row.sequence);purged++;}
      }
      this.log(null,'retention.applied','',{deleted,purged,held,at:now});return {deleted,purged,held};
    });
    for(const id of expired)this.emit('',{type:'record-change',recordId:id});
    return {...result,...await this.collectExpiredFiles({now,limit})};
  }
  async collectExpiredFiles({now=Date.now(),limit=500}={}){
    if(!this.bucket?.delete)return {filesPurged:0,filesPending:0};
    transaction(this.db,()=>{
      const candidates=this.db.prepare(`SELECT f.* FROM files f JOIN policies p ON p.scope=f.scope WHERE p.retention_days>0 AND p.legal_hold=0 AND f.created<?-p.retention_days*86400000
        AND NOT EXISTS(SELECT 1 FROM compliance_holds h WHERE h.scope=f.scope AND h.record_id IS NULL AND h.released IS NULL)
        AND NOT EXISTS(SELECT 1 FROM compliance_exports e,json_each(e.scopes) s WHERE e.status='building' AND s.value=f.scope)
        AND NOT EXISTS(SELECT 1 FROM records r,json_each(r.data,'$.attachments') a WHERE json_extract(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END,'$.id')=f.id)
        AND NOT EXISTS(SELECT 1 FROM compliance_revision_data d,json_each(d.data,'$.attachments') a WHERE json_extract(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END,'$.id')=f.id)
        LIMIT ?`).all(now,limit);
      for(const file of candidates){this.db.prepare("INSERT INTO compliance_file_purges(id,scope,created,status) VALUES (?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET status='pending',created=excluded.created,last_error=NULL").run(file.id,file.scope,now);this.db.prepare('DELETE FROM files WHERE id=?').run(file.id);}
    });
    let filesPurged=0;
    for(const row of this.db.prepare("SELECT * FROM compliance_file_purges WHERE status='pending' ORDER BY created LIMIT ?").all(limit)){
      try{await this.bucket.delete(row.id);this.db.prepare("UPDATE compliance_file_purges SET status='completed',last_error=NULL WHERE id=?").run(row.id);filesPurged++;this.log(null,'attachment.purged',row.scope,{id:row.id});}
      catch(cause){this.db.prepare('UPDATE compliance_file_purges SET last_error=? WHERE id=?').run(String(cause.message).slice(0,300),row.id);}
    }
    return {filesPurged,filesPending:this.db.prepare("SELECT count(*) AS n FROM compliance_file_purges WHERE status='pending'").get().n};
  }
  async evaluateOutbound({user,scope,recordId,message,acknowledged=[]}={}){
    if(!user||!await this.authorize({user,scope,recordId,action:'send'}))throw error('Send permission is required',403);
    const row=this.db.prepare('SELECT * FROM compliance_dlp WHERE scope=?').get(scope);const policy=row?JSON.parse(row.policy):{internalDomains:[],rules:[]};
    const attachments=[];
    for(const file of message.attachments||[]){
      const copy={...file},metadata=file.id?this.db.prepare('SELECT * FROM files WHERE id=?').get(file.id):null;
      if(file.id&&(!metadata||metadata.scope!==scope))throw error('An outbound attachment does not belong to this scope',403);
      const textual=/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/.test(metadata?.type||file.type||'')||/\.(txt|csv|json|xml|html?|js|md|log)$/i.test(metadata?.name||file.name||'');
      const size=Number(metadata?.size||file.size||0);copy.size=size;copy.name=metadata?.name||file.name;
      if(policy.rules.length){
        let bytes=file.content||file.bytes;if(!bytes&&metadata){const stored=await this.bucket?.get(metadata.id);if(!stored)throw error('An outbound attachment is missing',409);bytes=Buffer.from(await stored.arrayBuffer());}
        if(bytes){copy.contentHash=digest(bytes);if(textual&&size<=1024*1024)copy.text=Buffer.from(bytes).toString('utf8');else copy.unscannable=true;}else copy.unscannable=true;
      }
      attachments.push(copy);
    }
    const result=evaluatePolicy(policy,{...message,attachments}),blocked=result.matches.filter(item=>item.action==='block'),warnings=result.matches.filter(item=>item.action==='warn');
    const acknowledgment=digest(canonical({scope,recordId,policyVersion:result.policyVersion,contentVersion:result.contentVersion,warnings:warnings.map(item=>item.id)}));
    const accepted=Array.isArray(acknowledged)&&acknowledged.includes(acknowledgment);
    this.log(user,'dlp.evaluated',scope,{recordId,classification:result.classification,policyVersion:result.policyVersion,contentVersion:result.contentVersion,matches:result.matches.map(item=>({id:item.id,action:item.action})),acknowledged:accepted});
    if(blocked.length)throw Object.assign(error('Delivery blocked by workspace data protection policy',422),{code:'dlp_blocked',violations:blocked,policyVersion:result.policyVersion});
    if(warnings.length&&!accepted)throw Object.assign(error('Review and acknowledge the data protection warnings before sending',409),{code:'dlp_warning',warnings,acknowledgment,policyVersion:result.policyVersion});
    return {...result,acknowledgment:accepted?acknowledgment:null};
  }
  async flushAuditSink({fetchImpl=fetch,limit=100}={}){
    if(!this.env.AUDIT_SINK_URL)return {configured:false};
    const url=new URL(this.env.AUDIT_SINK_URL);if(url.protocol!=='https:'||url.username||url.password||!this.env.AUDIT_SINK_TOKEN||!this.env.AUDIT_SINK_HMAC_KEY)throw error('Audit sink requires HTTPS, a bearer token, and an HMAC key',503);
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw error('Invalid audit batch size');
    const lease=randomUUID(),now=Date.now();const claimed=this.db.prepare('UPDATE compliance_sink SET lease=?,lease_until=? WHERE id=1 AND lease_until<?').run(lease,now+60000,now);if(!claimed.changes)return {busy:true};
    try{
      const checkpoint=this.db.prepare('SELECT * FROM compliance_sink WHERE id=1').get();
      if(!this.audit.verify().valid)throw error('Audit integrity check failed',409);
      const entries=this.db.prepare('SELECT * FROM audit_log WHERE sequence>? ORDER BY sequence LIMIT ?').all(checkpoint.sequence,limit);
      if(!entries.length)return {configured:true,sent:0,sequence:checkpoint.sequence};
      if(entries[0].previous!==checkpoint.head)throw error('Audit sink checkpoint mismatch',409);
      const batch={schema:'avenor.audit.v1',first:entries[0].sequence,last:entries.at(-1).sequence,previous:checkpoint.head,head:entries.at(-1).hash,entries},body=canonical(batch),key=digest(body),signature=createHmac('sha256',this.env.AUDIT_SINK_HMAC_KEY).update(body).digest('hex');
      const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.env.AUDIT_SINK_TOKEN,'Idempotency-Key':key,'X-Avenor-Signature':'sha256='+signature},body});
      if(!response.ok)throw error('Audit sink rejected batch with HTTP '+response.status,502);
      const receipt=await response.json();if(receipt.acceptedThrough!==batch.last||receipt.head!==batch.head)throw error('Audit sink returned an invalid checkpoint receipt',502);
      const update=this.db.prepare('UPDATE compliance_sink SET sequence=?,head=?,updated=?,last_error=NULL WHERE id=1 AND lease=?').run(batch.last,batch.head,Date.now(),lease);if(!update.changes)throw error('Audit sink lease was lost before checkpoint',409);
      return {configured:true,sent:entries.length,sequence:batch.last,head:batch.head};
    }catch(cause){this.db.prepare('UPDATE compliance_sink SET last_error=? WHERE id=1 AND lease=?').run(String(cause.message).slice(0,300),lease);throw cause;}finally{this.db.prepare('UPDATE compliance_sink SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').run(lease);}
  }
  async handle(request,user){
    const url=new URL(request.url);if(!url.pathname.startsWith('/api/compliance/'))return null;if(!user)throw error('Sign in required',401);
    const path=url.pathname.slice('/api/compliance/'.length),method=request.method,body=()=>readBody(request),json=value=>Response.json(value,{headers:{'Cache-Control':'private, no-store'}});
    if(path==='grants'){
      this.requireAdmin(user);if(method==='GET')return json({grants:this.db.prepare('SELECT * FROM compliance_grants ORDER BY user_id,scope').all().map(row=>({...row,rights:JSON.parse(row.rights)}))});
      const b=await body();if(!this.db.prepare('SELECT id FROM users WHERE id=?').get(b.userId))throw error('Account not found',404);await this.requireScope(user,b.scope);
      if(method==='DELETE')this.db.prepare('DELETE FROM compliance_grants WHERE user_id=? AND scope=?').run(b.userId,b.scope);
      else if(method==='POST'){if(!Array.isArray(b.rights)||!b.rights.length||b.rights.some(value=>!['read','hold','export','policy'].includes(value)))throw error('Choose valid compliance rights');const rights=[...new Set(['read',...b.rights])];this.db.prepare('INSERT INTO compliance_grants VALUES (?,?,?,?) ON CONFLICT(user_id,scope) DO UPDATE SET rights=excluded.rights').run(b.userId,b.scope,JSON.stringify(rights),Date.now());}
      else throw error('Method not allowed',405);this.log(user,'grants.changed',b.scope,{userId:b.userId,rights:method==='DELETE'?[]:b.rights});return json({ok:true});
    }
    if(path==='cases'){
      if(method==='GET'){const cases=[];for(const row of this.db.prepare('SELECT * FROM compliance_cases ORDER BY created DESC').all()){try{cases.push(await this.caseFor(user,row.id));}catch(cause){if(cause.status!==403)throw cause;}}return json({cases});}
      if(method!=='POST')throw error('Method not allowed',405);const b=await body();if(!Array.isArray(b.scopes)||!b.scopes.length||b.scopes.length>100)throw error('Choose 1 to 100 scopes');const scopes=[...new Set(b.scopes)].sort();for(const scope of scopes)await this.requireScope(user,scope,'hold');const entry={id:randomUUID(),name:requireText(b.name,'Case name',160),reason:requireText(b.reason,'Case reason'),scopes,status:'open',created:Date.now(),created_by:user.userId};this.db.prepare('INSERT INTO compliance_cases VALUES (?,?,?,?,?,?,?)').run(entry.id,entry.name,entry.reason,JSON.stringify(scopes),entry.status,entry.created,entry.created_by);this.log(user,'case.created',scopes.join(','),{caseId:entry.id});return json({case:entry});
    }
    if(path.startsWith('cases/')&&method==='PATCH'){const entry=await this.caseFor(user,path.slice(6),'hold'),b=await body();if(!['open','closed'].includes(b.status))throw error('Choose open or closed');this.db.prepare('UPDATE compliance_cases SET status=? WHERE id=?').run(b.status,entry.id);this.log(user,'case.status',entry.scopes.join(','),{caseId:entry.id,status:b.status});return json({ok:true});}
    if(path==='holds'){
      if(method==='GET'){const entry=await this.caseFor(user,url.searchParams.get('caseId'));return json({holds:this.db.prepare('SELECT * FROM compliance_holds WHERE case_id=? ORDER BY created').all(entry.id)});}
      if(method!=='POST')throw error('Method not allowed',405);const b=await body(),entry=await this.caseFor(user,b.caseId,'hold');if(entry.status!=='open')throw error('Reopen the case to add a hold',409);if(!entry.scopes.includes(b.scope))throw error('Scope is outside this case',403);
      if(b.recordId&&!this.db.prepare('SELECT 1 FROM compliance_revisions WHERE scope=? AND record_id=?').get(b.scope,b.recordId))throw error('Record not found in case scope',404);
      const hold={id:randomUUID(),caseId:entry.id,scope:b.scope,recordId:b.recordId||null,reason:requireText(b.reason,'Hold reason'),created:Date.now()};this.db.prepare('INSERT INTO compliance_holds(id,case_id,scope,record_id,reason,created,created_by) VALUES (?,?,?,?,?,?,?)').run(hold.id,entry.id,hold.scope,hold.recordId,hold.reason,hold.created,user.userId);this.log(user,'hold.created',hold.scope,hold);return json({hold});
    }
    if(path.startsWith('holds/')&&method==='DELETE'){const hold=this.db.prepare('SELECT * FROM compliance_holds WHERE id=?').get(path.slice(6));if(!hold)throw error('Hold not found',404);await this.caseFor(user,hold.case_id,'hold');const b=await body();const reason=requireText(b.reason,'Release reason');this.db.prepare('UPDATE compliance_holds SET released=?,released_by=? WHERE id=? AND released IS NULL').run(Date.now(),user.userId,hold.id);this.log(user,'hold.released',hold.scope,{holdId:hold.id,reason});return json({ok:true});}
    if(path==='search'&&method==='POST'){this.sealRevisions();return json(await this.search(user,await body()));}
    if(path==='exports'&&method==='POST')return json(await this.createExport(user,await body()));
    if(path==='exports'&&method==='GET'){const entry=await this.caseFor(user,url.searchParams.get('caseId'),'export');return json({exports:this.db.prepare('SELECT id,status,created,created_by,manifest_hash,error FROM compliance_exports WHERE case_id=? ORDER BY created DESC').all(entry.id)});}
    if(path.startsWith('exports/')&&method==='GET')return this.downloadExport(user,path.slice(8));
    if(path==='verify'&&method==='GET'){this.requireAdmin(user);const result={revisions:this.verifyRevisions(),audit:this.audit.verify()};this.log(user,'integrity.checked','',{valid:result.revisions.valid&&result.audit.valid});return json(result);}
    if(path==='retention'&&method==='GET'){this.requireAdmin(user);return json(this.retentionPreview());}
    if(path==='retention'&&method==='POST'){this.requireAdmin(user);return json(await this.enforceRetention());}
    if(path==='dlp'){
      const b=method==='GET'?Object.fromEntries(url.searchParams):await body();await this.requireScope(user,b.scope,'policy');
      if(method==='GET'){const row=this.db.prepare('SELECT * FROM compliance_dlp WHERE scope=?').get(b.scope);return json({policy:row?JSON.parse(row.policy):{internalDomains:[],rules:[]},version:row?.version||0});}
      if(method!=='POST')throw error('Method not allowed',405);const policy=validatePolicy(b.policy),version=Number(b.version);if(!Number.isSafeInteger(version)||version<0)throw error('A policy version is required');
      transaction(this.db,()=>{const row=this.db.prepare('SELECT version FROM compliance_dlp WHERE scope=?').get(b.scope);if((row?.version||0)!==version)throw error('Policy changed; reload before saving',409);this.db.prepare('INSERT INTO compliance_dlp VALUES (?,?,1,?,?) ON CONFLICT(scope) DO UPDATE SET policy=excluded.policy,version=compliance_dlp.version+1,updated=excluded.updated,actor=excluded.actor').run(b.scope,canonical(policy),Date.now(),user.userId);this.log(user,'dlp.policy_changed',b.scope,{version:version+1,hash:digest(canonical(policy))});});return json({policy,version:version+1});
    }
    if(path==='audit-sink'&&method==='GET'){this.requireAdmin(user);const row=this.db.prepare('SELECT sequence,head,updated,last_error FROM compliance_sink WHERE id=1').get();return json({configured:!!this.env.AUDIT_SINK_URL,...row});}
    if(path==='audit-sink'&&method==='POST'){this.requireAdmin(user);return json(await this.flushAuditSink());}
    throw error('Compliance endpoint not found',404);
  }
}
