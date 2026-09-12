import test from 'node:test';
import {simpleParser} from 'mailparser';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../backend/server.js';
import { openDatabase } from '../backend/storage.js';
import { digest, totp } from '../backend/security.js';

const PUBLIC_URL = 'https://backend.avenor.example';
const FRONTEND_URL = 'https://app.avenor.example/';
const PASSWORD = 'Avenor test password 2026!';
const providerError = (message, status = 404) => Object.assign(new Error(message), {status});

class FakeProviders {
  constructor() { this.accounts = []; this.sent = []; this.synced = []; this.acks = []; this.nextMessages = []; this.deliver = null; }
  migrate() {}
  account(user, id) { const account = this.accounts.find(a => a.id === id && a.owner === user.userId); if (!account) throw providerError('Mail account not found'); return account; }
  add(user, id = 'account-' + user.id, email = user.email) { const account = {id, owner: user.id, email, displayName: user.name, provider: 'google', status: 'connected'}; this.accounts.push(account); return account; }
  async listAccounts(user) { return this.accounts.filter(a => a.owner === user.userId); }
  async sendMail(message) { this.account(message.user, message.accountId); this.sent.push(message); return this.deliver ? this.deliver(message) : {status: 'accepted', providerId: 'fake-provider-' + this.sent.length}; }
  async syncAccount(user, accountId) { this.account(user, accountId); this.synced.push({user, accountId}); const messages = structuredClone(this.nextMessages); messages.batchId = 'fake-sync-batch'; return messages; }
  async acknowledgeSync(user, accountId, batchId) { this.acks.push({user, accountId, batchId}); }
  async handle(request, user) { if (new URL(request.url).pathname === '/api/accounts' && request.method === 'GET') return Response.json({accounts: await this.listAccounts(user)}); return null; }
}

async function fixture(t, {frontend = false} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'avenor-backend-test-'));
  const providers = new FakeProviders(), db = openDatabase(':memory:');
  const app = await createApplication({db, providers, env: {
    DATA_DIR: directory, DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_URL, FRONTEND_URL: frontend ? FRONTEND_URL : PUBLIC_URL,
    ADMIN_EMAIL: 'admin@example.com', ADMIN_NAME: 'Administrator', ADMIN_PASSWORD: PASSWORD,
    SEED_SAMPLE_DATA: 'false', OIDC_ISSUER: '',
  }});
  t.after(async () => { await app.close(); rmSync(directory, {recursive: true, force: true}); });
  const request = async (path, {method = 'GET', body, token, headers = {}, origin = frontend ? new URL(FRONTEND_URL).origin : PUBLIC_URL} = {}) => {
    const result = await app.handle(new Request(PUBLIC_URL + '/api/' + path, {
      method, headers: {'content-type': 'application/json', origin, ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers},
      ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
    }));
    const content = await result.text();
    let data; try { data = JSON.parse(content); } catch { data = content; }
    return {status: result.status, headers: result.headers, data};
  };
  const login = await request('auth/login', {method:'POST', body:{email:'admin@example.com', password:PASSWORD}});
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const admin = login.data;
  return {
    app, db, providers, admin, request,
    as(session, path, options = {}) { return request(path, {...options, token:session.token}); },
    async register(email = 'bob@example.com') {
      const invite = await request('auth/invitations', {method:'POST', token:admin.token, body:{email}});
      assert.equal(invite.status, 201, JSON.stringify(invite.data));
      const registered = await request('auth/register', {method:'POST', body:{invite:invite.data.invite, email:'ignored@example.net', password:PASSWORD, name:email.split('@')[0]}});
      assert.equal(registered.status, 201, JSON.stringify(registered.data));
      return {...registered.data, invitation:invite.data};
    },
    async create(session, kind, data, scope) {
      const result = await request('record', {method:'POST', token:session.token, body:{kind, data, ...(scope ? {scope} : {})}});
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data;
    },
    read(id) { const row = db.prepare('SELECT * FROM records WHERE id=?').get(id); return row ? {...JSON.parse(row.data), id:row.id, version:row.version, scope:row.scope, owner:row.owner, deleted:row.deleted} : null; },
  };
}

const draft = patch => ({folder:'drafts', date:new Date().toISOString(), to:'recipient@example.net', cc:'', bcc:'', subject:'A project update', body:'<p>Saved draft content</p>', attachments:[], ...patch});

test('backend authenticates bootstrap administrator, restricts invitation registration, and revokes logout sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('data')).status, 401);
  assert.equal((await f.request('auth/config')).data.registration, 'invite');
  assert.equal((await f.request('auth/login', {method:'POST', body:{email:'admin@example.com', password:'wrong password'}})).status, 401);
  assert.equal(f.db.prepare('SELECT hash FROM auth_sessions WHERE user_id=?').get(f.admin.user.id).hash, digest(f.admin.token));
  assert.notEqual(f.db.prepare('SELECT password FROM auth_accounts WHERE user_id=?').get(f.admin.user.id).password, PASSWORD);
  const bob = await f.register();
  assert.equal(bob.user.email, 'bob@example.com', 'registration identity comes from the administrator invitation');
  assert.equal((await f.request('auth/register', {method:'POST', body:{invite:bob.invitation.invite, password:PASSWORD}})).status, 403);
  assert.equal((await f.as(bob, 'auth/invitations', {method:'POST', body:{email:'eve@example.com'}})).status, 403);
  assert.equal((await f.as(bob, 'auth/logout', {method:'POST', body:{}})).status, 200);
  assert.equal((await f.as(bob, 'data')).status, 401);
});

test('backend CRUD persists records, enforces private scope, and rejects stale edits', async t => {
  const f = await fixture(t), bob = await f.register();
  const boot = await f.as(f.admin, 'data');
  assert.equal(boot.status, 200); assert.equal(boot.data.mode, 'connected'); assert.equal(boot.data.capabilities.background, true);
  assert.equal(boot.data.records.filter(r => r.sample).length, 0);
  const record = await f.create(f.admin, 'task', {title:'Private work', done:false});
  assert.equal((await f.as(bob, 'data?scope=' + encodeURIComponent(record.scope))).status, 403);
  assert.equal((await f.as(bob, 'record', {method:'PATCH', body:{id:record.id, version:1, patch:{title:'Intrusion'}}})).status, 403);
  assert.equal((await f.as(f.admin, 'record', {method:'PATCH', body:{id:record.id, version:1, patch:{title:'Revised work'}}})).status, 200);
  assert.equal((await f.as(f.admin, 'record', {method:'PATCH', body:{id:record.id, version:1, patch:{title:'Stale work'}}})).status, 409);
  assert.equal(f.read(record.id).title, 'Revised work');
  assert.equal((await f.as(f.admin, 'record', {method:'DELETE', body:{id:record.id, version:2}})).status, 200);
  assert.equal(f.read(record.id).deleted, 1);
});

test('record create, patch and delete idempotency replays preserve one operation and reject key reuse', async t => {
  const f = await fixture(t), key = 'backend-create-0001';
  const operation = {method:'POST', headers:{'idempotency-key':key}, body:{kind:'task', data:{title:'Only once'}}};
  const first = await f.as(f.admin, 'record', operation), replay = await f.as(f.admin, 'record', operation);
  assert.equal(first.status, 201); assert.deepEqual(replay.data, first.data);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM records WHERE kind='task'").get().n, 1);
  assert.equal((await f.as(f.admin, 'record', {...operation, body:{kind:'task', data:{title:'Different request'}}})).status, 409);
  const edit = {method:'PATCH', headers:{'idempotency-key':'backend-edit-0001'}, body:{id:first.data.id, version:1, patch:{title:'Edited once'}}};
  const edited = await f.as(f.admin, 'record', edit), editedAgain = await f.as(f.admin, 'record', edit);
  assert.equal(edited.status, 200); assert.deepEqual(editedAgain.data, edited.data); assert.equal(f.read(first.data.id).version, 2);
  const remove = {method:'DELETE', headers:{'idempotency-key':'backend-delete-0001'}, body:{id:first.data.id, version:2}};
  assert.equal((await f.as(f.admin, 'record', remove)).status, 200); assert.equal((await f.as(f.admin, 'record', remove)).status, 200);
  assert.equal(f.read(first.data.id).version, 3);
});

test('cached idempotent responses still enforce revoked delegation and request origin', async t => {
  const f = await fixture(t), bob = await f.register(), scope = 'user:' + f.admin.user.id;
  assert.equal((await f.as(f.admin, 'delegations', {method:'POST', body:{email:bob.user.email, permissions:['read','write']}})).status, 200);
  const operation = {method:'POST', headers:{'idempotency-key':'delegated-create-0001'}, body:{kind:'task', scope, data:{title:'Delegated confidential task'}}};
  assert.equal((await f.as(bob, 'record', operation)).status, 201);
  assert.equal((await f.as(bob, 'record', {...operation, origin:'https://evil.example'})).status, 403);
  assert.equal((await f.as(f.admin, 'delegations', {method:'DELETE', body:{email:bob.user.email}})).status, 200);
  assert.equal((await f.as(bob, 'record', operation)).status, 403);
});

test('jobs and notifications route through the assembled server and preserve scheduled draft versions', async t => {
  const f = await fixture(t, {frontend:true}), account = f.providers.add(f.admin.user);
  const record = await f.create(f.admin, 'message', draft());
  assert.deepEqual((await f.as(f.admin, 'jobs')).data, {jobs:[]});
  const scheduled = await f.as(f.admin, 'jobs', {method:'POST', body:{type:'send', recordId:record.id, version:record.version, accountId:account.id, runAt:Date.now()+60000}});
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.data)); assert.equal(scheduled.data.record.folder, 'outbox');
  assert.equal((await f.as(f.admin, 'jobs')).data.jobs.length, 1);
  assert.equal((await f.as(f.admin, 'jobs/' + scheduled.data.job.id, {method:'DELETE'})).status, 200);
  assert.equal(f.read(record.id).folder, 'drafts'); assert.equal(f.providers.sent.length, 0);
  const task = await f.create(f.admin, 'task', {title:'Due reminder', done:false, reminder:new Date(Date.now()-1000).toISOString()});
  await f.app.scheduler.runDue();
  const notifications = await f.as(f.admin, 'notifications');
  assert.equal(notifications.status, 200); assert.equal(notifications.data.notifications.length, 1);
  assert.equal(notifications.data.notifications[0].recordId, task.id);
  assert.equal((await f.as(f.admin, 'notifications/' + notifications.data.notifications[0].id, {method:'PATCH', body:{read:true}})).status, 200);
  assert.equal((await f.as(f.admin, 'notifications')).data.notifications[0].read, true);
});

test('scheduling rejects another user account before mutating the draft', async t => {
  const f = await fixture(t), bob = await f.register(), account = f.providers.add(bob.user);
  const record = await f.create(f.admin, 'message', draft());
  const result = await f.as(f.admin, 'jobs', {method:'POST', body:{type:'send', recordId:record.id, version:1, accountId:account.id, runAt:Date.now()+60000}});
  assert.ok([403,404].includes(result.status), JSON.stringify(result));
  assert.equal(f.read(record.id).version, 1); assert.equal(f.read(record.id).folder, 'drafts');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('delegation grants read, write and send separately and revocation takes immediate effect', async t => {
  const f = await fixture(t), bob = await f.register(), scope = 'user:' + f.admin.user.id;
  const record = await f.create(f.admin, 'task', {title:'Shared mailbox task'});
  assert.equal((await f.as(f.admin, 'delegations', {method:'POST', body:{email:bob.user.email, permissions:['read']}})).status, 200);
  assert.equal((await f.as(bob, 'data?scope=' + encodeURIComponent(scope))).status, 200);
  assert.equal((await f.as(bob, 'record', {method:'PATCH', body:{id:record.id,version:1,patch:{title:'Not allowed'}}})).status, 403);
  assert.equal((await f.as(bob, 'jobs?scope=' + encodeURIComponent(scope))).status, 200);
  assert.equal((await f.as(f.admin, 'delegations', {method:'POST', body:{email:bob.user.email, permissions:['read','write']}})).status, 200);
  assert.equal((await f.as(bob, 'record', {method:'PATCH', body:{id:record.id,version:1,patch:{title:'Allowed edit'}}})).status, 200);
  const account = f.providers.add(f.admin.user), message = await f.create(f.admin, 'message', draft({accountId:account.id}));
  assert.equal((await f.as(bob, 'send', {method:'POST',body:{id:message.id,version:1,accountId:account.id}})).status, 403);
  assert.equal((await f.as(f.admin, 'delegations', {method:'POST', body:{email:bob.user.email, permissions:['read','send']}})).status, 200);
  const sent = await f.as(bob, 'send', {method:'POST',body:{id:message.id,version:1,accountId:account.id}});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(f.providers.sent[0].user.userId, f.admin.user.id, 'delegated sends use the mailbox owner account');
  assert.equal((await f.as(f.admin, 'delegations', {method:'DELETE', body:{email:bob.user.email}})).status, 200);
  assert.equal((await f.as(bob, 'data?scope=' + encodeURIComponent(scope))).status, 403);
});

test('legal hold prevents deletion and policy administration stays with the mailbox owner', async t => {
  const f = await fixture(t), bob = await f.register(), scope = 'user:' + f.admin.user.id;
  const record = await f.create(f.admin, 'task', {title:'Retained business record'});
  assert.equal((await f.as(f.admin, 'policies', {method:'POST', body:{scope,retentionDays:30,legalHold:true}})).status, 200);
  assert.equal((await f.as(f.admin, 'record', {method:'DELETE', body:{id:record.id,version:1}})).status, 403);
  assert.equal(f.read(record.id).deleted, 0);
  assert.equal((await f.as(bob, 'policies', {method:'POST', body:{scope,retentionDays:0,legalHold:false}})).status, 403);
  assert.equal((await f.as(f.admin, 'policies')).data.policy.legal_hold, 1);
  assert.equal((await f.as(f.admin, 'policies', {method:'POST', body:{scope,retentionDays:0,legalHold:false}})).status, 200);
  assert.equal((await f.as(f.admin, 'record', {method:'DELETE', body:{id:record.id,version:1}})).status, 200);
});

test('shared workspace viewers can read records and job routes but cannot change records', async t => {
  const f = await fixture(t), bob = await f.register();
  const team = await f.as(f.admin, 'team', {method:'POST',body:{action:'create',name:'Project team'}});
  assert.equal(team.status, 200); const scope = 'team:' + team.data.id;
  assert.equal((await f.as(bob, 'team', {method:'POST',body:{action:'join',invite:team.data.invite}})).status, 200);
  assert.equal((await f.as(f.admin, 'team/role', {method:'POST',body:{team:team.data.id,user:bob.user.id,role:'viewer'}})).status, 200);
  const record = await f.create(f.admin, 'task', {title:'Shared work'}, scope);
  assert.equal((await f.as(bob, 'data?scope=' + encodeURIComponent(scope))).status, 200);
  assert.equal((await f.as(bob, 'jobs?scope=' + encodeURIComponent(scope))).status, 200);
  assert.equal((await f.as(bob, 'record', {method:'PATCH',body:{id:record.id,version:1,patch:{title:'Forbidden'}}})).status, 403);
  assert.equal((await f.as(bob, 'team/role', {method:'POST',body:{team:team.data.id,user:f.admin.user.id,role:'viewer'}})).status, 403);
});

test('accepted fake provider send is persisted and replayed without a second transport submission', async t => {
  const f = await fixture(t), account = f.providers.add(f.admin.user), record = await f.create(f.admin, 'message', draft());
  const operation = {method:'POST',headers:{'idempotency-key':'provider-send-0001'},body:{id:record.id,version:1,accountId:account.id}};
  const first = await f.as(f.admin, 'send', operation), replay = await f.as(f.admin, 'send', operation);
  assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(replay.status, 200);
  assert.equal(first.data.folder, 'sent'); assert.equal(first.data.delivery, 'accepted');
  assert.equal(f.providers.sent.length, 1); assert.ok(f.providers.sent[0].idempotencyKey.length >= 8);
  assert.match(f.providers.sent[0].mime, /MIME-Version: 1\.0/);
  assert.equal(f.db.prepare('SELECT status FROM send_operations WHERE id=?').get(f.providers.sent[0].idempotencyKey).status, 'accepted');
});

test('ambiguous provider acceptance stays unresolved and never submits again automatically', async t => {
  const f = await fixture(t), account = f.providers.add(f.admin.user), record = await f.create(f.admin, 'message', draft());
  f.providers.deliver = async () => ({status:'unknown'});
  const operation = {method:'POST',headers:{'idempotency-key':'provider-unknown-0001'},body:{id:record.id,version:1,accountId:account.id}};
  const first = await f.as(f.admin, 'send', operation); assert.equal(first.status, 502);
  assert.equal(f.read(record.id).delivery, 'unknown'); assert.equal(f.read(record.id).folder, 'drafts');
  assert.equal((await f.as(f.admin, 'send', operation)).status, 409);
  await f.app.scheduler.runDue(); assert.equal(f.providers.sent.length, 1);
});

test('simultaneous send requests cannot submit the same draft twice', async t => {
  const f = await fixture(t), account = f.providers.add(f.admin.user), record = await f.create(f.admin, 'message', draft());
  let enter, release; const entered = new Promise(resolve => {enter=resolve;}); const held = new Promise(resolve => {release=resolve;});
  f.providers.deliver = async () => {enter(); await held; return {status:'accepted'};};
  const first = f.as(f.admin, 'send', {method:'POST',headers:{'idempotency-key':'concurrent-send-0001'},body:{id:record.id,version:1,accountId:account.id}});
  await entered;
  const competing = await f.as(f.admin, 'send', {method:'POST',headers:{'idempotency-key':'concurrent-send-0002'},body:{id:record.id,version:1,accountId:account.id}});
  assert.equal(competing.status, 409); assert.equal(f.providers.sent.length, 1);
  release(); assert.equal((await first).status, 200);
});

test('scheduled send executes through the real server handler with only a fake provider', async t => {
  const f = await fixture(t), account = f.providers.add(f.admin.user), record = await f.create(f.admin, 'message', draft());
  const scheduled = await f.as(f.admin, 'jobs', {method:'POST',body:{type:'send',recordId:record.id,version:1,accountId:account.id,runAt:Date.now()+60000}});
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.data));
  f.db.prepare('UPDATE jobs SET run_at=? WHERE id=?').run(Date.now()-1, scheduled.data.job.id);
  await f.app.scheduler.runDue(); await f.app.scheduler.runDue();
  assert.equal(f.read(record.id).folder, 'sent'); assert.equal(f.providers.sent.length, 1);
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(scheduled.data.job.id).status, 'accepted');
});

test('disabling an account prevents its previously scheduled message from being sent', async t => {
  const f = await fixture(t), bob = await f.register(), account = f.providers.add(bob.user), record = await f.create(bob, 'message', draft());
  const scheduled = await f.as(bob, 'jobs', {method:'POST',body:{type:'send',recordId:record.id,version:1,accountId:account.id,runAt:Date.now()+60000}});
  assert.equal(scheduled.status, 201);
  assert.equal((await f.as(f.admin, 'auth/users', {method:'PATCH',body:{id:bob.user.id,role:'user',disabled:true}})).status, 200);
  f.db.prepare('UPDATE jobs SET run_at=? WHERE id=?').run(Date.now()-1, scheduled.data.job.id);
  await f.app.scheduler.runDue();
  assert.equal(f.providers.sent.length, 0);
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(scheduled.data.job.id).status, 'failed');
  assert.notEqual(f.read(record.id).folder, 'sent');
});

test('delegated send rechecks permission after asynchronous account preparation', async t => {
  const f = await fixture(t), bob = await f.register(), account = f.providers.add(f.admin.user), record = await f.create(f.admin, 'message', draft());
  assert.equal((await f.as(f.admin, 'delegations', {method:'POST',body:{email:bob.user.email,permissions:['read','send']}})).status, 200);
  let enter, release; const entered = new Promise(resolve => {enter=resolve;}), held = new Promise(resolve => {release=resolve;});
  const listAccounts = f.providers.listAccounts.bind(f.providers);
  f.providers.listAccounts = async user => {enter(); await held; return listAccounts(user);};
  const sending = f.as(bob, 'send', {method:'POST',body:{id:record.id,version:1,accountId:account.id}});
  await entered;
  assert.equal((await f.as(f.admin, 'delegations', {method:'DELETE',body:{email:bob.user.email}})).status, 200);
  release(); const result = await sending;
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(f.providers.sent.length, 0);
  assert.equal(f.read(record.id).folder, 'drafts');
});

test('calendar invitations and public RSVP route through the backend with selected account identity', async t => {
  const f = await fixture(t), account = f.providers.add(f.admin.user, 'calendar-account', 'organizer@work.example');
  const event = await f.create(f.admin, 'event', {title:'Design review',start:'2026-10-12T12:00:00Z',end:'2026-10-12T13:00:00Z',attendees:'guest@example.net',repeat:'none'});
  const invite = await f.as(f.admin, 'invitations', {method:'POST',body:{eventId:event.id,version:1,accountId:account.id}});
  assert.equal(invite.status, 202, JSON.stringify(invite.data)); assert.equal(invite.data.organizer, account.email);
  await f.app.scheduler.runDue(); assert.equal(f.providers.sent.length, 1);
  const outgoing = f.providers.sent[0], token = outgoing.message.body.match(/\/invitations\/respond\/([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token); assert.match(outgoing.mime, /method=REQUEST/);
  const before = f.read(event.id).version;
  const preview = await f.request('invitations/respond/' + token);
  assert.equal(preview.status, 200); assert.match(preview.data, /<form method="post"/); assert.equal(f.read(event.id).version, before);
  const reply = await f.request('invitations/respond/' + token, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'response=accepted'});
  assert.equal(reply.status, 200); assert.equal(f.read(event.id).attendeeStatuses['guest@example.net'], 'ACCEPTED');
  await f.app.scheduler.runDue(); assert.equal(f.providers.sent.length, 2); assert.match(f.providers.sent[1].mime, /method=REPLY/);
});

test('provider sync imports account-scoped records and bytes before acknowledging the batch', async t => {
  const f = await fixture(t), account = f.providers.add(f.admin.user);
  f.providers.nextMessages = [{id:'provider-message-1',providerId:'remote-1',folder:'inbox',date:new Date().toISOString(),from:'sender@example.net',to:f.admin.user.email,subject:'Imported mail',body:'Imported content',read:false,attachments:[{name:'note.txt',type:'text/plain',bytes:new Uint8Array([72,105])}]}];
  const synced = await f.as(f.admin, 'accounts/' + account.id + '/sync', {method:'POST',body:{}});
  assert.equal(synced.status, 200, JSON.stringify(synced.data)); assert.equal(synced.data.count, 1);
  const record = f.read('provider-message-1'); assert.equal(record.scope, 'user:' + f.admin.user.id); assert.equal(record.accountId, account.id);
  assert.equal(f.providers.acks.length, 1); assert.equal(f.providers.acks[0].batchId, 'fake-sync-batch');
  const download = await f.as(f.admin, 'file/' + record.attachments[0].id); assert.equal(download.status, 200); assert.equal(download.data, 'Hi');
  const bob = await f.register(); assert.equal((await f.as(bob, 'file/' + record.attachments[0].id)).status, 404);
});

test('administrator access changes revoke sessions and audit history verifies', async t => {
  const f = await fixture(t), bob = await f.register();
  assert.equal((await f.as(bob, 'audit')).status, 403);
  assert.equal((await f.as(f.admin, 'auth/users', {method:'PATCH',body:{id:bob.user.id,role:'user',disabled:true}})).status, 200);
  assert.equal((await f.as(bob, 'data')).status, 401);
  assert.equal((await f.request('auth/login', {method:'POST',body:{email:bob.user.email,password:PASSWORD}})).status, 401);
  const audit = await f.as(f.admin, 'audit'); assert.equal(audit.status, 200); assert.equal(audit.data.verification.valid, true);
  assert.ok(audit.data.entries.some(entry => entry.action === 'account.access_changed'));
});

test('MFA enrollment encrypts its secret and concurrent logins consume each authenticator or recovery code once', async t => {
  const f = await fixture(t);
  assert.equal((await f.as(f.admin, 'auth/mfa/setup', {method:'POST',body:{password:'incorrect password'}})).status, 403);
  const setup = await f.as(f.admin, 'auth/mfa/setup', {method:'POST',body:{password:PASSWORD}});
  assert.equal(setup.status, 200); assert.match(setup.data.uri, /^otpauth:\/\/totp\/Avenor:/);
  const pending = f.db.prepare('SELECT mfa_pending FROM auth_accounts WHERE user_id=?').get(f.admin.user.id).mfa_pending;
  assert.notEqual(pending, setup.data.secret);
  assert.equal(f.app.auth.vault.open(pending), setup.data.secret);
  const code = totp(setup.data.secret);
  const enrolled = await f.as(f.admin, 'auth/mfa/confirm', {method:'POST',body:{code}});
  assert.equal(enrolled.status, 200); assert.equal(enrolled.data.recoveryCodes.length, 8);
  assert.equal((await f.as(f.admin, 'auth/me')).data.mfa, true);
  const login = value => f.request('auth/login', {method:'POST',body:{email:f.admin.user.email,password:PASSWORD,...(value ? {code:value} : {})}});
  assert.equal((await login()).status, 401);
  const authenticators = await Promise.all([login(code), login(code)]);
  assert.deepEqual(authenticators.map(r => r.status).sort(), [200,401]);
  assert.equal((await login(code)).status, 401);
  const recovery = enrolled.data.recoveryCodes[0];
  const recovered = await Promise.all([login(recovery), login(recovery)]);
  assert.deepEqual(recovered.map(r => r.status).sort(), [200,401]);
  assert.equal((await login(recovery)).status, 401);
  const stored = f.db.prepare('SELECT mfa,mfa_pending,backup_codes FROM auth_accounts WHERE user_id=?').get(f.admin.user.id);
  assert.equal(stored.mfa_pending, null); assert.equal(f.app.auth.vault.open(stored.mfa), setup.data.secret);
  assert.equal(JSON.parse(stored.backup_codes).length, 7);
  assert.equal(stored.backup_codes.includes(recovery), false); assert.equal(stored.backup_codes.includes(digest(recovery)), false);
});

test('OIDC exchange validates the verifier and atomically consumes a local sign-in code', async t => {
  const f = await fixture(t), code = 'test-oidc-code-0001', verifier = 'test-browser-verifier-with-sufficient-entropy-0001';
  const challenge = Buffer.from(digest(verifier), 'hex').toString('base64url');
  f.db.prepare('INSERT INTO auth_codes(hash,data,expires) VALUES(?,?,?)').run(digest(code), f.app.auth.vault.seal({userId:f.admin.user.id,challenge}), Date.now()+60000);
  const exchange = value => f.request('auth/exchange', {method:'POST',body:{code,verifier:value}});
  assert.equal((await exchange('wrong-verifier')).status, 403);
  assert.ok(f.db.prepare('SELECT hash FROM auth_codes WHERE hash=?').get(digest(code)));
  const exchanged = await Promise.all([exchange(verifier), exchange(verifier)]);
  assert.deepEqual(exchanged.map(r => r.status).sort(), [200,401]);
  assert.equal(exchanged.find(r => r.status===200).data.user.id, f.admin.user.id);
  assert.equal((await exchange(verifier)).status, 401);
});

test('internal send uses the same durable submission path without an external provider', async t => {
  const f = await fixture(t), record = await f.create(f.admin, 'message', draft({to:f.admin.user.email}));
  const operation = {method:'POST',headers:{'idempotency-key':'internal-send-0001'},body:{id:record.id,version:1}};
  const sent = await f.as(f.admin, 'send', operation);
  assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.folder, 'sent'); assert.equal(sent.data.delivery, 'internal');
  const again = await f.as(f.admin, 'send', operation); assert.equal(again.status, 200);
  assert.equal(f.providers.sent.length, 0);
  const incoming = f.read(record.id + ':delivery:' + f.admin.user.id); assert.equal(incoming.folder, 'inbox'); assert.equal(incoming.read, false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM records WHERE json_extract(data,'$.folder')='inbox'").get().n, 1);
});

test('message routes reject server-managed provider metadata and imported account reassignment', async t => {
  const f=await fixture(t), account=f.providers.add(f.admin.user);
  const protectedFields={providerSyncStamp:'forged-sync',providerId:'forged-remote-id',provider:'google',accepted:['forged@example.net'],rejected:[],delivery:'accepted',deliveryError:'forged-status'};
  for(const [field,value] of Object.entries(protectedFields)) {
    const created=await f.as(f.admin,'record',{method:'POST',body:{kind:'message',data:draft({[field]:value})}});
    assert.ok([400,403].includes(created.status), `POST must reject ${field}: ${JSON.stringify(created.data)}`);
  }
  const record=await f.create(f.admin,'message',draft());
  for(const [field,value] of Object.entries(protectedFields)) {
    const updated=await f.as(f.admin,'record',{method:'PATCH',body:{id:record.id,version:1,patch:{[field]:value}}});
    assert.ok([400,403].includes(updated.status), `PATCH must reject ${field}: ${JSON.stringify(updated.data)}`);
  }
  assert.equal(f.read(record.id).version,1); assert.equal(f.read(record.id).folder,'drafts');
  f.providers.nextMessages=[{id:'protected-import',providerId:'trusted-remote-id',folder:'inbox',read:false,flagged:false,date:new Date().toISOString(),from:'sender@example.net',to:f.admin.user.email,subject:'Trusted import',body:'Imported',attachments:[]}];
  assert.equal((await f.as(f.admin,'accounts/'+account.id+'/sync',{method:'POST',body:{}})).status,200);
  const imported=f.read('protected-import');
  const reassigned=await f.as(f.admin,'record',{method:'PATCH',body:{id:imported.id,version:imported.version,patch:{accountId:'different-account'}}});
  assert.ok([400,403].includes(reassigned.status), JSON.stringify(reassigned.data));
  assert.equal(f.read(imported.id).accountId,account.id); assert.equal(f.read(imported.id).providerId,'trusted-remote-id');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM jobs WHERE type='provider_mutation'").get().n,0);
});

test('metadata-only mailbox reconciliation preserves MIME and attachment references', async t => {
 const f=await fixture(t),account=f.providers.add(f.admin.user);
 f.providers.nextMessages=[{id:'mail-metadata',providerId:'uid-7',subject:'Original MIME',body:'<p>Keep the body</p>',from:'sender@example.net',folder:'inbox',attachments:[{name:'report.txt',type:'text/plain',bytes:Buffer.from('private attachment')}]}];
 await f.app.ingest(f.app.auth.user(f.admin.user.id),account.id);const original=f.read('mail-metadata');
 f.providers.nextMessages=[{id:'mail-metadata',providerId:'uid-7',metadataOnly:true,read:true,flagged:true,folder:'archive'}];
 await f.app.ingest(f.app.auth.user(f.admin.user.id),account.id);const result=f.read('mail-metadata');
 assert.equal(result.body,original.body);assert.equal(result.subject,original.subject);assert.deepEqual(result.attachments,original.attachments);assert.equal(result.folder,'archive');assert.equal(result.read,true);assert.equal(result.metadataOnly,undefined);
 const response=await f.app.handle(new Request(PUBLIC_URL+'/api/file/'+original.attachments[0].id,{headers:{authorization:'Bearer '+f.admin.token}}));assert.equal(response.status,200);assert.equal(await response.text(),'private attachment');
});

test('provider tombstones preserve legal-held records while acknowledging synchronization', async t => {
 const f=await fixture(t),account=f.providers.add(f.admin.user),scope='user:'+f.admin.user.id;
 f.providers.nextMessages=[{id:'held-mail',providerId:'remote-held',folder:'inbox',body:'Evidence'}];await f.app.ingest(f.app.auth.user(f.admin.user.id),account.id);
 await f.as(f.admin,'policies',{method:'POST',body:{scope,retentionDays:0,legalHold:true}});
 f.providers.nextMessages=[{id:'held-mail',deleted:true}];await f.app.ingest(f.app.auth.user(f.admin.user.id),account.id);
 assert.equal(f.read('held-mail').deleted,0);assert.equal(f.providers.acks.length,2);assert.equal(f.app.compliance.verifyRevisions().valid,true);
});

test('outbound DLP blocks before submission and warnings require a content-bound acknowledgment', async t => {
 const f=await fixture(t),account=f.providers.add(f.admin.user),scope='user:'+f.admin.user.id;
 const record=await f.create(f.admin,'message',draft({accountId:account.id}));
 const policy={internalDomains:['example.com'],rules:[{id:'external',name:'External recipient',action:'warn',match:{externalOnly:true}}]};
 assert.equal((await f.as(f.admin,'compliance/dlp',{method:'POST',body:{scope,version:0,policy}})).status,200);
 const send=body=>f.as(f.admin,'send',{method:'POST',body:{id:record.id,version:f.read(record.id).version,accountId:account.id,...body}});
 const warning=await send({});assert.equal(warning.status,409);assert.equal(warning.data.code,'dlp_warning');assert.ok(warning.data.acknowledgment);assert.equal(f.providers.sent.length,0);assert.equal(f.read(record.id).delivery,undefined);
 await f.as(f.admin,'record',{method:'PATCH',body:{id:record.id,version:record.version,patch:{body:'Changed after review'}}});
 const stale=await send({acknowledged:[warning.data.acknowledgment]});assert.equal(stale.status,409);assert.notEqual(stale.data.acknowledgment,warning.data.acknowledgment);
 const accepted=await send({acknowledged:[stale.data.acknowledgment]});assert.equal(accepted.status,200);assert.equal(f.providers.sent.length,1);
 const blocked=await f.create(f.admin,'message',draft({accountId:account.id}));
 await f.as(f.admin,'compliance/dlp',{method:'POST',body:{scope,version:1,policy:{...policy,rules:[{id:'external',action:'block',match:{externalOnly:true}}]}}});
 const failed=await f.as(f.admin,'send',{method:'POST',body:{id:blocked.id,version:blocked.version,accountId:account.id}});assert.equal(failed.status,422);assert.equal(f.read(blocked.id).folder,'drafts');assert.equal(f.providers.sent.length,1);
});

test('native inbound meeting requests are reviewed, displayed and answered through durable delivery', async t => {
 const f=await fixture(t),account=f.providers.add(f.admin.user),user=f.app.auth.user(f.admin.user.id);
 const calendar=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Avenor test//EN','METHOD:REQUEST','BEGIN:VEVENT','UID:backend-inbound','SEQUENCE:1','DTSTAMP:20260912T120000Z','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:Integration meeting','ORGANIZER:mailto:organizer@example.net','ATTENDEE;RSVP=TRUE:mailto:admin@example.com','END:VEVENT','END:VCALENDAR',''].join('\r\n');
 f.providers.nextMessages=[{id:'inbound-mail',providerId:'native-request',internetMessageId:'<calendar@example.net>',folder:'inbox',from:'organizer@example.net',body:'Meeting invite',calendarParts:[{content:calendar}]}];
 await f.app.ingest(user,account.id);
 let list=await f.as(f.admin,'calendar/inbound?status=all');assert.equal(list.status,200);const item=list.data.messages[0];assert.equal(item.status,'review');
 const reviewed=await f.as(f.admin,'calendar/inbound/'+item.id+'/review',{method:'POST',body:{decision:'accept'}});assert.equal(reviewed.status,200);
 const event=f.db.prepare("SELECT * FROM records WHERE kind='event'").get();assert.ok(event);assert.equal(JSON.parse(event.data).calendarInboxId,item.id);
 const forbidden=await f.as(f.admin,'record',{method:'PATCH',body:{id:event.id,version:event.version,patch:{title:'Rewrite organizer title'}}});assert.equal(forbidden.status,403);
 const reply=await f.as(f.admin,'calendar/inbound/'+item.id+'/respond',{method:'POST',body:{response:'accepted'}});assert.equal(reply.status,202);
 await f.app.scheduler.runDue();assert.equal(f.providers.sent.length,1);const parsed=await simpleParser(f.providers.sent[0].mime);const replyContent=parsed.attachments.find(a=>a.contentType==='text/calendar').content.toString();assert.match(replyContent,/METHOD:REPLY/);assert.match(replyContent,/PARTSTAT=ACCEPTED/);
});

test('background calendar messages cannot bypass outbound protection policy',async t=>{
 const f=await fixture(t),account=f.providers.add(f.admin.user),scope='user:'+f.admin.user.id;
 const event=await f.create(f.admin,'event',{title:'Protected meeting',start:'2030-01-01T10:00:00Z',end:'2030-01-01T11:00:00Z',attendees:'external@example.net',notes:'Confidential agenda'});
 await f.as(f.admin,'compliance/dlp',{method:'POST',body:{scope,version:0,policy:{internalDomains:['example.com'],rules:[{id:'calendar-external',action:'block',match:{externalOnly:true}}]}}});
 const queued=await f.as(f.admin,'invitations',{method:'POST',body:{eventId:event.id,version:event.version,accountId:account.id,method:'REQUEST'}});assert.equal(queued.status,202);
 await f.app.scheduler.runDue();assert.equal(f.providers.sent.length,0);
 const job=f.db.prepare("SELECT * FROM jobs WHERE type='invitation-delivery'").get();assert.notEqual(job.status,'completed');assert.notEqual(job.status,'accepted');
});
