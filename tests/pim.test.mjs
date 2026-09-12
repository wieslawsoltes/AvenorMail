import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PimService, normalizeContact, normalizeEvent, eventWriteBody, contactWriteBody, pimRecordId } from '../backend/providers/pim.js';
const user={userId:'owner'};
const env={DATA_KEY:Buffer.alloc(32,4).toString('base64')};
const gEvent=(id='event-a',extra={})=>({id,etag:'"v1"',summary:'Roadmap',start:{dateTime:'2026-09-12T09:00:00+02:00',timeZone:'Europe/Warsaw'},end:{dateTime:'2026-09-12T10:00:00+02:00',timeZone:'Europe/Warsaw'},...extra});
const gContact=(id='a',extra={})=>({resourceName:'people/'+id,etag:'"person1"',names:[{displayName:'Anna Doe',givenName:'Anna',familyName:'Doe'}],emailAddresses:[{value:'anna@example.com'}],metadata:{sources:[{type:'CONTACT',id,etag:'source1'}]},...extra});
function setup(provider='google',dispatch,db=new DatabaseSync(':memory:')){
 const calls=[],account={id:'account',owner:'owner',provider,email:'owner@example.com'};
 const providers={account(u,id){assert.equal(u.userId,'owner');assert.equal(id,'account');return account;},async cloudRequest(u,id,url,init){calls.push({url,init});return dispatch(new URL(url),init,calls);}};
 const pim=new PimService({db,providers,env,now:()=>Date.UTC(2026,8,12)});pim.migrate();return {pim,db,calls,providers};
}
function googleBase(url,overrides={}){
 if(url.pathname.endsWith('/calendarList'))return {items:[{id:'primary@example.com',summary:'Main',primary:true,accessRole:'owner',timeZone:'Europe/Warsaw'}]};
 if(url.pathname.endsWith('/events'))return {items:[gEvent()],nextSyncToken:'events1',...overrides.events};
 if(url.pathname.endsWith('/connections'))return {connections:[gContact()],nextSyncToken:'people1',...overrides.contacts};
 throw Error('Unexpected '+url.href);
}
function graphBase(url,overrides={}){
 if(url.pathname.endsWith('/calendars'))return {value:[{id:'main',name:'Calendar',isDefaultCalendar:true,canEdit:true}]};
 if(url.pathname.endsWith('/calendarView/delta'))return {value:[{id:'event'}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/calendarView/delta?delta=one',...overrides.delta};
 if(url.pathname.endsWith('/events'))return {value:[{id:'event','@odata.etag':'"1"',subject:'Review',start:{dateTime:'2026-09-12T09:00:00',timeZone:'UTC'},end:{dateTime:'2026-09-12T10:00:00',timeZone:'UTC'}}],...overrides.events};
 if(url.pathname.endsWith('/contactFolders'))return {value:[]};
 if(url.pathname.endsWith('/contacts'))return {value:[],...overrides.contacts};
 throw Error('Unexpected '+url.href);
}
test('Google calendars and contacts paginate completely, retaining query parameters and committing cursors only after ACK',async()=>{
 const {pim,db,calls}=setup('google',url=>{
  if(url.pathname.endsWith('/events'))return url.searchParams.has('pageToken')?{items:[gEvent('event-b')],nextSyncToken:'events2'}:{items:[gEvent()],nextPageToken:'next'};
  if(url.pathname.endsWith('/connections'))return url.searchParams.has('pageToken')?{connections:[gContact('b')],nextSyncToken:'people2'}:{connections:[gContact()],nextPageToken:'p2'};
  return googleBase(url);
 });
 const records=await pim.syncAccount(user,'account');assert.equal(records.length,4);assert.ok(records.batchId);assert.equal(pim.status(user,'account').lastSync,null);
 assert.equal(calls.find(c=>new URL(c.url).searchParams.get('pageToken')==='next').url.includes('showDeleted=true'),true);
 const before=calls.length;assert.deepEqual(await pim.syncAccount(user,'account'),records);assert.equal(calls.length,before);
 assert.throws(()=>pim.acknowledgeSync(user,'account','wrong'),/different/);pim.acknowledgeSync(user,'account',records.batchId);
 assert.ok(pim.status(user,'account').lastSync);assert.equal(pim.status(user,'account').collections.length,2);db.close();
});
test('unacknowledged encrypted batches survive a database restart without another remote request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'avenor-pim-')),path=join(dir,'db.sqlite');
 try{let fixture=setup('google',url=>googleBase(url),new DatabaseSync(path));const first=await fixture.pim.syncAccount(user,'account');fixture.db.close();
 fixture=setup('google',()=>{throw Error('must not fetch');},new DatabaseSync(path));const replay=await fixture.pim.syncAccount(user,'account');assert.equal(replay.batchId,first.batchId);assert.deepEqual(replay,first);fixture.pim.acknowledgeSync(user,'account',replay.batchId);assert.equal(fixture.pim.status(user,'account').pendingBatch,false);fixture.db.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('expired Google Calendar and People tokens perform full reconciliation including deleted records',async()=>{
 let pass=0;const {pim,db}=setup('google',url=>{
  if(pass&&url.searchParams.has('syncToken'))throw Object.assign(Error('Expired'),{providerStatus:410});
  return googleBase(url,pass?{events:{items:[gEvent('new')],nextSyncToken:'new-events'},contacts:{connections:[],nextSyncToken:'new-people'}}:{});
 });
 const first=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',first.batchId);pass++;
 const second=await pim.syncAccount(user,'account');assert.equal(second.filter(r=>r.deleted).length,2);assert.ok(second.some(r=>r.providerId==='new'&&!r.deleted));pim.acknowledgeSync(user,'account',second.batchId);db.close();
});
test('incremental Google deletion and cancelled recurring exceptions preserve distinct identities',async()=>{
 let pass=0;const {pim,db}=setup('google',url=>googleBase(url,pass?{events:{items:[{id:'event-a',status:'cancelled'},gEvent('exception',{status:'cancelled',recurringEventId:'master'})]},contacts:{connections:[gContact('a',{metadata:{deleted:true}})]}}:{}));
 const first=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',first.batchId);pass++;
 const second=await pim.syncAccount(user,'account');assert.equal(second.filter(r=>r.deleted).length,2);const exception=second.find(r=>r.providerId==='exception');assert.equal(exception.cancelled,true);assert.equal(exception.seriesMasterId,'master');assert.equal(exception.deleted,undefined);db.close();
});
test('a failed final page does not advance any cursor or delete previously synced records',async()=>{
 let pass=0;const {pim,db}=setup('google',url=>{
  if(pass&&url.pathname.endsWith('/events')){if(url.searchParams.has('pageToken'))throw Object.assign(Error('Provider down'),{providerStatus:503});return {items:[],nextPageToken:'bad'};}
  return googleBase(url);
 });const first=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',first.batchId);const before=db.prepare('SELECT encrypted_state FROM provider_pim_state').get().encrypted_state;pass++;
 await assert.rejects(pim.syncAccount(user,'account'),/Provider down/);assert.equal(db.prepare('SELECT encrypted_state FROM provider_pim_state').get().encrypted_state,before);assert.equal(pim.status(user,'account').pendingBatch,false);db.close();
});
test('Microsoft primary delta gates complete master reconciliation; expired cursor forces a safe full sync',async()=>{
 let pass=0;const {pim,db,calls}=setup('microsoft',url=>{
  if(url.pathname.endsWith('/calendarView/delta')&&url.searchParams.has('delta')){if(pass===2)throw Object.assign(Error('Expired'),{providerStatus:410});return {value:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/calendarView/delta?delta=two'};}
  return graphBase(url,pass===2?{events:{value:[]}}:{});
 });let batch=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',batch.batchId);pass=1;const count=calls.filter(c=>new URL(c.url).pathname.endsWith('/events')).length;
 batch=await pim.syncAccount(user,'account');assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/events')).length,count);pim.acknowledgeSync(user,'account',batch.batchId);pass=2;
 batch=await pim.syncAccount(user,'account');assert.ok(batch.some(r=>r.deleted&&r.providerId==='event'));assert.equal(calls.some(c=>c.init.headers.Prefer.includes('ImmutableId')),true);db.close();
});
test('Microsoft contact child folders use delta pages and folder removals produce tombstones',async()=>{
 let pass=0;const {pim,db}=setup('microsoft',url=>{
  if(url.pathname.endsWith('/contactFolders'))return {value:pass===2?[]:[{id:'folder',displayName:'Clients',childFolderCount:0}]};
  if(url.pathname.endsWith('/contacts/delta'))return {value:pass?[{id:'contact','@removed':{reason:'deleted'}}]:[{id:'contact',displayName:'Client','@odata.etag':'"1"'}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/contactFolders/folder/contacts/delta?delta=yes'};
  return graphBase(url);
 });let batch=await pim.syncAccount(user,'account');assert.ok(batch.some(r=>r.name==='Client'));pim.acknowledgeSync(user,'account',batch.batchId);pass=1;
 batch=await pim.syncAccount(user,'account');assert.ok(batch.some(r=>r.kind==='contact'&&r.deleted));pim.acknowledgeSync(user,'account',batch.batchId);pass=2;batch=await pim.syncAccount(user,'account');assert.equal(batch.collections.some(c=>c.id==='folder'),false);db.close();
});
test('normalization retains recurrence, timezone, all-day boundaries and contact multivalue data',()=>{
 const g=normalizeEvent('google',gEvent('e',{recurrence:['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8'],attendees:[{email:'a@example.com',responseStatus:'accepted',optional:true}]}),{id:'c'});
 assert.equal(g.repeat,'weekly');assert.equal(g.timezone,'Europe/Warsaw');assert.equal(g.attendeeDetails[0].response,'accepted');assert.equal(eventWriteBody('google',g).recurrence[0],'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8');
 const allDay=normalizeEvent('google',gEvent('a',{start:{date:'2026-10-01'},end:{date:'2026-10-03'}}),{id:'c',timezone:'UTC'});assert.equal(eventWriteBody('google',allDay).end.date,'2026-10-03');
 const c=normalizeContact('google',gContact('p',{phoneNumbers:[{value:'111',type:'work'},{value:'222',type:'home'}]}));const output=contactWriteBody('google',{...c,phone:'333'});assert.deepEqual(output.phoneNumbers,[{value:'333',type:'work'},{value:'222',type:'home'}]);assert.equal(output.metadata.sources[0].etag,'source1');
});
test('Google event create is idempotent with a stable provider ID and preserves accepted results across replay',async()=>{
 let submissions=0;const {pim,db}=setup('google',(url,init)=>{if(init.method==='POST'){submissions++;const body=JSON.parse(init.body);assert.match(body.id,/^[0-9a-f]{64}$/);assert.equal(url.searchParams.get('sendUpdates'),'all');return {...body,etag:'"new"'};}return googleBase(url);});
 const input={user,accountId:'account',kind:'event',method:'create',record:{title:'New meeting',start:'2026-09-15T10:00:00Z',end:'2026-09-15T11:00:00Z',timezone:'Europe/Warsaw',repeat:'none',attendees:'a@example.com'},idempotencyKey:'new-event-123'};
 const first=await pim.writeRecord(input);assert.equal(first.title,'New meeting');assert.deepEqual(await pim.writeRecord(input),first);assert.equal(submissions,1);
 await assert.rejects(pim.writeRecord({...input,record:{...input.record,title:'Changed'}}),e=>e.code==='pim_idempotency_mismatch');db.close();
});
test('conditional writes carry provider etags and map stale versions to conflicts',async()=>{
 const {pim,db}=setup('google',(url,init)=>{assert.equal(init.headers['If-Match'],'"v1"');throw Object.assign(Error('Precondition'),{providerStatus:412});});
 const record=normalizeEvent('google',gEvent(),{id:'calendar'});
 await assert.rejects(pim.writeRecord({user,accountId:'account',kind:'event',record,method:'update',idempotencyKey:'update-event-1'}),e=>e.status===409&&e.code==='pim_version_conflict');assert.equal(db.prepare('SELECT status FROM provider_pim_writes').get().status,'rejected');db.close();
});
test('transport uncertainty never repeats a non-idempotent contact create',async()=>{
 let submissions=0;const {pim,db}=setup('google',()=>{submissions++;throw Object.assign(Error('Timed out'),{status:502});});
 const input={user,accountId:'account',kind:'contact',method:'create',record:{name:'Chris',email:'chris@example.com'},idempotencyKey:'contact-create-1'};
 await assert.rejects(pim.writeRecord(input),e=>e.uncertain===true);await assert.rejects(pim.writeRecord(input),e=>e.code==='pim_write_uncertain');assert.equal(submissions,1);db.close();
});
test('Google contact updates carry source etags and field masks while read-only calendars reject writes',async()=>{
 const {pim,db}=setup('google',(url,init)=>{assert.ok(url.pathname.endsWith(':updateContact'));assert.equal(JSON.parse(init.body).metadata.sources[0].etag,'source1');assert.ok(url.searchParams.get('updatePersonFields').includes('names'));return gContact('a',{etag:'new'});});
 const record=normalizeContact('google',gContact());const result=await pim.writeRecord({user,accountId:'account',kind:'contact',record,method:'update',idempotencyKey:'contact-update-1'});assert.equal(result.etag,'new');
 const state=pim.readState({id:'account',owner:'owner'});assert.equal(state.known[result.id].providerId,'people/a');db.close();
});
test('an active database lease blocks a second engine instance and prevents concurrent cursors',async()=>{
 const {pim,db,providers}=setup('google',url=>googleBase(url));const second=new PimService({db,providers,env,now:()=>Date.UTC(2026,8,12)});second.migrate();const account=providers.account(user,'account');pim.lock(account);
 await assert.rejects(second.syncAccount(user,'account'),e=>e.code==='pim_busy');pim.unlock(account);const batch=await second.syncAccount(user,'account');assert.equal(batch.length,2);db.close();
});
test('stable IDs distinguish event copies across calendars but survive contact folder moves',()=>{
 assert.notEqual(pimRecordId('a','event','one','same'),pimRecordId('a','event','two','same'));
 assert.equal(pimRecordId('a','contact','one','same'),pimRecordId('a','contact','two','same'));
});
test('published local IDs are reused by sync, and People propagation cannot silently overwrite an accepted edit',async()=>{
 let remote=gContact('a'),clock=Date.UTC(2026,8,12);
 const {pim,db}=setup('google',(url,init)=>init.method==='PATCH'?gContact('a',{etag:'"accepted"',names:[{displayName:'Saved name',givenName:'Saved name'}]}):googleBase(url,{contacts:{connections:[remote]}}));pim.now=()=>clock;
 const record={...normalizeContact('google',gContact()),id:'existing-local-contact',name:'Saved name'};
 const accepted=await pim.writeRecord({user,accountId:'account',kind:'contact',record,method:'update',idempotencyKey:'publish-existing-1'});
 let batch=await pim.syncAccount(user,'account');assert.equal(batch.find(r=>r.kind==='contact').id,'existing-local-contact');assert.equal(batch.find(r=>r.kind==='contact').name,'Saved name');pim.acknowledgeSync(user,'account',batch.batchId);
 assert.equal(pim.status(user,'account').pendingWrites,1);clock+=180000;
 batch=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',batch.batchId);assert.equal(pim.status(user,'account').conflicts.length,1);
 remote={...remote,etag:accepted.etag,names:[{displayName:'Saved name'}]};
 batch=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',batch.batchId);assert.equal(pim.status(user,'account').pendingWrites,0);assert.equal(pim.status(user,'account').conflicts.length,0);db.close();
});
test('a newer provider version can be explicitly selected when write propagation becomes a conflict',async()=>{
 let clock=Date.UTC(2026,8,12);const {pim,db}=setup('google',(url,init)=>init.method==='PATCH'?gContact('a',{etag:'accepted'}):googleBase(url));pim.now=()=>clock;
 await pim.writeRecord({user,accountId:'account',kind:'contact',record:normalizeContact('google',gContact()),method:'update',idempotencyKey:'conflict-contact-1'});clock+=180000;
 const batch=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',batch.batchId);const conflict=pim.status(user,'account').conflicts[0];assert.ok(conflict);
 await assert.rejects(pim.resolveConflict({user,accountId:'account',recordId:conflict.id,resolution:'remote',idempotencyKey:'stale-review-1',expectedRemoteEtag:'old'}),e=>e.code==='pim_review_changed');
 const resolved=await pim.resolveConflict({user,accountId:'account',recordId:conflict.id,resolution:'remote',idempotencyKey:'resolve-remote-1',expectedRemoteEtag:conflict.remoteVersion});assert.equal(resolved.etag,'"person1"');assert.deepEqual(await pim.resolveConflict({user,accountId:'account',recordId:conflict.id,resolution:'remote',idempotencyKey:'resolve-remote-1',expectedRemoteEtag:conflict.remoteVersion}),resolved);assert.equal(pim.status(user,'account').pendingWrites,0);db.close();
});
test('all-day Google dates retain calendar-local midnight across both sides of UTC and DST',()=>{
 for(const zone of ['America/Los_Angeles','Europe/Warsaw','Asia/Tokyo']){
  const event=normalizeEvent('google',gEvent('all',{start:{date:'2026-03-28'},end:{date:'2026-03-30'}}),{id:'c',timezone:zone});
  const body=eventWriteBody('google',event);assert.equal(body.start.date,'2026-03-28',zone);assert.equal(body.end.date,'2026-03-30',zone);
 }
 const graph=normalizeEvent('microsoft',{id:'a',subject:'Trip',isAllDay:true,start:{dateTime:'2026-09-12T07:00:00',timeZone:'UTC'},end:{dateTime:'2026-09-13T07:00:00',timeZone:'UTC'},originalStartTimeZone:'Pacific Standard Time'});
 assert.deepEqual(eventWriteBody('microsoft',graph).start,graph.providerRaw.start);
});
test('Microsoft series reconciliation imports full exception objects and canceled occurrence identifiers',async()=>{
 const {pim,db}=setup('microsoft',url=>{
  if(url.pathname.endsWith('/events'))return {value:[{id:'master',type:'seriesMaster',subject:'Weekly',start:{dateTime:'2026-09-12T09:00:00',timeZone:'UTC'},end:{dateTime:'2026-09-12T10:00:00',timeZone:'UTC'},recurrence:{pattern:{type:'weekly'},range:{type:'noEnd',startDate:'2026-09-12'}}}]};
  if(url.pathname.endsWith('/events/master'))return {id:'master',cancelledOccurrences:['OID.master.2026-09-19'],exceptionOccurrences:[{id:'special',occurrenceId:'OID.master.2026-09-26'}]};
  if(url.pathname.endsWith('/events/special'))return {id:'special',subject:'Moved meeting',type:'exception',originalStart:'2026-09-26T09:00:00Z',start:{dateTime:'2026-09-27T11:00:00',timeZone:'UTC'},end:{dateTime:'2026-09-27T12:00:00',timeZone:'UTC'}};
  return graphBase(url);
 });const batch=await pim.syncAccount(user,'account');assert.deepEqual(batch.find(e=>e.providerId==='master').exclusionDates,['2026-09-19']);assert.equal(batch.find(e=>e.providerId==='special').seriesMasterId,'master');assert.equal(batch.find(e=>e.providerId==='special').originalStart,'2026-09-26T09:00:00Z');db.close();
});

test('a stale final sync response cannot replace a successor batch, cursor, or lease',async()=>{
 let release,started;const ready=new Promise(resolve=>{started=resolve;});
 const {pim,db}=setup('google',async url=>{if(url.pathname.endsWith('/connections')){started();return new Promise(resolve=>{release=()=>resolve(googleBase(url));});}return googleBase(url);});
 const first=pim.syncAccount(user,'account');const rejected=assert.rejects(first,e=>e.code==='pim_lease_lost');await ready;
 db.prepare('UPDATE provider_pim_locks SET expires_at=0 WHERE account_id=?').run('account');
 const successor=setup('google',url=>googleBase(url,{events:{items:[gEvent('successor')]}}),db);
 const next=await successor.pim.syncAccount(user,'account');successor.pim.acknowledgeSync(user,'account',next.batchId);
 const snapshot=db.prepare('SELECT encrypted_state FROM provider_pim_state').get().encrypted_state;
 const lease=successor.pim.lock(successor.providers.account(user,'account'));
 release();await rejected;
 assert.equal(db.prepare('SELECT encrypted_state FROM provider_pim_state').get().encrypted_state,snapshot);
 assert.equal(db.prepare('SELECT holder FROM provider_pim_locks').get().holder,lease.token);
 assert.equal(db.prepare('SELECT count(*) AS n FROM provider_pim_batches').get().n,0);
 successor.pim.unlock(successor.providers.account(user,'account'),lease);db.close();
});

test('a stale accepted write cannot persist data or alter successor receipts and remains uncertain',async()=>{
 let release,started;const ready=new Promise(resolve=>{started=resolve;});
 const {pim,db}=setup('google',async()=>{started();return new Promise(resolve=>{release=()=>resolve(gContact('first',{etag:'first-accepted'}));});});
 const input={user,accountId:'account',kind:'contact',method:'create',record:{name:'First'},idempotencyKey:'stale-write-first'};
 const first=pim.writeRecord(input),rejected=assert.rejects(first,e=>e.code==='pim_lease_lost'&&e.uncertain===true);await ready;
 db.prepare('UPDATE provider_pim_locks SET expires_at=0').run();
 const successor=setup('google',()=>gContact('second',{etag:'second-accepted'}),db);
 const accepted=await successor.pim.writeRecord({...input,record:{name:'Second'},idempotencyKey:'successor-write-second'});
 const snapshot=db.prepare('SELECT encrypted_state FROM provider_pim_state').get().encrypted_state;
 const lease=successor.pim.lock(successor.providers.account(user,'account'));
 release();await rejected;
 assert.equal(db.prepare('SELECT encrypted_state FROM provider_pim_state').get().encrypted_state,snapshot);
 assert.equal(db.prepare('SELECT status FROM provider_pim_writes WHERE idempotency_key=?').get('stale-write-first').status,'submitting');
 assert.equal(db.prepare('SELECT status FROM provider_pim_writes WHERE idempotency_key=?').get('successor-write-second').status,'accepted');
 assert.equal(successor.pim.readState(successor.providers.account(user,'account')).known[accepted.id].providerId,'people/second');
 assert.equal(db.prepare('SELECT holder FROM provider_pim_locks').get().holder,lease.token);
 successor.pim.unlock(successor.providers.account(user,'account'),lease);db.close();
});

test('expired ownership cannot renew itself, including overlapping operations from one service instance',async()=>{
 let release,started,first=true;const ready=new Promise(resolve=>{started=resolve;});
 const {pim,db,providers}=setup('google',async url=>{if(first&&url.pathname.endsWith('/connections')){first=false;started();return new Promise(resolve=>{release=()=>resolve(googleBase(url));});}return googleBase(url);});
 const pending=pim.syncAccount(user,'account'),rejected=assert.rejects(pending,e=>e.code==='pim_lease_lost');await ready;
 const old=db.prepare('SELECT holder FROM provider_pim_locks').get().holder;
 db.prepare('UPDATE provider_pim_locks SET expires_at=0').run();
 const successor=await pim.syncAccount(user,'account');pim.acknowledgeSync(user,'account',successor.batchId);
 const lease=pim.lock(providers.account(user,'account'));assert.notEqual(lease.token,old);release();await rejected;
 assert.equal(db.prepare('SELECT holder FROM provider_pim_locks').get().holder,lease.token);
 db.prepare('UPDATE provider_pim_locks SET expires_at=0').run();
 await assert.rejects(pim.request(user,providers.account(user,'account'),'https://people.googleapis.com/v1/people/me/connections'),e=>e.code==='pim_lease_lost');
 assert.equal(db.prepare('SELECT expires_at FROM provider_pim_locks').get().expires_at,0);pim.unlock(providers.account(user,'account'),lease);db.close();
});

test('a final response that outlives the lease cannot persist even without a successor',async()=>{
 let release,started;const ready=new Promise(resolve=>{started=resolve;});
 const {pim,db}=setup('google',async url=>{if(url.pathname.endsWith('/connections')){started();return new Promise(resolve=>{release=()=>resolve(googleBase(url));});}return googleBase(url);});
 const pending=pim.syncAccount(user,'account'),rejected=assert.rejects(pending,e=>e.code==='pim_lease_lost');await ready;
 db.prepare('UPDATE provider_pim_locks SET expires_at=0').run();release();await rejected;
 assert.equal(db.prepare('SELECT count(*) AS n FROM provider_pim_batches').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM provider_pim_state').get().n,0);db.close();
});
