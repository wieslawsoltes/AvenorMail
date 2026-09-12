import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../backend/storage.js';
import {DurableScheduler} from '../backend/jobs.js';
import {installMailWriteback} from '../backend/mail-sync.js';
import {createApplication} from '../backend/server.js';

const OWNER = {userId:'mail-owner', email:'owner@example.com', displayName:'Mailbox Owner'};
const imported = patch => ({accountId:'mail-account', providerId:'INBOX:77:42', providerSyncStamp:'initial-import', folder:'inbox', read:false, flagged:false, from:'sender@example.net', to:OWNER.email, date:'2026-09-12T10:00:00Z', subject:'Imported message', body:'Message content', attachments:[], ...patch});

function fixture(t, {persistent = false, apply} = {}) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'avenor-writeback-')) : null;
  const path = directory ? join(directory, 'mail.sqlite') : ':memory:';
  let time = Date.now(), enabled = true, db = openDatabase(path), scheduler, writeback;
  const calls = [], events = [];
  const providers = {async updateMessage(user, accountId, providerId, patch, options) {
    const call = {user, accountId, providerId, patch:structuredClone(patch), options}; calls.push(call);
    return apply ? apply(call, calls.length) : {status:'applied', providerId};
  }};
  const auth = {user(id) {return enabled && id===OWNER.userId ? OWNER : null;}};
  const emit = (...args) => events.push(args);
  const install = () => { scheduler = new DurableScheduler({db, now:() => time}).migrate(); writeback = installMailWriteback({db, scheduler, providers, auth, emit}); };
  install();
  t.after(() => {scheduler.stop(); db.close(); if (directory) rmSync(directory, {recursive:true,force:true});});
  return {
    get db() {return db;}, get scheduler() {return scheduler;}, get writeback() {return writeback;}, calls, events, providers,
    disable() {enabled = false;}, advance(ms = 1000) {time += ms;},
    reinstall() {writeback=installMailWriteback({db,scheduler,providers,auth,emit});},
    restart() {scheduler.stop(); db.close(); db=openDatabase(path); install();},
    record(id = 'message-1', data = {}, {kind='message', owner=OWNER.userId, scope='user:'+OWNER.userId} = {}) {
      db.prepare('INSERT INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES(?,?,?,?,?,1,?,0)').run(id,owner,scope,kind,JSON.stringify(imported(data)),time);
    },
    read(id = 'message-1') {const row=db.prepare('SELECT * FROM records WHERE id=?').get(id); return row ? {...JSON.parse(row.data),id:row.id,version:row.version,deleted:row.deleted} : null;},
    update(patch, {id='message-1', deleted} = {}) {
      const row=db.prepare('SELECT * FROM records WHERE id=?').get(id); time++;
      db.prepare('UPDATE records SET data=?,version=version+1,updated=?,deleted=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),...patch}),time,deleted===undefined?row.deleted:deleted,id);
    },
    jobs() {return db.prepare("SELECT rowid,* FROM jobs WHERE type='provider_mutation' ORDER BY rowid").all().map(row => ({...row,payload:JSON.parse(row.payload)}));},
  };
}

test('local read, flag and folder changes enqueue one minimal durable provider patch', t => {
  const f=fixture(t); f.record();
  assert.equal(f.jobs().length,0,'provider inserts do not write back');
  f.update({read:true,flagged:true,folder:'archive',subject:'Local label'});
  const [job]=f.jobs(); assert.equal(f.jobs().length,1);
  assert.equal(job.type,'provider_mutation'); assert.equal(job.owner,OWNER.userId); assert.equal(job.scope,'user:'+OWNER.userId);
  assert.deepEqual(job.payload,{recordId:'message-1',accountId:'mail-account',patch:{read:true,flagged:true,folder:'archive'}});
  assert.equal(job.status,'pending'); assert.ok(job.id.startsWith('provider-update:'));
});

test('writeback trigger is idempotently installed and ignores sync stamps, unchanged fields and non-provider records', t => {
  const f=fixture(t); f.reinstall(); f.record();
  f.update({subject:'Metadata edit'}); assert.equal(f.jobs().length,0);
  f.update({read:true,folder:'archive',providerSyncStamp:f.writeback.stamp()}); assert.equal(f.jobs().length,0);
  f.update({read:false}); assert.equal(f.jobs().length,1);
  f.record('local-mail',{accountId:null,providerId:null}); f.update({flagged:true},{id:'local-mail'});
  f.record('ordinary-task',{}, {kind:'task'}); f.update({read:true},{id:'ordinary-task'});
  assert.equal(f.jobs().length,1);
});

test('record and queued provider mutation commit or roll back together', t => {
  const f=fixture(t); f.record();
  f.db.exec('BEGIN IMMEDIATE'); f.update({read:true}); assert.equal(f.jobs().length,1); f.db.exec('ROLLBACK');
  assert.equal(f.read().read,false); assert.equal(f.jobs().length,0);
  f.db.exec('BEGIN IMMEDIATE'); f.update({flagged:true}); f.db.exec('COMMIT');
  assert.equal(f.read().flagged,true); assert.deepEqual(f.jobs()[0].payload.patch,{flagged:true});
});

test('soft-deleting an imported record queues a move to provider trash', t => {
  const f=fixture(t); f.record(); f.update({}, {deleted:1});
  assert.equal(f.read().deleted,1); assert.deepEqual(f.jobs()[0].payload.patch,{folder:'deleted'});
});

test('queued provider edits survive process restart and execute once', async t => {
  const f=fixture(t,{persistent:true}); f.record(); f.update({read:true}); const id=f.jobs()[0].id;
  f.restart(); await f.scheduler.runDue(); await f.scheduler.runDue();
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].options.idempotencyKey,id);
  assert.equal(f.jobs()[0].status,'completed'); assert.equal(f.jobs().length,1);
});

test('pending overlays preserve local intent in order and exclude completed or cancelled changes', t => {
  const f=fixture(t); f.record(); f.update({read:true,folder:'archive'}); f.update({read:false,flagged:true});
  const remote=imported({read:true,flagged:false,folder:'inbox',subject:'Fresh server subject'});
  const preserved=f.writeback.preservePending('message-1',remote);
  assert.equal(preserved.read,false); assert.equal(preserved.flagged,true); assert.equal(preserved.folder,'archive'); assert.equal(preserved.subject,'Fresh server subject');
  const jobs=f.jobs(); f.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobs[0].id); f.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(jobs[1].id);
  assert.deepEqual(f.writeback.preservePending('message-1',{read:true,flagged:false,folder:'inbox'}),{read:true,flagged:false,folder:'inbox'});
});

test('unknown and failed edits continue protecting local fields from stale provider sync', t => {
  const f=fixture(t); f.record(); f.update({read:true}); f.update({folder:'archive'});
  const jobs=f.jobs(); f.db.prepare("UPDATE jobs SET status='unknown' WHERE id=?").run(jobs[0].id); f.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(jobs[1].id);
  assert.deepEqual(f.writeback.preservePending('message-1',{read:false,folder:'inbox'}),{read:true,folder:'archive'});
});

test('confirmed provider MOVE updates the stored identity without generating a writeback loop', async t => {
  const f=fixture(t,{apply:async()=>({status:'applied',providerId:'Archive:91:7'})}); f.record(); f.update({folder:'archive'});
  const before=f.read(); await f.scheduler.runDue();
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].providerId,'INBOX:77:42'); assert.deepEqual(f.calls[0].patch,{folder:'archive'});
  assert.equal(f.read().providerId,'Archive:91:7'); assert.notEqual(f.read().providerSyncStamp,before.providerSyncStamp);
  assert.equal(f.jobs().length,1); assert.equal(f.jobs()[0].status,'completed');
  assert.ok(f.events.some(([scope,event])=>scope==='user:'+OWNER.userId&&event.recordId==='message-1'));
});

test('edits queued during an in-flight MOVE retain local changes and use the returned provider identity', {timeout:10000}, async t => {
  let enter,release; const entered=new Promise(resolve=>{enter=resolve;}), held=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{apply:async(call,index)=>{if(index===1){enter();await held;}return {status:'applied',providerId:'Archive:91:7'};}});
  f.record(); f.update({folder:'archive'}); const running=f.scheduler.runDue(); await entered;
  f.update({read:true,subject:'Edited while moving'}); release(); await running; f.advance(); await f.scheduler.runDue();
  assert.equal(f.calls.length,2); assert.equal(f.calls[0].providerId,'INBOX:77:42'); assert.equal(f.calls[1].providerId,'Archive:91:7');
  assert.deepEqual(f.calls[1].patch,{read:true}); assert.equal(f.read().read,true); assert.equal(f.read().subject,'Edited while moving');
  assert.ok(f.jobs().every(job=>job.status==='completed')); assert.equal(f.jobs().length,2);
});

test('an earlier unconfirmed mutation blocks later updates to the same message', async t => {
  const f=fixture(t,{apply:async()=>({status:'unknown'})}); f.record(); f.update({read:true}); f.update({flagged:true});
  await f.scheduler.runDue(); f.advance(2000); await f.scheduler.runDue();
  assert.equal(f.calls.length,1); assert.deepEqual(f.calls[0].patch,{read:true});
  const jobs=f.jobs(); assert.equal(jobs[0].status,'unknown'); assert.equal(jobs[1].status,'pending'); assert.match(jobs[1].error,/earlier update/);
  assert.equal(f.read().read,true); assert.equal(f.read().flagged,true);
});

test('disabled owners cannot apply queued provider mutations', async t => {
  const f=fixture(t); f.record(); f.update({read:true}); f.disable(); await f.scheduler.runDue();
  assert.equal(f.calls.length,0); assert.equal(f.jobs()[0].status,'failed'); assert.match(f.jobs()[0].error,/disabled/);
});

test('background inbox rules write their changes back through the same durable queue', async t => {
  const f=fixture(t); f.record(); f.record('archive-rule',{title:'Archive this sender',field:'from',contains:'sender@example.net',target:'archive'},{kind:'rule'});
  await f.scheduler.runDue();
  assert.equal(f.read().folder,'archive'); assert.equal(f.calls.length,1); assert.deepEqual(f.calls[0].patch,{folder:'archive'});
  assert.equal(f.jobs()[0].status,'completed');
});

test('background snooze return queues a provider move back to inbox', async t => {
  const f=fixture(t); f.record('message-1',{folder:'archive',snoozedUntil:new Date(Date.now()-60000).toISOString()});
  await f.scheduler.runDue();
  assert.equal(f.read().folder,'inbox'); assert.equal(f.calls.length,1); assert.deepEqual(f.calls[0].patch,{folder:'inbox'});
  assert.equal(f.jobs()[0].status,'completed');
});

async function applicationFixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'avenor-sync-app-')),db=openDatabase(':memory:'),calls=[],acks=[];
  let incoming=[{id:'provider-message',...imported()}];
  const providers={
    migrate(){}, async listAccounts(user){return user.userId===OWNER.userId?[{id:'mail-account',owner:OWNER.userId,email:OWNER.email,provider:'google'}]:[];},
    async syncAccount(user,accountId){assert.equal(user.userId,OWNER.userId);assert.equal(accountId,'mail-account');const rows=structuredClone(incoming);rows.batchId='sync-batch';return rows;},
    async acknowledgeSync(user,accountId,batchId){acks.push({user,accountId,batchId});},
    async updateMessage(user,accountId,providerId,patch,options){calls.push({user,accountId,providerId,patch,options});return {status:'applied',providerId};},
    async handle(){return null;},
  };
  const app=await createApplication({db,providers,bootstrap:false,env:{DATA_DIR:directory,DATA_KEY:Buffer.alloc(32,8).toString('base64'),PUBLIC_URL:'https://avenor.example',FRONTEND_URL:'https://avenor.example',SEED_SAMPLE_DATA:'false'}});
  db.prepare('INSERT INTO users(id,email,name,created) VALUES(?,?,?,?)').run(OWNER.userId,OWNER.email,OWNER.displayName,Date.now());
  db.prepare('INSERT INTO auth_accounts(user_id,email,role) VALUES(?,?,?)').run(OWNER.userId,OWNER.email,'admin');
  const session=app.auth.session(OWNER);
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const request=async(path,method='GET',body)=>{const result=await app.handle(new Request('https://avenor.example/api/'+path,{method,headers:{authorization:'Bearer '+session.token,'content-type':'application/json',origin:'https://avenor.example'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:result.status,data:await result.json()};};
  return {app,db,calls,acks,request,setIncoming(value){incoming=value;},read(){const row=db.prepare("SELECT * FROM records WHERE id='provider-message'").get();return row?{...JSON.parse(row.data),id:row.id,version:row.version,deleted:row.deleted}:null;},jobs(){return db.prepare("SELECT * FROM jobs WHERE type='provider_mutation' ORDER BY rowid").all();}};
}

test('assembled backend imports without loops, queues local API edits, and preserves pending fields through stale sync', async t => {
  const f=await applicationFixture(t);
  assert.equal((await f.request('accounts/mail-account/sync','POST',{})).status,200); assert.equal(f.jobs().length,0);
  const first=f.read(); assert.ok(first.providerSyncStamp);
  assert.equal((await f.request('record','PATCH',{id:first.id,version:first.version,patch:{read:true,flagged:true,folder:'archive'}})).status,200);
  assert.equal(f.jobs().length,1);
  f.setIncoming([{id:'provider-message',...imported({subject:'Refreshed subject'})}]);
  assert.equal((await f.request('accounts/mail-account/sync','POST',{})).status,200);
  const refreshed=f.read(); assert.equal(refreshed.read,true); assert.equal(refreshed.flagged,true); assert.equal(refreshed.folder,'archive'); assert.equal(refreshed.subject,'Refreshed subject');
  assert.notEqual(refreshed.providerSyncStamp,first.providerSyncStamp); assert.equal(f.jobs().length,1); assert.equal(f.acks.length,2);
  await f.app.scheduler.runDue(); assert.equal(f.calls.length,1); assert.equal(f.jobs()[0].status,'completed'); assert.equal(f.jobs().length,1);
});

test('stale provider sync cannot resurrect a locally deleted message while deletion writeback is pending', async t => {
  const f=await applicationFixture(t); await f.request('accounts/mail-account/sync','POST',{});
  const record=f.read(); assert.equal((await f.request('record','DELETE',{id:record.id,version:record.version})).status,200);
  assert.equal(f.read().deleted,1); assert.equal(f.jobs().length,1);
  await f.request('accounts/mail-account/sync','POST',{});
  assert.equal(f.read().deleted,1,'the local deletion remains effective until its provider operation is resolved');
  assert.equal(f.jobs().length,1,'server import does not echo the deletion back as another mutation');
});

test('provider-originated deletion does not enqueue a second delete operation', async t => {
  const f=await applicationFixture(t); await f.request('accounts/mail-account/sync','POST',{});
  f.setIncoming([{id:'provider-message',deleted:true}]);
  assert.equal((await f.request('accounts/mail-account/sync','POST',{})).status,200);
  assert.equal(f.read().deleted,1); assert.equal(f.jobs().length,0);
});

test('client changes cannot forge the provider sync marker to suppress writeback', async t => {
  const f=await applicationFixture(t); await f.request('accounts/mail-account/sync','POST',{});
  const record=f.read();
  const result=await f.request('record','PATCH',{id:record.id,version:record.version,patch:{read:true,providerSyncStamp:'client-forged-marker'}});
  assert.ok([200,400,403].includes(result.status));
  if(result.status===200){
    assert.equal(f.read().providerSyncStamp,record.providerSyncStamp,'server-owned sync identity must remain unchanged');
    assert.equal(f.jobs().length,1,'the read change must queue provider writeback');
  }else{assert.equal(f.read().read,false);assert.equal(f.jobs().length,0);}
});
