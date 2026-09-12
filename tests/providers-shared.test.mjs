import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { simpleParser } from 'mailparser';
import { ProviderService } from '../backend/providers/index.js';
import { seal } from '../backend/providers/security.js';

const user={userId:'alice'},other={userId:'bob'};
const env={DATA_KEY:Buffer.alloc(32,8).toString('base64'),PUBLIC_URL:'https://backend.example.com',FRONTEND_URL:'https://app.example.com',MICROSOFT_CLIENT_ID:'app-id',MICROSOFT_CLIENT_SECRET:'app-secret'};
const defaultScopes='Mail.ReadWrite Mail.Send Mail.ReadWrite.Shared Mail.Send.Shared User.ReadBasic.All';
const json=(data,status=200)=>new Response(data===null?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(t,{scopes=defaultScopes,fetchImpl=async()=>{throw new Error('Unexpected request');}}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const service=new ProviderService({db,env,fetchImpl});service.migrate();
  db.prepare('INSERT INTO provider_accounts(id,owner,provider,email,display_name,provider_user_id,encrypted_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('primary','alice','microsoft','alice@example.com','Alice','alice-ms',seal({accessToken:'access-secret',refreshToken:'refresh-secret',scope:scopes,expiresAt:Date.now()+3600000},env,'account:alice:primary:microsoft'),Date.now(),Date.now());
  return {db,service,request:(path,body,who=user)=>service.handle(new Request(env.PUBLIC_URL+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})}),who)};
}
function sharedFetch(extra=()=>json({error:'no access'},403)){
  return async(input,init)=>{const u=new URL(input);
    if(u.pathname==='/v1.0/users/team%40example.com')return json({id:'team-id',mail:'team@example.com',displayName:'Team inbox'});
    if(u.pathname==='/v1.0/users/team-id/mailFolders/inbox')return json({id:'inbox-id',displayName:'Inbox'});
    return extra(u,init);
  };
}

test('shared directory discovery is unavailable without directory scope and never queries a directory',async t=>{
  let calls=0;const {request}=fixture(t,{scopes:'Mail.ReadWrite.Shared',fetchImpl:async()=>{calls++;throw new Error('No network allowed');}});
  const result=await(await request('/api/accounts/primary/shared-mailboxes?q=team')).json();
  assert.equal(result.directorySearchAvailable,false);assert.deepEqual(result.mailboxes,[]);assert.equal(calls,0);
});

test('directory search returns only candidates whose inbox access is actually verified',async t=>{
  const seen=[];const {request}=fixture(t,{fetchImpl:async(input)=>{const u=new URL(input);seen.push(u);
    if(u.pathname==='/v1.0/users')return json({value:[{id:'team-id',mail:'team@example.com',displayName:'Team'},{id:'denied',mail:'denied@example.com'},{id:'alice-ms',mail:'alice@example.com'}],'@odata.nextLink':'https://graph.microsoft.com/v1.0/users?$skiptoken=more'});
    return u.pathname.includes('/team-id/')?json({id:'inbox-id'}):json({},403);
  }});
  const result=await(await request('/api/accounts/primary/shared-mailboxes?q=te')).json();
  assert.equal(result.mailboxes.length,1);assert.equal(result.mailboxes[0].email,'team@example.com');assert.equal(result.mailboxes[0].accessVerified,true);
  assert.equal(result.complete,false);assert.equal(seen.length,3);assert.match(seen[0].searchParams.get('$filter'),/startswith\(mail,'te'\)/);
});

test('shared mailbox attach uses a parent token, isolated account and verified folders',async t=>{
  const {service,request,db}=fixture(t,{fetchImpl:sharedFetch()});
  const result=await(await request('/api/accounts/primary/shared-mailboxes',{email:'team@example.com'})).json();const account=result.account;
  assert.equal(account.shared,true);assert.equal(account.parentAccountId,'primary');assert.equal(account.email,'team@example.com');assert.equal(account.canSend,true);
  assert.equal(account.verifiedFolders.length,1);assert.doesNotMatch(JSON.stringify(account),/secret/);
  const row=service.account(user,account.id);assert.equal(row.mailbox_target,'team-id');assert.equal(await service.accessToken(row),'access-secret');
  assert.throws(()=>service.account(other,account.id),{status:404});assert.equal(db.prepare('SELECT count(*) AS n FROM provider_accounts').get().n,2);
});

test('known email attach works without directory scope and denied mailbox is never persisted',async t=>{
  const {request,db}=fixture(t,{scopes:'Mail.Read.Shared',fetchImpl:async input=>String(input).includes('team%40example.com/mailFolders/inbox')?json({id:'folder'}):json({},403)});
  const account=(await(await request('/api/accounts/primary/shared-mailboxes',{email:'team@example.com'})).json()).account;
  assert.equal(account.canSend,false);assert.equal(account.canSync,true);
  await assert.rejects(request('/api/accounts/primary/shared-mailboxes',{email:'denied@example.com'}),{code:'shared_mailbox_access_denied',status:403});
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_accounts').get().n,2);
});

test('shared mail send canonicalizes sender and routes Graph MIME to target mailbox',async t=>{
  let submitted,submittedUrl;const {service,request}=fixture(t,{fetchImpl:sharedFetch(async(u,init)=>{
    if(u.pathname==='/v1.0/users/team-id/sendMail'){submitted=await simpleParser(Buffer.from(init.body,'base64'));submittedUrl=u.toString();return json(null,202);}return json({},403);
  })});
  const account=(await(await request('/api/accounts/primary/shared-mailboxes',{email:'team@example.com'})).json()).account;
  const result=await service.sendMail({user,accountId:account.id,message:{from:'forged@example.com',to:'recipient@example.net',subject:'Shared',body:'Hello'},idempotencyKey:'shared-send-1'});
  assert.equal(result.status,'accepted');assert.equal(submitted.from.value[0].address,'team@example.com');assert.match(submittedUrl,/users\/team-id\/sendMail$/);
});

test('shared sync and flag writeback are confined to target paths with inherited shared scopes',async t=>{
  const seen=[];const {service,request}=fixture(t,{fetchImpl:sharedFetch((u,init)=>{seen.push({u,init});
    if(u.pathname==='/v1.0/users/team-id/mailFolders/inbox/messages/delta')return json({value:[{id:'message',isRead:false}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/users/team-id/mailFolders/inbox/messages/delta?$deltatoken=next'});
    if(u.pathname==='/v1.0/users/team-id/messages/message/$value')return new Response('From: x@example.com\r\nSubject: Imported\r\n\r\nBody');
    if(u.pathname==='/v1.0/users/team-id/messages/message'&&init.method==='PATCH')return json({id:'message'});return json({},403);
  })});
  const account=(await(await request('/api/accounts/primary/shared-mailboxes',{email:'team@example.com'})).json()).account;
  const messages=await service.syncAccount(user,account.id);assert.equal(messages.length,1);assert.equal(messages[0].subject,'Imported');service.acknowledgeSync(user,account.id,messages.batchId);
  const update=await service.updateMessage(user,account.id,'message',{read:true},{idempotencyKey:'shared-read-1'});assert.equal(update.status,'applied');
  assert.ok(seen.filter(({u})=>u.pathname.includes('/messages')).every(({u})=>u.pathname.startsWith('/v1.0/users/team-id/')));
  await assert.rejects(service.cloudRequest(user,account.id,'https://graph.microsoft.com/v1.0/users/other/mailFolders/inbox'),{code:'provider_mailbox_scope'});
});

test('removing primary account atomically disconnects dependent mailboxes',async t=>{
  const {service,request}=fixture(t,{fetchImpl:sharedFetch()});await request('/api/accounts/primary/shared-mailboxes',{email:'team@example.com'});
  await service.handle(new Request(env.PUBLIC_URL+'/api/accounts/primary',{method:'DELETE'}),user);assert.deepEqual(service.listAccounts(user),[]);
});

test('cloud API rejects unsafe hosts and accepts only configured Google PIM service paths',async t=>{
  const {service,db}=fixture(t,{fetchImpl:async()=>json({ok:true})});
  db.prepare('INSERT INTO provider_accounts(id,owner,provider,email,display_name,encrypted_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('google','alice','google','alice@gmail.com','Alice',seal({accessToken:'google-secret',expiresAt:Date.now()+3600000},env,'account:alice:google:google'),Date.now(),Date.now());
  for(const url of ['https://evil.example/v1/people/me','https://www.googleapis.com/storage/v1/b','https://graph.microsoft.com/v1.0/me','https://people.googleapis.com.evil/v1/people/me'])await assert.rejects(service.cloudRequest(user,'google',url),{code:'provider_invalid_url'});
  assert.deepEqual(await service.cloudRequest(user,'google','https://people.googleapis.com/v1/people/me/connections'),{ok:true});
  assert.deepEqual(await service.cloudRequest(user,'google','https://www.googleapis.com/calendar/v3/calendars/primary/events'),{ok:true});
});
