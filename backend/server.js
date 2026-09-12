import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,extname,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase,asD1,FileBucket } from './storage.js';
import { S3Bucket } from './s3-bucket.js';
import { ClusterCoordinator } from './cluster.js';
import { PimGateway } from './pim-sync.js';
import { InboundCalendarService } from './inbound-calendar.js';
import { ComplianceService } from './compliance.js';
import { AuthService } from './auth.js';
import { Permissions } from './permissions.js';
import { AuditLog,RateLimiter,error,digest } from './security.js';
import { ProviderService } from './providers/index.js';
import { installMailWriteback } from './mail-sync.js';
import { DurableScheduler } from './jobs.js';
import { InvitationService } from './invitations.js';
import { RealtimeHub,collaborationDocumentHTML } from './realtime.js';
import { handle as legacy } from '../server/engine.js';
import { toEml } from '../public/core.js';
const response=(data,status=200)=>Response.json(data,{status});
const unpack=r=>({...JSON.parse(r.data),id:r.id,scope:r.scope,owner:r.owner,kind:r.kind,version:r.version,updated:r.updated});
export async function createApplication(options={}){
 const env={...process.env,...options.env};if(!env.PUBLIC_URL)env.PUBLIC_URL='http://localhost:3000';env.PUBLIC_URL=env.PUBLIC_URL.replace(/\/$/,'');env.FRONTEND_URL||=env.PUBLIC_URL+'/';env.DATA_DIR||='./data';env.SEED_SAMPLE_DATA||='false';if(!env.DATA_KEY)throw Error('Set DATA_KEY to a persistent base64-encoded 32-byte encryption key');
 const db=options.db||openDatabase(join(env.DATA_DIR,'avenor.sqlite'),env),bucket=options.bucket||(env.S3_BUCKET?new S3Bucket({env}):new FileBucket(join(env.DATA_DIR,'attachments'),env.DATA_KEY)),audit=new AuditLog(db),limits=new RateLimiter({limit:180}),origins=[new URL(env.PUBLIC_URL).origin,new URL(env.FRONTEND_URL).origin,...(env.ALLOWED_ORIGINS||'').split(',').filter(Boolean)];
 const coordinator=new ClusterCoordinator({db,nodeId:env.CLUSTER_NODE_ID||crypto.randomUUID(),pollMs:Number(env.CLUSTER_POLL_MS)||500}).migrate();
 let hub;const emit=(scope,event)=>{coordinator.publish(scope,event);hub?.publish(scope,event).catch(()=>{});};const auth=new AuthService({db,env,audit});auth.migrate();if(options.bootstrap!==false)await auth.bootstrap();const permissions=new Permissions({db,audit,emit});const authorize=async args=>{if(!auth.user(args.user?.userId))return false;if(!await permissions.authorize(args))return false;if(args.accountId&&['schedule-send','invite','deliver-invitation'].includes(args.action)){const owner=args.scope?.startsWith('user:')?auth.user(args.scope.slice(5)):args.user;if(!owner)return false;const accounts=await providers.listAccounts(owner);return (Array.isArray(accounts)?accounts:accounts.accounts).some(a=>a.id===args.accountId);}return true;};const providers=options.providers||new ProviderService({db,env,emit:(owner,event)=>emit(owner.startsWith('user:')?owner:'user:'+owner,event)});providers.migrate();
 db.exec(`CREATE TABLE IF NOT EXISTS api_operations(owner TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,status INTEGER NOT NULL DEFAULT 0,body TEXT,created INTEGER NOT NULL,PRIMARY KEY(owner,key));CREATE TABLE IF NOT EXISTS send_operations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record_id TEXT NOT NULL,account_id TEXT NOT NULL,status TEXT NOT NULL,detail TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);`);
 const compliance=new ComplianceService({db,env,audit,authorize,bucket,emit});compliance.migrate();
 const pim=new PimGateway({db,providers,env,emit,permissions,auth,coordinator,compliance});
 const runtime={...env,DB:asD1(db),BUCKET:bucket,ALLOWED_ORIGINS:origins};
 async function ingest(user,accountId){return coordinator.withLease('mail-ingest:'+accountId,async lease=>{
  const messages=await providers.syncAccount(user,accountId),scope='user:'+user.userId;
  for(const m of messages){
   lease.assert();if(compliance.wasPurged(m.id))continue;
   const existing=db.prepare('SELECT * FROM records WHERE id=?').get(m.id);
   if(existing&&existing.scope!==scope)throw error('Provider identifier scope conflict',409);
   if(m.deleted){if(existing&&compliance.canDelete(scope,m.id).allowed)db.prepare('UPDATE records SET data=?,deleted=1,version=version+1,updated=? WHERE id=?').run(JSON.stringify({...JSON.parse(existing.data),providerSyncStamp:writeback.stamp()}),Date.now(),m.id);continue;}
   const old=existing?JSON.parse(existing.data):{},attachments=m.metadataOnly?(old.attachments||[]):[];
   for(let i=0;i<(!m.metadataOnly?(m.attachments||[]).length:0);i++){
    const a=m.attachments[i],id=digest(m.id+':'+i+':'+a.name),bytes=a.bytes||a.content;if(!bytes)continue;
    await bucket.put(id,bytes);lease.assert();
    db.prepare('INSERT INTO files(id,owner,scope,name,type,size,created) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id,user.userId,scope,a.name||'attachment',a.type||'application/octet-stream',bytes.byteLength,Date.now());
    attachments.push({id,name:a.name||'attachment',type:a.type||'application/octet-stream',size:bytes.byteLength});
   }
   const data=writeback.preservePending(m.id,{...(m.metadataOnly?old:{}),...m,attachments,accountId,sample:false,providerSyncStamp:writeback.stamp()});
   for(const key of ['id','deleted','metadataOnly','rawMime','calendarParts','trust','inboundTrust'])delete data[key];
   db.prepare("INSERT INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES (?,?,?,'message',?,1,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=records.version+1,updated=excluded.updated,deleted=CASE WHEN records.deleted=1 AND EXISTS(SELECT 1 FROM jobs WHERE type='provider_mutation' AND json_extract(payload,'$.recordId')=records.id AND status NOT IN ('completed','accepted','cancelled')) THEN 1 ELSE 0 END").run(m.id,user.userId,scope,JSON.stringify(data),Date.now());
   if(m.calendarParts?.length||m.rawMime){const a=providers.account?.(user,accountId);await inbound.ingest({user,accountId,mailboxEmail:a?.email||user.email,messageId:m.internetMessageId||m.providerId||m.id,recordId:m.id,rawMime:m.rawMime,calendarParts:m.calendarParts,trust:m.inboundTrust});}
  }
  lease.assert();await providers.acknowledgeSync?.(user,accountId,messages.batchId);audit.append(user.userId,'provider.sync',scope,{accountId,count:messages.length});emit(scope,{type:'record-change'});return {count:messages.length};
 },{ttl:180000});}

 async function externalSend(payload,{user,idempotencyKey,markAccepted}={}){
  user||=payload.user;user=auth.user(user?.userId);if(!user)throw error('Sender account is disabled or unavailable',403);
  const row=db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(payload.recordId||payload.id);
  if(!row)throw error('Draft not found',404);
  await permissions.require({user,scope:row.scope,recordId:row.id,action:'send'});
  const original=JSON.parse(row.data),accountId=payload.accountId||original.accountId||'';
  const key=digest(user.userId+':'+row.id+':'+accountId+':'+(idempotencyKey||payload.version));
  const prior=db.prepare('SELECT * FROM send_operations WHERE id=?').get(key);
  if(prior?.status==='accepted')return {status:'accepted',record:unpack(db.prepare('SELECT * FROM records WHERE id=?').get(row.id))};
  if(prior&&['submitting','unknown'].includes(prior.status)||['submitting','unknown'].includes(original.delivery))throw Object.assign(error('Submission outcome is uncertain. Check the provider Sent folder before resolving this draft.',409),{uncertain:true});
  if(row.kind!=='message'||row.version!==payload.version||!['drafts','outbox'].includes(original.folder))throw error('The draft changed; review the current version before sending',409);
  let sender=user;if(row.scope.startsWith('user:')&&row.scope!=='user:'+user.userId){sender=auth.user(row.scope.slice(5));if(!sender)throw error('Mailbox owner is unavailable',403);}
  let account;
  if(accountId){const accounts=await providers.listAccounts(sender);account=(Array.isArray(accounts)?accounts:accounts.accounts).find(a=>a.id===accountId);if(!account)throw error('Mail account not found',404);}
  const message=structuredClone(original);
  if(accountId)for(const a of message.attachments||[]){const file=db.prepare('SELECT * FROM files WHERE id=? AND scope=?').get(a.id,row.scope);if(!file)throw error('Attachment access denied',403);const obj=await bucket.get(a.id);if(!obj)throw error('Attachment missing',409);a.bytes=Buffer.from(await obj.arrayBuffer());a.base64=a.bytes.toString('base64');}
  await permissions.require({user,scope:row.scope,recordId:row.id,action:'send'});
  if(!auth.user(user.userId)||!auth.user(sender.userId))throw error('Sender account is disabled or unavailable',403);
  const reviewedBody=collaborationDocumentHTML(db,row.id);if(reviewedBody!=null)message.body=reviewedBody;
  const policySnapshot=db.prepare('SELECT policy FROM compliance_dlp WHERE scope=?').get(row.scope)?.policy||null;
  await compliance.evaluateOutbound({user,scope:row.scope,recordId:row.id,message,acknowledged:payload.acknowledged||[]});
  // No await separates the authoritative CRDT snapshot from the submission lock.
  // The hub rejects writes to submitting records before acknowledging more edits.
  db.exec('BEGIN IMMEDIATE');try{
   const collaborative=collaborationDocumentHTML(db,row.id);if(collaborative!==reviewedBody||(db.prepare('SELECT policy FROM compliance_dlp WHERE scope=?').get(row.scope)?.policy||null)!==policySnapshot)throw error('The draft or data protection policy changed during review; send again after checking the current draft',409);
   if(!auth.user(user.userId)||!permissions.authorize({user,scope:row.scope,recordId:row.id,action:'send'}))throw error('Send permission was revoked',403);
   const submitting={...original,body:message.body,delivery:'submitting'};
   const claim=db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=? AND version=? AND deleted=0').run(JSON.stringify(submitting),Date.now(),row.id,payload.version);
   if(!claim.changes)throw error('Draft changed while preparing delivery',409);
   db.prepare("INSERT INTO send_operations VALUES (?,?,?,?,'submitting',NULL,?,?) ON CONFLICT(id) DO UPDATE SET status='submitting',updated=excluded.updated").run(key,user.userId,row.id,accountId,Date.now(),Date.now());db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  emit(row.scope,{type:'record-change',recordId:row.id});
  try{
   let result,record;
   if(!accountId){
    const req=new Request(env.PUBLIC_URL+'/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:row.id,version:payload.version+1})});
    const res=await legacy(req,{...runtime,DELEGATED_SCOPES:[...permissions.scopes(user).map(d=>d.scope),row.scope]},sender);
    if(!res.ok){const b=await res.json();throw error(b.error,res.status);}
    record=await res.json();result={status:'accepted',transport:'internal'};
   }else{
    const mime=toEml({...message,from:account.email,date:new Date().toISOString()});
    result=await providers.sendMail({user:sender,accountId,message,mime,idempotencyKey:key});
    if(result.status!=='accepted')throw Object.assign(error('Provider could not confirm acceptance',502),{uncertain:true});
    const sent={...original,body:message.body,folder:'sent',delivery:result.rejected?.length?'partial':'accepted',accepted:result.accepted||[],rejected:result.rejected||[],providerId:result.providerId||original.providerId,date:new Date().toISOString(),from:account.email,name:account.displayName||account.email,read:true};
    db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(sent),Date.now(),row.id);
    record=unpack(db.prepare('SELECT * FROM records WHERE id=?').get(row.id));
   }
   db.prepare('UPDATE send_operations SET status=?,detail=?,updated=? WHERE id=?').run('accepted',JSON.stringify(result),Date.now(),key);
   markAccepted?.(result);audit.append(user.userId,'mail.accepted',row.scope,{recordId:row.id,accountId,accepted:result.accepted,rejected:result.rejected});emit(row.scope,{type:'record-change',recordId:row.id});return {status:'accepted',record};
  }catch(e){
   // A local delivery is an atomic database transaction. Provider timeouts can be ambiguous.
   const uncertain=!!accountId&&(e.uncertain||e.status>=500||!e.status);
   const current=db.prepare('SELECT data FROM records WHERE id=?').get(row.id);
   if(current&&JSON.parse(current.data).folder==='sent')throw Object.assign(e,{uncertain:true});
   const failed={...original,body:message.body,delivery:uncertain?'unknown':'failed',deliveryError:e.message};
   db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(failed),Date.now(),row.id);
   db.prepare('UPDATE send_operations SET status=?,detail=?,updated=? WHERE id=?').run(uncertain?'unknown':'failed',JSON.stringify({error:e.message}),Date.now(),key);
   emit(row.scope,{type:'record-change',recordId:row.id});if(uncertain)e.uncertain=true;throw e;
  }
 }
 const scheduler=new DurableScheduler({db,authorize,emit,allowedOrigins:origins,handlers:{send:(payload,ctx)=>externalSend(payload,{user:payload.user,idempotencyKey:ctx.idempotencyKey,markAccepted:ctx.markAccepted}),pim_sync:async payload=>{const user=auth.user(payload.userId);if(user)await pim.sync(user,payload.accountId);return {status:'completed'};},provider_sync:async payload=>{const user=auth.user(payload.userId);if(user)await ingest(user,payload.accountId);return {status:'completed'};}}});scheduler.migrate();
 const writeback=installMailWriteback({db,providers,auth,scheduler,emit});
 async function deliverCalendar({user,scope,recordId,accountId,to,subject,text,calendar,raw,idempotencyKey}){
  user=auth.user(user.userId);if(!user)throw error('Sender account is disabled',403);
  const message={to,subject,body:text,attachments:calendar?[{name:'invite.ics',type:'text/calendar',size:Buffer.byteLength(calendar),bytes:Buffer.from(calendar)}]:[]};
  await compliance.evaluateOutbound({user,scope:scope||'user:'+user.userId,recordId,message});
  return providers.sendMail({user,accountId,message,mime:raw,idempotencyKey});
 }
 const invitations=new InvitationService({db,scheduler,authorize,emit,env,resolveAccount:async({user,accountId})=>{const accounts=await providers.listAccounts(user);const a=(Array.isArray(accounts)?accounts:accounts.accounts).find(a=>a.id===accountId);if(!a)throw error('Choose a connected mail account',400);return a;},deliver:deliverCalendar});invitations.migrate();
 const inbound=new InboundCalendarService({db,emit,authorize,scheduler,resolveAccount:async({user,accountId})=>providers.account(user,accountId),deliver:deliverCalendar});inbound.migrate();
 hub=new RealtimeHub({db,coordinator,authorizeWrite:args=>{const fresh=auth.authenticate(args.request);if(fresh&&typeof fresh.then==='function')throw Error('Live authentication must be synchronous');const r=db.prepare('SELECT kind,data FROM records WHERE id=? AND deleted=0').get(args.recordId);return !!fresh&&fresh.userId===args.user.userId&&r?.kind==='message'&&JSON.parse(r.data).folder==='drafts'&&JSON.parse(r.data).delivery!=='submitting'&&permissions.authorize({...args,user:fresh});},emit:event=>emit(event.scope,{type:'record-change',recordId:event.recordId}),authenticate:req=>auth.authenticate(req),authorize:async args=>{if(args.recordId&&args.action==='write'){const r=db.prepare('SELECT kind,data FROM records WHERE id=? AND deleted=0').get(args.recordId);if(!r||r.kind!=='message'||JSON.parse(r.data).folder!=='drafts'||JSON.parse(r.data).delivery==='submitting')return false;}return authorize(args);},allowedOrigins:origins});hub.migrate();coordinator.migrate();coordinator.start(event=>hub.receiveClusterEvent(event));
 async function route(request){const url=new URL(request.url),path=url.pathname,origin=request.headers.get('origin');if(origin&&!origins.includes(origin))return response({error:'Origin not allowed'},403);if(request.method==='OPTIONS')return new Response(null,{status:204});let user=await auth.authenticate(request);const isPublic=path==='/api/health'||path.startsWith('/api/auth/')||/^\/api\/oauth\/(google|microsoft)\/callback$/.test(path)||path.includes('/invitations/respond/');if(!user&&!isPublic&&path.startsWith('/api/'))return response({error:'Sign in to your Avenor server',login:true},401);limits.take(user?.userId||request.headers.get('x-avenor-client')||'anonymous');let parsed,affectedScope;const parse=async()=>parsed??=await request.clone().json();
 const authResponse=await auth.handle(request,user);if(authResponse)return authResponse;
 if(path==='/api/health')return response({ok:true,version:'0.3.0',scheduler:!!scheduler.timer});
 if(path==='/api/cluster'&&request.method==='GET'){if(user.role!=='admin')throw error('Administrator access required',403);return response({...coordinator.status(),database:env.DATABASE_URL?'libsql':'sqlite',attachments:env.S3_BUCKET?'s3':'filesystem'});}
 const complianceResponse=await compliance.handle(request,user);if(complianceResponse)return complianceResponse;
 const inboundResponse=await inbound.handle(request,user);if(inboundResponse)return inboundResponse;
 const pimResponse=await pim.handle(request,user);if(pimResponse)return pimResponse;
 if(path==='/api/audit'){if(user.role!=='admin')throw error('Administrator access required',403);return response({verification:audit.verify(),entries:db.prepare('SELECT * FROM audit_log ORDER BY sequence DESC LIMIT 1000').all()});}
 const permissionResponse=await permissions.handle(request,user);if(permissionResponse)return permissionResponse;
 const invitationResponse=await invitations.handle(request,user);if(invitationResponse)return invitationResponse;
 const jobsResponse=await scheduler.handle(request,user);if(jobsResponse)return jobsResponse;
 const sync=path.match(/^\/api\/accounts\/([^/]+)\/sync$/);if(sync&&request.method==='POST')return response(await ingest(user,decodeURIComponent(sync[1])));
 if(path==='/api/accounts'&&request.method==='GET'&&url.searchParams.get('scope')?.startsWith('user:')&&url.searchParams.get('scope')!=='user:'+user.userId){const scope=url.searchParams.get('scope');await permissions.require({user,scope,action:'send'});const owner=auth.user(scope.slice(5));if(!owner)throw error('Mailbox owner unavailable',404);return response({accounts:await providers.listAccounts(owner),providers:providers.providerStatus()});}
 const providerResponse=await providers.handle(request,user);if(providerResponse)return providerResponse;
 if(path==='/api/send'&&request.method==='POST'){const b=await parse();const result=await externalSend({...b,recordId:b.id},{user,idempotencyKey:request.headers.get('idempotency-key')||digest(user.userId+':'+b.id+':'+b.version)});return response(result.record);}
 if(path==='/api/data')await permissions.require({user,scope:url.searchParams.get('scope')||'user:'+user.userId,action:'read'});
 if(path==='/api/record'&&request.method!=='GET'){const b=await parse();const r=b.id?db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(b.id):null;const scope=r?.scope||b.scope||'user:'+user.userId;affectedScope=scope;await permissions.require({user,scope,recordId:b.id,action:'write'});if((r?.kind||b.kind)==='message'){const fields=['providerSyncStamp','providerId','provider','accepted','rejected','delivery','deliveryError'];if(request.method==='PATCH'&&r&&JSON.parse(r.data).providerId)fields.push('accountId');const values=request.method==='POST'?b.data:b.patch;if(values&&fields.some(key=>Object.hasOwn(values,key)))throw error('Provider identities and delivery state are managed by the server',400);}if(request.method==='DELETE'){const guard=compliance.canDelete(scope,b.id);if(!guard.allowed)throw error(guard.reason,403);}if(r&&pim.locked(r.id)&&pim.locked(r.id).key!==request.headers.get('idempotency-key'))throw error('A provider change is pending for this item',409);if(r&&JSON.parse(r.data).externalScheduling&&request.method==='PATCH'&&Object.keys(b.patch||{}).some(key=>!['category','notes'].includes(key)))throw error('The organizer controls this meeting. Use the invitation response controls to accept, tentatively accept, or decline.',403);const pimResult=await pim.recordRequest(request,user,b,r);if(pimResult)return pimResult;if(request.method==='PATCH'&&r?.kind==='message'&&b.patch?.body!==undefined){const html=collaborationDocumentHTML(db,r.id);if(html!==null&&html!==undefined){b.patch.body=html;request=new Request(request.url,{method:request.method,headers:request.headers,body:JSON.stringify(b)});}}}
 if(path==='/api/upload'&&request.method==='POST'){const form=await request.clone().formData();await permissions.require({user,scope:String(form.get('scope')||'user:'+user.userId),action:'write'});}
 const delegated=permissions.scopes(user).map(d=>d.scope);const result=await legacy(request,{...runtime,DELEGATED_SCOPES:delegated,OPERATION_ID:request.headers.get('idempotency-key')?digest(user.userId+':'+path+':'+request.headers.get('idempotency-key')):undefined},user);if(result.ok&&request.method!=='GET'){let body;try{body=await result.clone().json();}catch{}const scope=body?.scope||affectedScope||parsed?.scope||'user:'+user.userId;audit.append(user.userId,request.method+' '+path,scope,{recordId:body?.id||parsed?.id});emit(scope,{type:'record-change',recordId:body?.id||parsed?.id});}
 if(path==='/api/data'&&result.ok){const data=await result.json();data.delegations=permissions.scopes(user).map(d=>({...d,name:db.prepare('SELECT name FROM users WHERE id=?').get(d.scope.slice(5))?.name}));data.capabilities={externalMail:true,live:true,background:true,delegation:true,offline:true,pim:true,inboundCalendar:true,compliance:true,cluster:true};data.mode='connected';for(const record of data.records||[])if(record.kind==='message'){const html=collaborationDocumentHTML(db,record.id);if(html!=null)record.body=html;}return response(data);}return result;
 }
 const pendingOperations=new Set();
 async function handle(request){let result,operation,operationLease;try{
 const path=new URL(request.url).pathname,key=request.headers.get('idempotency-key');const origin=request.headers.get('origin');if(origin&&!origins.includes(origin))throw error('Origin not allowed',403);
 if(key&&path==='/api/record'&&['POST','PATCH','DELETE'].includes(request.method)){
  if(!/^[a-zA-Z0-9:_-]{8,200}$/.test(key))throw error('Invalid idempotency key');
  const user=await auth.authenticate(request);if(user){operationLease=coordinator.acquire('api:'+user.userId+':'+key,{ttl:180000});const body=await request.clone().text(),signature=digest(request.method+path+body),prior=db.prepare('SELECT * FROM api_operations WHERE owner=? AND key=?').get(user.userId,key),opKey=user.userId+':'+key;
   if(prior&&prior.signature!==signature)throw error('Idempotency key was reused for a different operation',409);
   if(prior&&prior.status){const payload=JSON.parse(body),record=payload.id?db.prepare('SELECT scope FROM records WHERE id=?').get(payload.id):null;await permissions.require({user,scope:record?.scope||payload.scope||'user:'+user.userId,action:'read'});result=response(JSON.parse(prior.body),prior.status);}else{
    if(pendingOperations.has(opKey))throw error('This operation is already being processed; retry shortly',409);
    const payload=JSON.parse(body),id=request.method==='POST'?digest(user.userId+':'+path+':'+key):payload.id,record=db.prepare('SELECT * FROM records WHERE id=?').get(id);
    if(prior&&record){const allowed=await authorize({user,scope:record.scope,action:'write'});if(!allowed)throw error('Permission was revoked',403);if(request.method==='POST'&&record.owner===user.userId)result=response(unpack(record),201);else if(request.method==='DELETE'&&record.deleted&&record.version===payload.version+1)result=response({ok:true});else if(request.method==='PATCH'&&record.version===payload.version+1&&Object.entries(payload.patch||{}).every(([k,v])=>JSON.stringify(JSON.parse(record.data)[k])===JSON.stringify(v)))result=response(unpack(record));}
    if(!result){db.prepare('INSERT OR IGNORE INTO api_operations(owner,key,signature,created) VALUES (?,?,?,?)').run(user.userId,key,signature,Date.now());pendingOperations.add(opKey);operation={userId:user.userId,key,opKey};}
   }
  }
 }
 result||=await route(request);
 if(operation&&result.status<500){const body=await result.clone().text();db.prepare('UPDATE api_operations SET status=?,body=? WHERE owner=? AND key=?').run(result.status,body,operation.userId,operation.key);}
 }catch(e){if(!e.status)console.error('API request failed',e);result=response({error:e.status?e.message:'Server request failed; your pending changes have been preserved',...(e.code?{code:e.code}:{}),...(e.warnings?{warnings:e.warnings,acknowledgment:e.acknowledgment,policyVersion:e.policyVersion}:{}),...(e.violations?{violations:e.violations}:{}),...(e.uncertain?{uncertain:true}:{})},e.status||500);}finally{if(operation)pendingOperations.delete(operation.opKey);operationLease?.release();}
 const headers=new Headers(result.headers),origin=request.headers.get('origin');headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');if(origin&&origins.includes(origin)){headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Idempotency-Key');headers.set('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');}return new Response(result.body,{status:result.status,headers});}
 async function retention(){return coordinator.withLease('maintenance:retention',async()=>{await compliance.enforceRetention();await compliance.flushAuditSink();},{ttl:180000});}
 let providerTimer,retentionTimer;
 function startWorkers(){scheduler.start();providerTimer=setInterval(async()=>{
  try{await coordinator.withLease('maintenance:provider-schedule',async()=>{const minute=Math.floor(Date.now()/60000);for(const row of db.prepare('SELECT user_id FROM auth_accounts WHERE disabled=0').all()){
   const user=auth.user(row.user_id);if(!user)continue;
   const accounts=await providers.listAccounts(user);
   for(const a of Array.isArray(accounts)?accounts:accounts.accounts||[])for(const type of ['provider_sync',...(['google','microsoft'].includes(a.provider)?['pim_sync']:[])])scheduler.enqueue({id:type+':'+a.id+':'+minute,type,payload:{userId:user.userId,accountId:a.id},runAt:minute*60000,owner:user.userId,scope:'user:'+user.userId});
  }});}catch(error){if(error.code!=='LEASE_HELD')console.error('Sync schedule failed',error.message);}
 },60000);providerTimer.unref();retentionTimer=setInterval(()=>retention().catch(error=>{if(error.code!=='LEASE_HELD')console.error(error);}),3600000);retentionTimer.unref();}

 const publicRoot=resolve(env.STATIC_DIR||'pages');const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,env.PUBLIC_URL);if(!url.pathname.startsWith('/api/')&&!url.pathname.includes('/invitations/respond/')){const requested=decodeURIComponent(url.pathname),path=resolve(publicRoot,'.'+(requested==='/'?'/index.html':requested));if(!path.startsWith(publicRoot+'/')){res.writeHead(403);return res.end();}let bytes;try{bytes=await readFile(path);}catch{res.writeHead(404);return res.end('Not found');}const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https: wss: ws:; worker-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'"});return res.end(bytes);}let body,bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>12*1024*1024){res.writeHead(413);return res.end('Payload too large');}chunks.push(chunk);}if(chunks.length)body=Buffer.concat(chunks);const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value)headers.set(name,Array.isArray(value)?value.join(','):value);const result=await handle(new Request(url,{method:req.method,headers,...(body?{body}: {})}));res.writeHead(result.status,Object.fromEntries(result.headers));if(result.body)for await(const chunk of result.body)res.write(chunk);res.end();}catch{if(!res.headersSent)res.writeHead(500);res.end('Server error');}});
 hub.attach(server);return {db,env,auth,permissions,providers,pim,inbound,compliance,coordinator,scheduler,invitations,hub,audit,handle,server,startWorkers,ingest,externalSend,async close(){scheduler.stop();clearInterval(providerTimer);clearInterval(retentionTimer);await hub.close();await coordinator.stop();await new Promise(resolve=>server.listening?server.close(resolve):resolve());while(scheduler.running)await new Promise(resolve=>setTimeout(resolve,25));db.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const app=await createApplication();app.startWorkers();app.server.listen(Number(process.env.PORT)||3000,process.env.HOST||'0.0.0.0',()=>console.log('Avenor server listening on '+app.env.PUBLIC_URL));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));}
