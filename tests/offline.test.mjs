import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {OfflineStore, LocalWorkspace, flushQueue, createOfflineTransport} from '../public/offline.js';
const namespace = () => 'test:' + crypto.randomUUID();

test('snapshots and Blob bytes persist after the store is reopened', async () => {
  const name = namespace(), first = new OfflineStore({namespace: name});
  await first.setSnapshot('user:one', {records: [{id: 'message', version: 2}]});
  await first.putBlob('attachment', new Blob(['private attachment'], {type: 'text/plain'}));
  first.close();
  const reopened = new OfflineStore({namespace: name});
  assert.equal((await reopened.getSnapshot('user:one')).records[0].version, 2);
  assert.equal(await (await reopened.getBlob('attachment')).text(), 'private attachment');
  await reopened.clear();
  assert.equal(await reopened.getBlob('attachment'), undefined);
  assert.equal(await reopened.getSnapshot('user:one'), undefined);
  reopened.close();
});

test('concurrent enqueue assigns stable order and duplicate IDs preserve original body', async () => {
  const store = new OfflineStore({namespace: namespace()});
  await Promise.all(Array.from({length: 10}, (_, i) => store.enqueue({id: String(i), method: 'PATCH', path: 'record', body: {version: i}})));
  await store.enqueue({id: '0', method: 'DELETE', path: 'record', body: {version: 999}});
  const queue = await store.pending();
  assert.deepEqual(queue.map(row => row.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(queue[0].body.version, 0);
  assert.equal(queue[0].method, 'PATCH');
  store.close();
});

test('409 retains original edit and blocks dependent operations across restarts', async () => {
  const name = namespace(), store = new OfflineStore({namespace: name});
  await store.enqueue({id: 'edit', method: 'PATCH', path: 'record', body: {id: 'draft', version: 1, patch: {subject: 'My edit'}}, baseVersion: 1});
  await store.enqueue({id: 'send', method: 'POST', path: 'send', body: {id: 'draft', version: 2}});
  let calls = 0;
  const outcomes = await store.flush(async () => { calls++; throw Object.assign(new Error('Changed remotely'), {status: 409}); });
  assert.equal(outcomes[0].status, 'conflict');
  assert.equal(calls, 1);
  store.close();
  const reopened = new OfflineStore({namespace: name});
  const queue = await reopened.pending();
  assert.equal(queue.length, 2);
  assert.equal(queue[0].body.patch.subject, 'My edit');
  assert.equal(queue[0].baseVersion, 1);
  await reopened.flush(async () => { calls++; });
  assert.equal(calls, 1);
  reopened.close();
});

test('network failures retain stable request IDs; successful retry removes only acknowledged operation', async () => {
  const store = new OfflineStore({namespace: namespace()});
  await store.enqueue({id: 'stable-key', method: 'POST', path: 'record', body: {kind: 'task'}});
  await store.flush(async entry => { assert.equal(entry.id, 'stable-key'); throw new TypeError('Offline'); });
  assert.equal((await store.pending())[0].status, 'pending');
  const outcomes = await store.flush(async entry => { assert.equal(entry.id, 'stable-key'); return {id: 'server-task'}; });
  assert.equal(outcomes[0].status, 'synced');
  assert.equal((await store.pending()).length, 0);
  store.close();
});

test('flushQueue treats HTTP conflict responses as unresolved', async () => {
  const kept = [], removed = [];
  const outcomes = await flushQueue([{id: 'a', sequence: 1, status: 'pending', body: {version: 3}}], async () => Response.json({error: 'Conflict'}, {status: 409}), row => kept.push(row), id => removed.push(id));
  assert.equal(outcomes[0].status, 'conflict');
  assert.equal(kept[0].body.version, 3);
  assert.equal(removed.length, 0);
});

test('connected transport requires isolated cache identity', () => {
  assert.throws(() => createOfflineTransport({apiBase: '/api'}), /user-specific namespace/);
});

test('device-local workspace survives reload and detects cross-tab version conflicts', async () => {
  const name = namespace(), one = new LocalWorkspace({namespace: name}), two = new LocalWorkspace({namespace: name});
  try {
    const initial = await one.call('data');
    assert.equal(initial.mode, 'device-local'); assert.equal(initial.live, false); assert.ok(initial.records.length > 20);
    const task = await one.call('record', {method: 'POST', body: {kind: 'task', data: {title: 'Persist this', done: false}}});
    await two.call('record', {method: 'PATCH', body: {id: task.id, version: task.version, patch: {done: true}}});
    await assert.rejects(one.call('record', {method: 'PATCH', body: {id: task.id, version: task.version, patch: {title: 'Stale edit'}}}), cause => cause.status === 409);
    const current = (await one.call('data')).records.find(row => row.id === task.id);
    assert.equal(current.title, 'Persist this'); assert.equal(current.done, true); assert.equal(current.version, 2);
  } finally { one.close(); two.close(); }
});

test('local external send preserves draft; self-send creates explicit device-local delivery', async () => {
  const local = new LocalWorkspace({namespace: namespace()});
  try {
    const draft = await local.call('record', {method: 'POST', body: {kind: 'message', data: {folder: 'drafts', date: new Date().toISOString(), to: 'someone@example.com', subject: 'Still a draft', body: '<p>Hello</p>'}}});
    await assert.rejects(local.call('send', {method: 'POST', body: {id: draft.id, version: 1}}), cause => cause.status === 409);
    assert.equal((await local.call('data')).records.find(row => row.id === draft.id).folder, 'drafts');
    const edited = await local.call('record', {method: 'PATCH', body: {id: draft.id, version: 1, patch: {to: 'you@avenor.local'}}});
    const sent = await local.call('send', {method: 'POST', body: {id: draft.id, version: edited.version}});
    assert.equal(sent.delivery, 'device-local'); assert.equal(sent.folder, 'sent');
    const inbox = (await local.call('data')).records.find(row => row.subject === 'Still a draft' && row.folder === 'inbox');
    assert.ok(inbox); assert.equal(inbox.read, false);
  } finally { local.close(); }
});

test('local upload persists real bytes and validates attachment references', async () => {
  const local = new LocalWorkspace({namespace: namespace()});
  try {
    const upload = await local.call('upload', {method: 'POST', body: {file: new Blob(['test attachment']), scope: local.scope}});
    assert.equal(await (await local.getFile(upload.id)).text(), 'test attachment');
    await assert.rejects(local.call('record', {method: 'POST', body: {kind: 'message', data: {folder: 'drafts', attachments: [{id: 'missing'}]}}}), cause => cause.status === 403);
  } finally { local.close(); }
});

test('transport retry keeps idempotency key and never reports queued sends as sent', async t => {
  const transport = createOfflineTransport({apiBase: 'https://api.example.test/api', namespace: namespace()});
  const keys = [];
  let online = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (!online) throw new TypeError('Disconnected');
    return Response.json({id: 'draft-1', folder: 'sent', delivery: 'internal'});
  });
  try {
    const pending = await transport.call('send', {method: 'POST', body: JSON.stringify({id: 'draft-1', version: 2})});
    assert.equal(pending.queued, true); assert.equal(pending.delivery, 'pending'); assert.equal(pending.folder, undefined);
    online = true;
    const outcomes = await transport.flush();
    assert.equal(outcomes[0].status, 'synced'); assert.equal(keys[0], keys[1]);
  } finally { transport.store.close(); }
});

test('transport cannot reveal cached data after authentication failure', async t => {
  const transport = createOfflineTransport({apiBase: 'https://api.example.test/api', namespace: namespace()});
  await transport.store.setSnapshot('data', {records: [{id: 'private'}]});
  t.mock.method(globalThis, 'fetch', async () => Response.json({error: 'Sign in'}, {status: 401}));
  try { await assert.rejects(transport.call('data'), cause => cause.status === 401); }
  finally { transport.store.close(); }
});

test('explicit conflict resolution preserves order with a fresh idempotency key', async () => {
  const store = new OfflineStore({namespace: namespace()});
  try {
    await store.enqueue({id: 'old-key', method: 'PATCH', path: 'record', body: {id: 'record', version: 1, patch: {title: 'Mine'}}});
    await store.flush(async () => { throw Object.assign(new Error('Changed'), {status: 409}); });
    await store.resolveConflict('old-key', {body: {id: 'record', version: 3, patch: {title: 'Reviewed merge'}}, baseVersion: 3});
    const queue = await store.pending();
    assert.equal(queue.length, 1); assert.notEqual(queue[0].id, 'old-key'); assert.equal(queue[0].sequence, 1);
    assert.equal(queue[0].status, 'pending'); assert.equal(queue[0].body.version, 3);
  } finally { store.close(); }
});

test('local cursor pagination visits every record exactly once', async () => {
  const local = new LocalWorkspace({namespace: namespace()});
  try {
    await local.open();
    await local.store.updateSnapshot('local-state', state => ({value: {...state, records: Array.from({length: 1050}, (_, index) => ({id: 'row:' + index, scope: local.scope, kind: 'task', title: String(index), version: 1}))}, result: null}));
    const found = []; let cursor = '';
    do { const page = await local.call('data?cursor=' + encodeURIComponent(cursor)); found.push(...page.records.map(row => row.id)); cursor = page.nextCursor; } while (cursor);
    assert.equal(found.length, 1050); assert.equal(new Set(found).size, 1050);
  } finally { local.close(); }
});

test('self-send from local team copies attachment bytes into the personal scope', async () => {
  const local = new LocalWorkspace({namespace: namespace()});
  try {
    const team = await local.call('team', {method: 'POST', body: {action: 'create', name: 'Local project'}}), scope = 'team:' + team.id;
    const file = await local.call('upload', {method: 'POST', body: {file: new Blob(['team attachment']), scope}});
    const draft = await local.call('record', {method: 'POST', body: {kind: 'message', scope, data: {folder: 'drafts', date: new Date().toISOString(), to: 'you@avenor.local', subject: 'Team self test', attachments: [file]}}});
    await local.call('send', {method: 'POST', body: {id: draft.id, version: draft.version}});
    const inbox = (await local.call('data')).records.find(row => row.subject === 'Team self test');
    assert.ok(inbox); assert.notEqual(inbox.attachments[0].id, file.id);
    assert.equal(await (await local.getFile(inbox.attachments[0].id)).text(), 'team attachment');
    const read = await local.call('record', {method: 'PATCH', body: {id: inbox.id, version: inbox.version, patch: {read: true}}});
    assert.equal(read.read, true);
  } finally { local.close(); }
});

test('cache quota failure cannot replace a fresh server response with stale data', async t => {
  const statuses = [], transport = createOfflineTransport({apiBase: 'https://api.example.test/api', namespace: namespace(), onStatus: status => statuses.push(status)});
  await transport.store.setSnapshot('data', {records: [{id: 'record', version: 1}]});
  t.mock.method(globalThis, 'fetch', async () => Response.json({records: [{id: 'record', version: 2}]}));
  t.mock.method(transport.store, 'setSnapshot', async () => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  try {
    const data = await transport.call('data');
    assert.equal(data.records[0].version, 2); assert.equal(data.offline, undefined);
    assert.equal(statuses.at(-1).status, 'storage-error');
  } finally { transport.store.close(); }
});
