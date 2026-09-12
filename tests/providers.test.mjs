import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { ProviderService } from '../backend/providers/index.js';
import { seal, unseal } from '../backend/providers/security.js';
import { canonicalMime, graphSync, gmailSync } from '../backend/providers/cloud-mail.js';

const user = { userId: 'alice', email: 'alice@avenor.example', displayName: 'Alice' };
const other = { userId: 'bob', email: 'bob@avenor.example' };
const env = { DATA_KEY: Buffer.alloc(32, 13).toString('base64'), PUBLIC_URL: 'https://mail.avenor.example', FRONTEND_URL: 'https://app.avenor.example',
  GOOGLE_CLIENT_ID: 'google-app', GOOGLE_CLIENT_SECRET: 'google-secret', MICROSOFT_CLIENT_ID: 'ms-app', MICROSOFT_CLIENT_SECRET: 'ms-secret' };
const respond = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rawMail = 'From: Sender <sender@example.com>\r\nTo: alice@example.com\r\nSubject: Incoming hello\r\nDate: Tue, 08 Sep 2026 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nActual body\r\n';
function fixture(fetchImpl = async () => { throw new Error('Unexpected network call'); }, override = {}) {
  const db = new DatabaseSync(':memory:');
  const service = new ProviderService({ db, env: { ...env, ...override }, fetchImpl });
  service.migrate();
  return { db, service };
}
async function connect(service, provider = 'google', owner = user) {
  const start = service.startOAuth(owner, provider);
  const auth = new URL(start.url);
  const url = new URL(`${env.PUBLIC_URL}/api/oauth/${provider}/callback`);
  url.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'authorization-code' }).toString();
  await service.callback(provider, url, null);
  return service.listAccounts(owner)[0];
}
function oauthFetch(next = () => { throw new Error('Unexpected endpoint'); }) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token' || url.includes('login.microsoftonline.com')) {
      return respond({ access_token: 'access-token', refresh_token: 'refresh-supersecret', expires_in: 3600 });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return respond({ emailAddress: 'alice@example.com', historyId: '100' });
    if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) return respond({ id: 'ms-id', mail: 'alice@example.com', displayName: 'Alice Mail' });
    return next(url, init);
  };
}

test('migrations are idempotent; provider no-config status does not break account listing', async () => {
  const { db, service } = fixture(undefined, { DATA_KEY: '', GOOGLE_CLIENT_ID: '', MICROSOFT_CLIENT_ID: '' });
  service.migrate();
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_migrations').get().n, 2);
  const response = await service.handle(new Request(`${env.PUBLIC_URL}/api/accounts`), user);
  assert.deepEqual((await response.json()).accounts, []);
  assert.ok(service.providerStatus().every(p => !p.configured && p.reason));
  assert.throws(() => service.startOAuth(user, 'google'), { status: 503 });
  db.close();
});

test('AES-GCM binds encrypted credentials to their account owner and rejects tampering', () => {
  const encrypted = seal({ refreshToken: 'secret' }, env, 'alice:account');
  assert.equal(encrypted.includes('secret'), false);
  assert.deepEqual(unseal(encrypted, env, 'alice:account'), { refreshToken: 'secret' });
  assert.throws(() => unseal(encrypted, env, 'bob:account'), { code: 'credential_unavailable' });
  assert.throws(() => unseal(encrypted.slice(0, -8), env, 'alice:account'), { code: 'credential_unavailable' });
});

for (const provider of ['google', 'microsoft']) {
  test(`${provider} OAuth uses PKCE, consumes owner-bound state once and hides tokens`, async () => {
    const requests = [];
    const fetchImpl = oauthFetch();
    const { db, service } = fixture(async (url, init) => { requests.push({ url: String(url), init }); return fetchImpl(url, init); });
    const start = service.startOAuth(user, provider);
    const authorization = new URL(start.url);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('redirect_uri'), `${env.PUBLIC_URL}/api/oauth/${provider}/callback`);
    const state = authorization.searchParams.get('state');
    const url = new URL(`${env.PUBLIC_URL}/api/oauth/${provider}/callback?state=${state}&code=the-code`);
    await assert.rejects(service.callback(provider, url, other), { code: 'oauth_owner_mismatch' });
    assert.equal(requests.length, 0);
    const response = await service.callback(provider, url, null);
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get('location')).origin, new URL(env.FRONTEND_URL).origin);
    const tokenCall = requests[0].init.body;
    const verifier = tokenCall.get('code_verifier');
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
    assert.equal(tokenCall.get('code'), 'the-code');
    const accounts = service.listAccounts(user);
    assert.equal(accounts[0].email, 'alice@example.com');
    assert.equal(JSON.stringify(accounts).includes('token'), false);
    const persisted = db.prepare('SELECT * FROM provider_accounts').get();
    assert.equal(persisted.encrypted_secret.includes('refresh-supersecret'), false);
    assert.throws(() => service.account(other, accounts[0].id), { status: 404 });
    await assert.rejects(service.callback(provider, url, null), { code: 'oauth_state_invalid' });
    db.close();
  });
}

test('expired and denied OAuth state cannot be replayed', async () => {
  const { db, service } = fixture();
  let state = new URL(service.startOAuth(user, 'google').url).searchParams.get('state');
  db.prepare('UPDATE provider_oauth_states SET expires_at=0').run();
  await assert.rejects(service.callback('google', new URL(`${env.PUBLIC_URL}/api/oauth/google/callback?state=${state}&code=c`), user), { code: 'oauth_state_invalid' });
  state = new URL(service.startOAuth(user, 'google').url).searchParams.get('state');
  const denial = new URL(`${env.PUBLIC_URL}/api/oauth/google/callback?state=${state}&error=access_denied`);
  await assert.rejects(service.callback('google', denial, user), { code: 'oauth_denied' });
  await assert.rejects(service.callback('google', denial, user), { code: 'oauth_state_invalid' });
  db.close();
});

test('SMTP settings are encrypted, scoped and never echoed', async () => {
  const { db, service } = fixture();
  const account = await service.addSmtpAccount(user, { email: 'alice@example.com', displayName: 'Alice', smtp: { host: 'smtp.example.com', password: 'smtp-private' }, imap: { host: 'imap.example.com', password: 'imap-private' } });
  const row = db.prepare('SELECT * FROM provider_accounts').get();
  assert.equal(JSON.stringify(row).includes('smtp-private'), false);
  assert.equal(JSON.stringify(account).includes('password'), false);
  await assert.rejects(service.handle(new Request(`${env.PUBLIC_URL}/api/accounts/${account.id}`, { method: 'DELETE' }), other), { status: 404 });
  await assert.rejects(service.handle(new Request(`${env.PUBLIC_URL}/api/accounts/${account.id}`, { method: 'DELETE', headers: { Origin: 'https://attacker.example' } }), user), { status: 403 });
  db.close();
});

test('Gmail sends canonical MIME, retains Bcc and deduplicates a repeated attempt', async () => {
  let sent = 0, raw;
  const { db, service } = fixture(oauthFetch((url, init) => {
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    sent += 1;
    raw = Buffer.from(JSON.parse(init.body).raw, 'base64url');
    return respond({ id: 'gmail-sent-1' });
  }));
  const account = await connect(service);
  const args = { user, accountId: account.id, idempotencyKey: 'draft-uuid-1', message: { from: 'spoofed@example.com', to: 'recipient@example.com', bcc: 'private@example.com', subject: 'Hello', body: 'Hello body', attachments: [{ name: 'file.txt', type: 'text/plain', bytes: Buffer.from('actual attachment') }] } };
  assert.deepEqual(await service.sendMail(args), { status: 'accepted', providerId: 'gmail-sent-1' });
  assert.deepEqual(await service.sendMail(args), { status: 'accepted', providerId: 'gmail-sent-1' });
  assert.equal(sent, 1);
  const parsed = await simpleParser(raw);
  assert.equal(parsed.from.value[0].address, 'alice@example.com');
  assert.equal(parsed.bcc.value[0].address, 'private@example.com');
  assert.equal(parsed.attachments[0].content.toString(), 'actual attachment');
  await assert.rejects(service.sendMail({ ...args, message: { ...args.message, body: 'Changed' } }), { code: 'idempotency_conflict' });
  db.close();
});

test('an uncertain send is never automatically sent a second time', async () => {
  let sent = 0;
  const { db, service } = fixture(oauthFetch(() => { sent++; throw new Error('socket reset with token-secret'); }));
  const account = await connect(service);
  const args = { user, accountId: account.id, idempotencyKey: 'uncertain-1', message: { to: 'recipient@example.com', subject: 'Hello', body: 'Body' } };
  await assert.rejects(service.sendMail(args), error => error.code === 'provider_connection_error' && error.unknown === true && error.uncertain === true && !error.message.includes('token-secret'));
  await assert.rejects(service.sendMail(args), { code: 'provider_send_unconfirmed', unknown: true, uncertain: true });
  assert.equal(sent, 1);
  assert.equal(db.prepare('SELECT status FROM provider_sends').get().status, 'unknown');
  db.close();
});

test('refresh tokens rotate encrypted and concurrent access shares one refresh', async () => {
  let tokenCalls = 0;
  const mock = oauthFetch();
  const { db, service } = fixture(async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token' && init.body.get('grant_type') === 'refresh_token') {
      tokenCalls++;
      assert.equal(init.body.get('refresh_token'), 'refresh-supersecret');
      return respond({ access_token: 'new-access', refresh_token: 'rotated-secret', expires_in: 3600 });
    }
    return mock(url, init);
  });
  const account = await connect(service);
  const row = service.account(user, account.id);
  const context = `account:${row.owner}:${row.id}:${row.provider}`;
  const secret = unseal(row.encrypted_secret, env, context); secret.expiresAt = 0;
  db.prepare('UPDATE provider_accounts SET encrypted_secret=? WHERE id=?').run(seal(secret, env, context), row.id);
  assert.deepEqual(await Promise.all([service.accessToken(row), service.accessToken(row)]), ['new-access','new-access']);
  assert.equal(tokenCalls, 1);
  const stored = db.prepare('SELECT encrypted_secret FROM provider_accounts WHERE id=?').get(row.id).encrypted_secret;
  assert.equal(stored.includes('rotated-secret'), false);
  assert.equal(unseal(stored, env, context).refreshToken, 'rotated-secret');
  await assert.rejects(service.api(row, 'https://attacker.example/steal'), { code: 'provider_invalid_url' });
  db.close();
});

test('sync pages remain durable until exact batch acknowledgement, then resume pagination', async () => {
  let messageLists = 0;
  const { db, service } = fixture(oauthFetch(url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/messages')) {
      messageLists++;
      return respond(u.searchParams.get('pageToken') === 'page2' ? { messages: [{ id: 'm2' }] } : { messages: [{ id: 'm1' }], nextPageToken: 'page2' });
    }
    if (u.pathname.includes('/messages/')) return respond({ id: u.pathname.split('/').at(-1), raw: Buffer.from(rawMail).toString('base64url'), labelIds: ['INBOX','UNREAD'], internalDate: '1788868800000' });
    throw new Error('Unexpected request ' + url);
  }));
  const account = await connect(service);
  const first = await service.syncAccount(user, account.id);
  assert.equal(first[0].body.trim(), 'Actual body');
  assert.equal(first[0].folder, 'inbox');
  assert.equal(first[0].read, false);
  assert.equal(first[0].providerId, 'm1');
  const replay = await service.syncAccount(user, account.id);
  assert.equal(replay.batchId, first.batchId);
  assert.equal(messageLists, 1);
  assert.equal(service.account(user, account.id).cursor_json, '{}');
  assert.throws(() => service.acknowledgeSync(user, account.id, 'wrong-batch'), { status: 409 });
  service.acknowledgeSync(user, account.id, first.batchId);
  const second = await service.syncAccount(user, account.id);
  assert.equal(second[0].providerId, 'm2');
  assert.equal(messageLists, 2);
  service.acknowledgeSync(user, account.id, second.batchId);
  assert.equal(JSON.parse(service.account(user, account.id).cursor_json).historyId, '100');
  db.close();
});

test('Gmail history applies labels/removals and resumes an expired history with full sync', async () => {
  const requests = [];
  const api = async url => {
    requests.push(url);
    if (url.includes('/history?')) return { history: [{ messagesAdded: [{ message: { id: 'new' } }], messagesDeleted: [{ message: { id: 'gone' } }] }], historyId: '120' };
    if (url.includes('/messages/gone')) throw Object.assign(new Error('missing'), { providerStatus: 404 });
    return { id: 'new', raw: Buffer.from(rawMail).toString('base64url'), labelIds: ['SENT'] };
  };
  const result = await gmailSync(api, { historyId: '100' }, 10);
  assert.equal(result.cursor.historyId, '120');
  assert.equal(result.messages.find(x => x.providerId === 'new').folder, 'sent');
  assert.equal(result.messages.find(x => x.providerId === 'gone').deleted, true);
  const expired = await gmailSync(async url => {
    if (url.includes('/history?')) throw Object.assign(new Error('expired'), { providerStatus: 404 });
    if (url.endsWith('/profile')) return { historyId: '200' };
    return { messages: [] };
  }, { historyId: '1' }, 10);
  assert.equal(expired.cursor.historyId, '200');
});

test('Graph delta uses immutable ids, follows cursors and preserves a moved live message over tombstones', async () => {
  const requests = [];
  const api = async (url, init) => {
    requests.push({ url, init });
    const folder = new URL(url).pathname.split('/')[4];
    return { value: folder === 'inbox' ? [{ id: 'moved', '@removed': { reason: 'deleted' } }] : folder === 'archive' ? [{ id: 'moved', isRead: true }] : [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=next` };
  };
  const result = await graphSync(api, async () => Buffer.from(rawMail), {}, 100);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(r => r.init.headers.Prefer.includes('ImmutableId')));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].folder, 'archive');
  assert.equal(result.messages[0].deleted, undefined);
  assert.ok(result.cursor.folders.inbox.includes('$deltatoken=next'));
});

test('outgoing MIME rejects unresolved attachment ids and header injection', async () => {
  const account = { email: 'alice@example.com', displayName: 'Alice' };
  await assert.rejects(canonicalMime(account, { to: 'friend@example.com', subject: 'x\r\nBcc: evil@example.com', body: 'hi' }), { status: 400 });
  await assert.rejects(canonicalMime(account, { to: 'friend@example.com', subject: 'Hello', attachments: [{ id: 'stored-only' }] }), { status: 409 });
  const smtp = await canonicalMime({ ...account, provider: 'smtp' }, { to: 'friend@example.com', bcc: 'hidden@example.com', subject: 'Private', body: 'Hi' });
  assert.equal((await simpleParser(smtp.mime)).bcc, undefined);
  assert.ok(smtp.envelope.to.includes('hidden@example.com'));
});

test('Gmail drains a large history event in bounded batches before advancing history', async () => {
  let historyCalls = 0;
  const api = async url => {
    if (url.includes('/history?')) {
      historyCalls++;
      return { history: [{ messagesAdded: ['one','two','three'].map(id => ({ message: { id } })) }], historyId: '200' };
    }
    const id = new URL(url).pathname.split('/').at(-1);
    return { id, raw: Buffer.from(rawMail).toString('base64url'), labelIds: ['INBOX'] };
  };
  const first = await gmailSync(api, { historyId: '100' }, 2);
  assert.equal(first.messages.length, 2);
  assert.equal(first.cursor.historyId, '100');
  assert.deepEqual(first.cursor.pendingIds, ['three']);
  const second = await gmailSync(api, first.cursor, 2);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].providerId, 'three');
  assert.equal(second.cursor.historyId, '200');
  assert.equal(second.cursor.pendingIds, undefined);
  assert.equal(historyCalls, 1);
});

for (const method of ['REQUEST', 'CANCEL', 'REPLY']) {
  test(`calendar ${method} retains inline text/calendar semantics through provider submission`, async () => {
    const calendar = ['BEGIN:VCALENDAR','VERSION:2.0',`METHOD:${method}`,'BEGIN:VEVENT','UID:event-123@example.com','SEQUENCE:2',
      'DTSTAMP:20260912T120000Z','DTSTART:20260914T120000Z','DTEND:20260914T130000Z','ORGANIZER:mailto:alice@example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:friend@example.com','SUMMARY:Review','END:VEVENT','END:VCALENDAR',''].join('\r\n');
    const mime = ['From: alice@example.com','To: friend@example.com','Subject: Review','MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="calendar-test"','','--calendar-test','Content-Type: text/plain; charset=utf-8','','Meeting update',
      '--calendar-test',`Content-Type: text/calendar; charset=utf-8; method=${method}; name="invite.ics"`,
      'Content-Disposition: inline; filename="invite.ics"','Content-Transfer-Encoding: base64','',Buffer.from(calendar).toString('base64'),'--calendar-test--',''].join('\r\n');
    let submitted;
    const { db, service } = fixture(oauthFetch((_url, init) => {
      submitted = Buffer.from(JSON.parse(init.body).raw, 'base64url');
      return respond({ id: 'calendar-' + method });
    }));
    const account = await connect(service);
    const args = { user, accountId: account.id, message: { to: 'friend@example.com', subject: 'Review', body: 'Meeting update' }, mime,
      idempotencyKey: 'calendar-' + method };
    const result = await service.sendMail(args);
    assert.equal(result.status, 'accepted');
    const parsed = await simpleParser(submitted);
    const event = parsed.attachments.find(a => a.contentType === 'text/calendar');
    assert.ok(event, 'Calendar MIME alternative must survive rebuilding');
    assert.equal(event.headers.get('content-type').params.method.toUpperCase(), method);
    assert.equal(event.contentDisposition || 'inline', 'inline');
    assert.equal(event.content.toString(), calendar);
    assert.equal(parsed.from.value[0].address, 'alice@example.com');
    assert.match(submitted.toString(), /Content-Type: multipart\/alternative/i);
    await assert.rejects(service.sendMail({ ...args, mime: mime.replace(Buffer.from(calendar).toString('base64'), Buffer.from(calendar.replace('SEQUENCE:2','SEQUENCE:3')).toString('base64')) }), { code: 'idempotency_conflict' });
    const conflict = mime.replace(`method=${method}`, `method=${method === 'REQUEST' ? 'CANCEL' : 'REQUEST'}`);
    await assert.rejects(canonicalMime(account, args.message, conflict), { code: 'invalid_calendar_mime' });
    db.close();
  });
}

test('canonical MIME retains HTML and derives readable plain text from the reviewed raw body', async () => {
  const raw = 'From: alice@example.com\r\nTo: friend@example.com\r\nSubject: Rich mail\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <strong>friend</strong></p>';
  const result = await canonicalMime({ email: 'alice@example.com', provider: 'smtp' }, { to: 'friend@example.com', subject: 'Rich mail', body: '<p>Hello <strong>friend</strong></p>' }, raw);
  const parsed = await simpleParser(result.mime);
  assert.match(parsed.html, /<strong>friend<\/strong>/);
  assert.match(parsed.text, /Hello friend/);
  assert.doesNotMatch(parsed.text, /<p>/);
});

test('Graph writeback changes read/flag, moves with immutable IDs, and remaps later references', async () => {
  const calls=[];
  const {db,service}=fixture(oauthFetch((url,init)=>{
    calls.push({url,init});
    assert.match(init.headers.Prefer,/ImmutableId/);
    return respond({id:url.endsWith('/move')?'moved-id':url.split('/').at(-1)});
  }));
  const account=await connect(service,'microsoft');
  const patch={read:true,flagged:true,folder:'archive'};
  const result=await service.updateMessage(user,account.id,'original-id',patch,{idempotencyKey:'mutation-first'});
  assert.deepEqual(result,{status:'applied',providerId:'moved-id',...patch});
  assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(calls[0].init.body),{isRead:true,flag:{flagStatus:'flagged'}});
  assert.deepEqual(JSON.parse(calls[1].init.body),{destinationId:'archive'});
  assert.equal(calls[0].init.method,'PATCH');
  assert.equal(calls[1].init.method,'POST');
  assert.deepEqual(await service.updateMessage(user,account.id,'original-id',patch,{idempotencyKey:'mutation-first'}),result);
  assert.equal(calls.length,2);
  await service.updateMessage(user,account.id,'original-id',{read:false},{idempotencyKey:'mutation-second'});
  assert.ok(calls[2].url.endsWith('/messages/moved-id'));
  const aliases=db.prepare('SELECT * FROM provider_message_aliases ORDER BY alias').all();
  assert.equal(aliases.length,2);
  assert.equal(new Set(aliases.map(a=>a.record_id)).size,1);
  await assert.rejects(service.updateMessage(user,account.id,'original-id',{read:false},{idempotencyKey:'mutation-first'}),{code:'idempotency_conflict'});
  await assert.rejects(service.updateMessage(other,account.id,'original-id',{read:true},{idempotencyKey:'mutation-other'}),{status:404});
  db.close();
});

test('Gmail writeback combines read/star and reversible trash without deleting content', async()=>{
  const calls=[];
  const {db,service}=fixture(oauthFetch((url,init)=>{
    calls.push({url,init});
    return respond({id:'gmail-id',labelIds:['INBOX','UNREAD']});
  }));
  const account=await connect(service);
  const result=await service.updateMessage(user,account.id,'gmail-id',{read:true,flagged:true,folder:'deleted'},{idempotencyKey:'gmail-mutation'});
  assert.equal(result.folder,'deleted');
  assert.equal(calls.length,2);
  assert.equal(calls[0].init.method,undefined);
  assert.ok(calls[1].url.endsWith('/messages/gmail-id/modify'));
  const data=JSON.parse(calls[1].init.body);
  assert.deepEqual(new Set(data.addLabelIds),new Set(['STARRED','TRASH']));
  assert.deepEqual(new Set(data.removeLabelIds),new Set(['UNREAD','INBOX','SPAM']));
  assert.ok(calls.every(call=>call.init.method!=='DELETE'));
  await assert.rejects(service.updateMessage(user,account.id,'gmail-id',{folder:'sent'},{idempotencyKey:'gmail-invalid-folder'}),{code:'provider_mutation_unsupported',unknown:false,retryable:false});
  assert.equal(calls.length,2);
  db.close();
});

test('unknown provider moves block replay and subsequent operations instead of risking duplication',async()=>{
  let writes=0;
  const {db,service}=fixture(oauthFetch(()=>{writes++;throw new Error('response lost');}));
  const account=await connect(service,'microsoft');
  const args=[user,account.id,'graph-id',{folder:'deleted'},{idempotencyKey:'unknown-move'}];
  await assert.rejects(service.updateMessage(...args),{unknown:true,uncertain:true,retryable:false});
  await assert.rejects(service.updateMessage(...args),{code:'provider_mutation_unconfirmed',unknown:true});
  await assert.rejects(service.updateMessage(user,account.id,'graph-id',{read:true},{idempotencyKey:'newer-after-unknown'}),{code:'provider_mutation_unconfirmed',unknown:true});
  assert.equal(writes,1);
  db.close();
});

test('cloud mutations reject read-only grants before any remote mutation',async()=>{
  const {db,service}=fixture(oauthFetch());
  const account=await connect(service);
  const row=service.account(user,account.id),context=`account:${row.owner}:${row.id}:${row.provider}`;
  const secret=unseal(row.encrypted_secret,env,context);
  secret.scope='https://www.googleapis.com/auth/gmail.readonly';
  db.prepare('UPDATE provider_accounts SET encrypted_secret=? WHERE id=?').run(seal(secret,env,context),row.id);
  await assert.rejects(service.updateMessage(user,account.id,'gmail-id',{read:true},{idempotencyKey:'read-only-mutation'}),{code:'provider_reconnect_required',status:409});
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_mutations').get().n,0);
  db.close();
});

test('concurrent provider updates preserve submission order and partial Graph failure stays uncertain',async()=>{
  let releaseFirst, firstStarted;
  const waitFirst=new Promise(resolve=>{firstStarted=resolve;});
  const calls=[];
  const {db,service}=fixture(oauthFetch(async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body)});
    if(calls.length===1){firstStarted();await new Promise(resolve=>{releaseFirst=resolve;});}
    if(url.endsWith('/move'))return respond({error:{code:'ErrorAccessDenied'}},403);
    return respond({id:'stable-id'});
  }));
  const account=await connect(service,'microsoft');
  const first=service.updateMessage(user,account.id,'stable-id',{read:true},{idempotencyKey:'ordered-first'});
  const second=service.updateMessage(user,account.id,'stable-id',{read:false},{idempotencyKey:'ordered-second'});
  await waitFirst;
  assert.equal(calls.length,1);
  releaseFirst();
  await Promise.all([first,second]);
  assert.deepEqual(calls.map(call=>call.body),[{isRead:true},{isRead:false}]);
  await assert.rejects(service.updateMessage(user,account.id,'stable-id',{read:true,folder:'junk'},{idempotencyKey:'partial-mutation'}),{unknown:true,uncertain:true,retryable:false});
  assert.equal(db.prepare('SELECT status FROM provider_mutations WHERE idempotency_key=?').get('partial-mutation').status,'unknown');
  db.close();
});
