import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ImapFlow } from 'imapflow';
import { reconcileImap, imapProviderId, updateImap } from '../backend/providers/mail-protocols.js';
import { ProviderService } from '../backend/providers/index.js';

const source = name => Buffer.from(`From: Sender <sender@example.com>\r\nTo: me@example.com\r\nSubject: ${name}\r\nMessage-ID: <${name}@example.com>\r\n\r\nContent ${name}`);
const message = (uid,name,flags=[]) => ({uid,source:source(name),flags:new Set(flags),size:source(name).length});
const mailbox = (messages, flags=[],validity='77') => ({messages:new Map(messages.map(m=>[m.uid,m])),flags:new Set(flags),validity});
function fakeClient(boxes) {
  const calls={fetched:[],selected:[]}; let path;
  const client={secureConnection:true,mailbox:null,
    async list(){return [...boxes].map(([path,box])=>({path,flags:box.flags}));},
    async getMailboxLock(value,options){path=value;calls.selected.push({path,options});const box=boxes.get(path);if(!box)throw new Error('Missing mailbox');this.mailbox={uidValidity:box.validity,exists:box.messages.size};return {release(){}};},
    async search(){return [...boxes.get(path).messages.keys()];},
    async fetchOne(uid,query){calls.fetched.push({path,uid,query});const m=boxes.get(path).messages.get(uid);if(!m)return false;return {...m,...(!query.source?{source:undefined}:{} )};},
  };return {client,calls};
}
async function drain(client,cursor=null,env={}){const changes=[];for(let i=0;i<100;i++){const result=await reconcileImap(client,cursor,env);cursor=result.cursor;changes.push(...result.messages);if(!result.more)return {messages:changes,cursor};}throw new Error('Cursor did not complete');}
const config={email:'me@example.com',smtp:{host:'8.8.8.8',password:'smtp-secret'},imap:{host:'8.8.8.8',password:'imap-secret'}};
const env={DATA_KEY:Buffer.alloc(32,7).toString('base64'),PROVIDER_SYNC_LIMIT:'2'};
const user={userId:'owner'};

test('IMAP imports every selectable standard/custom folder and excludes noselect',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one')])],['Sent Mail',mailbox([message(5,'sent')],['\\Sent'])],['Clients/Zażółć',mailbox([message(20,'client')])],['Parent',mailbox([],['\\Noselect'])]]);
  const {client,calls}=fakeClient(boxes);const result=await drain(client,null,{PROVIDER_SYNC_LIMIT:'1'});
  assert.equal(result.messages.length,3);assert.equal(result.messages.find(m=>m.subject==='sent').folder,'sent');
  const custom=result.messages.find(m=>m.subject==='client');assert.equal(custom.providerMailbox,'Clients/Zażółć');assert.ok(custom.folder.startsWith('imap:'));
  assert.ok(calls.selected.every(call=>call.options.readOnly));assert.ok(calls.selected.every(call=>call.path!=='Parent'));
  assert.equal(result.cursor.cycle,null);assert.equal(result.cursor.folders.length,3);
});

test('IMAP reconciles flag changes and expunges without downloading unchanged bodies',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one'),message(2,'two'),message(3,'three')])]]);
  const {client,calls}=fakeClient(boxes);const initial=await drain(client);calls.fetched=[];
  boxes.get('INBOX').messages.get(1).flags=new Set(['\\Seen','\\Flagged']);boxes.get('INBOX').messages.delete(2);
  const result=await drain(client,initial.cursor);
  assert.deepEqual(result.messages.map(m=>[m.providerId,m.deleted||false,m.metadataOnly||false]),[['imap:INBOX:77:1',false,true],['imap:INBOX:77:2',true,false]]);
  assert.equal(result.messages[0].read,true);assert.equal(result.messages[0].flagged,true);
  assert.ok(calls.fetched.every(call=>!call.query.source));
});

test('unique external move preserves prior location identity; identical live copies stay separate',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'same')])],['Archive',mailbox([],['\\Archive'])]]);const {client}=fakeClient(boxes);
  const initial=await drain(client);boxes.get('Archive').messages.set(9,message(9,'same'));
  const copied=await drain(client,initial.cursor);assert.equal(copied.messages.length,1);assert.equal(copied.messages[0].previousProviderId,undefined);
  boxes.get('INBOX').messages.delete(1);boxes.get('Archive').messages.set(10,message(10,'same'));
  const moved=await drain(client,copied.cursor,{PROVIDER_SYNC_LIMIT:'1'});
  assert.equal(moved.messages.length,1);assert.equal(moved.messages[0].previousProviderId,'imap:INBOX:77:1');assert.equal(moved.messages[0].deleted,undefined);
  assert.equal(Object.keys(moved.cursor.entries).length,2);
});

test('ambiguous identical removed messages are never collapsed to one record',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'same'),message(2,'same')])],['Archive',mailbox([],['\\Archive'])]]);const {client}=fakeClient(boxes);
  const initial=await drain(client);boxes.get('INBOX').messages.clear();boxes.get('Archive').messages.set(4,message(4,'same'));
  const result=await drain(client,initial.cursor,{PROVIDER_SYNC_LIMIT:'1'});
  assert.equal(result.messages.filter(m=>m.deleted).length,2);assert.equal(result.messages.find(m=>!m.deleted).previousProviderId,undefined);
});

test('UIDVALIDITY resets remove obsolete identifiers and preserve exact surviving content',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one'),message(2,'two')])]]);const {client}=fakeClient(boxes);
  const initial=await drain(client);boxes.set('INBOX',mailbox([message(5,'one')],[],'88'));
  const result=await drain(client,initial.cursor,{PROVIDER_SYNC_LIMIT:'1'});
  assert.equal(result.messages[0].providerId,'imap:INBOX:88:5');assert.equal(result.messages[0].previousProviderId,'imap:INBOX:77:1');
  assert.ok(result.messages.some(m=>m.providerId==='imap:INBOX:77:2'&&m.deleted));
});

test('resumable batches restart safely when a folder disappears mid-pass',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one'),message(2,'two')])],['Later',mailbox([message(3,'three')])]]);const {client}=fakeClient(boxes);
  const first=await reconcileImap(client,null,{PROVIDER_SYNC_LIMIT:'1'});assert.ok(first.more);boxes.delete('Later');
  const rest=await drain(client,first.cursor,{PROVIDER_SYNC_LIMIT:'1'});assert.ok(rest.cursor.completedAt);assert.equal(Object.keys(rest.cursor.entries).length,2);
});

test('message size failure never advances the input cursor past unimported content',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one'),message(2,'very-large-message')])]]);const {client}=fakeClient(boxes);
  const first=await reconcileImap(client,null,{PROVIDER_SYNC_LIMIT:'1'});const before=JSON.stringify(first.cursor);
  await assert.rejects(reconcileImap(client,first.cursor,{PROVIDER_MESSAGE_MAX_BYTES:'10'}),{code:'MAIL_MESSAGE_TOO_LARGE'});
  assert.equal(JSON.stringify(first.cursor),before);
  const result=await drain(client,JSON.parse(before));assert.equal(result.messages.length,1);assert.equal(result.messages[0].subject,'very-large-message');
});

test('failed membership listing preserves prior state; configured UID cap rejects entire snapshot',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one'),message(2,'two')])]]);const {client}=fakeClient(boxes);
  await assert.rejects(reconcileImap(client,null,{PROVIDER_IMAP_MAX_UIDS:'1'}),{code:'MAIL_UID_LIMIT'});
  const initial=await drain(client);const before=JSON.stringify(initial.cursor);client.search=async()=>false;
  await assert.rejects(reconcileImap(client,initial.cursor),{code:'MAIL_SYNC_FAILED'});assert.equal(JSON.stringify(initial.cursor),before);
});

test('provider batches and stable external MOVE aliases survive service restart until acknowledgment',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const boxes=new Map([['INBOX',mailbox([message(1,'one')])],['Archive',mailbox([],['\\Archive'])]]);
  const {client}=fakeClient(boxes);
  for(const key of ['list','getMailboxLock','search','fetchOne'])t.mock.method(ImapFlow.prototype,key,async function(...args){const result=await client[key](...args);this.mailbox=client.mailbox;return result;});
  t.mock.method(ImapFlow.prototype,'connect',async function(){this.secureConnection=true;});t.mock.method(ImapFlow.prototype,'close',()=>{});
  let service=new ProviderService({db,env});service.migrate();const account=await service.addSmtpAccount(user,config);
  const first=await service.syncAccount(user,account.id);assert.equal(first.length,1);service.acknowledgeSync(user,account.id,first.batchId);
  boxes.get('INBOX').messages.clear();boxes.get('Archive').messages.set(8,message(8,'one'));
  const moved=await service.syncAccount(user,account.id);assert.equal(moved.length,1);assert.equal(moved[0].id,first[0].id);
  assert.equal(moved[0].providerId,imapProviderId('Archive','77',8));
  service=new ProviderService({db,env});service.migrate();const replay=await service.syncAccount(user,account.id);assert.deepEqual(replay,moved);assert.equal(replay.batchId,moved.batchId);
  assert.throws(()=>service.acknowledgeSync(user,account.id,'wrong-id'),{status:409});service.acknowledgeSync(user,account.id,replay.batchId);
  assert.equal((await service.syncAccount(user,account.id)).length,0);
});

test('IMAP writes to an exact advertised custom folder and rejects missing folders',async t=>{
  let movedTo;
  t.mock.method(ImapFlow.prototype,'connect',async function(){this.secureConnection=true;this.capabilities=new Map([['MOVE',true],['UIDPLUS',true]]);this.mailbox={uidValidity:'77'};});
  t.mock.method(ImapFlow.prototype,'list',async()=>[{path:'INBOX',flags:new Set()},{path:'Projects/日本',flags:new Set()}]);
  t.mock.method(ImapFlow.prototype,'getMailboxLock',async()=>({release(){}}));t.mock.method(ImapFlow.prototype,'fetchOne',async uid=>({uid,flags:new Set()}));
  t.mock.method(ImapFlow.prototype,'messageMove',async(ids,path)=>{movedTo=path;return {uidValidity:'99',uidMap:new Map([[1,3]])};});t.mock.method(ImapFlow.prototype,'close',()=>{});
  const folder='imap:'+Buffer.from('Projects/日本').toString('base64url');const result=await updateImap(config,'imap:INBOX:77:1',{folder},{});
  assert.equal(movedTo,'Projects/日本');assert.equal(result.providerId,imapProviderId(movedTo,'99',3));
  await assert.rejects(updateImap(config,'imap:INBOX:77:1',{folder:'imap:'+Buffer.from('Missing').toString('base64url')},{}),{code:'MAIL_FOLDER_UNSUPPORTED'});
});

test('IMAP membership enumeration is itself durably paginated and never deletes on partial snapshot',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one')])],['Second',mailbox([message(2,'two')])],['Third',mailbox([message(3,'three')])]]);const {client,calls}=fakeClient(boxes);
  const initial=await drain(client);boxes.get('INBOX').messages.clear();calls.selected=[];
  const first=await reconcileImap(client,initial.cursor,{PROVIDER_IMAP_FOLDER_BATCH_LIMIT:'1'});
  assert.equal(first.messages.length,0);assert.equal(first.cursor.building.index,1);assert.equal(calls.selected.length,1);
  const second=await reconcileImap(client,JSON.parse(JSON.stringify(first.cursor)),{PROVIDER_IMAP_FOLDER_BATCH_LIMIT:'1'});
  assert.equal(second.messages.length,0);assert.equal(second.cursor.building.index,2);
  const done=await drain(client,second.cursor,{PROVIDER_IMAP_FOLDER_BATCH_LIMIT:'1'});
  assert.deepEqual(done.messages.map(m=>[m.providerId,m.deleted]),[['imap:INBOX:77:1',true]]);
});

test('IMAP retains complete system/custom flags and updates answered metadata',async()=>{
  const boxes=new Map([['INBOX',mailbox([message(1,'one',['custom-label'])])]]);const {client}=fakeClient(boxes);
  const first=await drain(client);assert.deepEqual(first.messages[0].providerFlags,['custom-label']);
  boxes.get('INBOX').messages.get(1).flags=new Set(['\\Answered','another-label']);
  const next=await drain(client,first.cursor);assert.equal(next.messages[0].answered,true);assert.deepEqual(next.messages[0].providerFlags,['\\Answered','another-label']);assert.equal(next.messages[0].metadataOnly,true);
});
