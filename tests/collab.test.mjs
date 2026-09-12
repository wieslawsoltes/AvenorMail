import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { prosemirrorToYDoc } from 'y-prosemirror';
import { schema } from 'prosemirror-schema-basic';
import { RealtimeHub, collaborationDocumentHTML, LIVE_LIMITS } from '../backend/realtime.js';

const encode = bytes => Buffer.from(bytes).toString('base64');
const decode = value => Buffer.from(value, 'base64');
const initial = (text = 'Hello world') => prosemirrorToYDoc(schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]), 'prosemirror');
const text = doc => doc.getXmlFragment('prosemirror').get(0).get(0);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'avenor-collaboration-'));
  const filename = join(directory, 'live.sqlite');
  const sessions = new Map([['alice', { userId: 'alice', displayName: 'Alice' }], ['bob', { userId: 'bob', displayName: 'Bob' }], ['viewer', { userId: 'viewer', displayName: 'Viewer' }]]);
  const revoked = new Set();
  const locked = new Set();
  let db, server, hub;
  const sockets = new Set();
  const start = async () => {
    db = new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL');
    hub = new RealtimeHub({
      db,
      allowedOrigins: ['http://localhost:3000'],
      authenticate: request => sessions.get(request.headers.authorization?.slice(7)) || null,
      authorize: ({ user, scope, recordId, action }) => !revoked.has(user.userId) && ['team:a', 'team:b'].includes(scope) && (action !== 'write' || (user.userId !== 'viewer' && !locked.has(recordId))),
    }).migrate();
    server = createServer((_req, response) => response.end('ok'));
    hub.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  };
  const stop = async () => {
    await hub.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
  };
  await start();
  const client = async (token = 'alice') => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://localhost:3000' });
    sockets.add(socket);
    const backlog = [], waiters = [];
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      const index = waiters.findIndex(waiter => waiter.filter(message));
      if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else backlog.push(message);
    });
    socket.on('error', () => {});
    const receive = (type, filter = () => true) => {
      const matcher = message => message.type === type && filter(message);
      const index = backlog.findIndex(matcher);
      if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { filter: matcher, resolve, timer: null };
        waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(backlog)}`)); }, 2500);
        waiters.push(waiter);
      });
    };
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const send = message => socket.send(JSON.stringify(message));
    send({ type: 'auth', token });
    if (sessions.has(token)) await receive('ready');
    return { socket, send, receive, backlog };
  };
  t.after(async () => { for (const socket of sockets) socket.terminate(); await stop(); await rm(directory, { recursive: true, force: true }); });
  return { client, sessions, revoked, locked, get db() { return db; }, get hub() { return hub; }, get port() { return server.address().port; }, restart: async () => { await stop(); await start(); } };
}

async function joinRoom(client, { scope = 'team:a', recordId = 'draft1', seed } = {}) {
  client.send({ type: 'join', scope, recordId, initialUpdate: seed ? encode(Y.encodeStateAsUpdate(seed)) : undefined });
  return client.receive('joined', message => message.recordId === recordId);
}

test('concurrent character insertions and deletion converge without overwriting rich text', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice'), bob = await f.client('bob');
  const seed = initial();
  seed.transact(() => text(seed).format(0, 5, { strong: {} }));
  const joinedA = await joinRoom(alice, { seed });
  const joinedB = await joinRoom(bob);
  const a = new Y.Doc(), b = new Y.Doc();
  Y.applyUpdate(a, decode(joinedA.state));
  Y.applyUpdate(b, decode(joinedB.state));
  const aVector = Y.encodeStateVector(a), bVector = Y.encodeStateVector(b);
  text(a).insert(5, ' Alice');
  b.transact(() => { text(b).delete(6, 5); text(b).insert(6, 'Bob'); });
  const aUpdate = Y.encodeStateAsUpdate(a, aVector), bUpdate = Y.encodeStateAsUpdate(b, bVector);
  alice.send({ type: 'update', scope: 'team:a', recordId: 'draft1', requestId: 'a1', update: encode(aUpdate) });
  bob.send({ type: 'update', scope: 'team:a', recordId: 'draft1', requestId: 'b1', update: encode(bUpdate) });
  await Promise.all([alice.receive('ack'), bob.receive('ack')]);
  Y.applyUpdate(a, decode((await alice.receive('update')).update));
  Y.applyUpdate(b, decode((await bob.receive('update')).update));
  assert.equal(text(a).toDelta().map(run => run.insert).join(''), 'Hello Alice Bob');
  assert.equal(text(a).toString(), text(b).toString());
  assert.deepEqual(text(a).toDelta(), text(b).toDelta());
  assert.match(collaborationDocumentHTML(f.db, 'draft1'), /<strong>Hello/);
  assert.match(collaborationDocumentHTML(f.db, 'draft1'), /Bob/);
  a.destroy(); b.destroy(); seed.destroy();
});

test('durable acknowledged document is restored after hub and SQLite restart', async t => {
  const f = await fixture(t), a = await f.client();
  const seed = initial('Persist me');
  const joined = await joinRoom(a, { seed });
  const doc = new Y.Doc(); Y.applyUpdate(doc, decode(joined.state));
  const vector = Y.encodeStateVector(doc);
  text(doc).insert(text(doc).length, ' across restart');
  a.send({ type: 'update', scope: 'team:a', recordId: 'draft1', requestId: 'save', update: encode(Y.encodeStateAsUpdate(doc, vector)) });
  const ack = await a.receive('ack');
  assert.equal(ack.revision, 2);
  assert.equal(collaborationDocumentHTML(f.db, 'draft1'), '<p>Persist me across restart</p>');
  await f.restart();
  const next = await f.client('bob');
  const restored = await joinRoom(next);
  const restoredDoc = new Y.Doc(); Y.applyUpdate(restoredDoc, decode(restored.state));
  assert.equal(text(restoredDoc).toString(), text(doc).toString());
  assert.equal(restored.revision, 2);
  doc.destroy(); restoredDoc.destroy(); seed.destroy();
});

test('read-only joins cannot update and sending can lock an already-open editor', async t => {
  const f = await fixture(t), writer = await f.client(), viewer = await f.client('viewer');
  const seed = initial();
  await joinRoom(writer, { seed });
  assert.equal((await joinRoom(viewer)).readOnly, true);
  const bytes = encode(Y.encodeStateAsUpdate(seed));
  viewer.send({ type: 'update', scope: 'team:a', recordId: 'draft1', update: bytes });
  assert.equal((await viewer.receive('error')).code, 'READ_ONLY');
  f.locked.add('draft1');
  writer.send({ type: 'update', scope: 'team:a', recordId: 'draft1', update: bytes });
  assert.equal((await writer.receive('error')).code, 'READ_ONLY');
  assert.equal(f.db.prepare('SELECT revision FROM collaboration_documents').get().revision, 1);
  seed.destroy();
});

test('session and membership revocation are enforced before broadcasts and subsequent writes', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client('bob');
  const seed = initial();
  await joinRoom(a, { seed }); await joinRoom(b);
  f.revoked.add('bob');
  await f.hub.publish('team:a', { type: 'record.updated', recordId: 'draft1', title: 'Secret next value' });
  await b.receive('revoked');
  assert.equal(b.backlog.some(message => message.type === 'change'), false);
  b.send({ type: 'update', scope: 'team:a', recordId: 'draft1', update: encode(Y.encodeStateAsUpdate(seed)) });
  assert.equal((await b.receive('error')).code, 'FORBIDDEN');
  const close = new Promise(resolve => a.socket.once('close', code => resolve(code)));
  f.sessions.delete('alice');
  await f.hub.sweep();
  assert.equal(await close, 4401);
  seed.destroy();
});

test('document workspace cannot be changed by a member of both workspaces', async t => {
  const f = await fixture(t), a = await f.client();
  const seed = initial();
  await joinRoom(a, { seed });
  a.send({ type: 'join', scope: 'team:b', recordId: 'draft1', initialUpdate: encode(Y.encodeStateAsUpdate(seed)) });
  assert.equal((await a.receive('error')).code, 'SCOPE_MISMATCH');
  assert.equal(f.db.prepare('SELECT scope FROM collaboration_documents').get().scope, 'team:a');
  seed.destroy();
});

test('malformed, oversized and foreign-root CRDT updates do not alter stored content', async t => {
  const f = await fixture(t), a = await f.client();
  const seed = initial();
  await joinRoom(a, { seed });
  for (const update of ['!!!', encode(Buffer.from([255, 255, 255])), encode(Buffer.alloc(LIVE_LIMITS.update + 1))]) {
    a.send({ type: 'update', scope: 'team:a', recordId: 'draft1', update });
    assert.equal((await a.receive('error')).code, 'BAD_UPDATE');
  }
  const foreign = new Y.Doc(); foreign.getText('another-root').insert(0, 'bad');
  a.send({ type: 'update', scope: 'team:a', recordId: 'draft1', update: encode(Y.encodeStateAsUpdate(foreign)) });
  assert.equal((await a.receive('error')).code, 'BAD_DOCUMENT');
  assert.equal(collaborationDocumentHTML(f.db, 'draft1'), '<p>Hello world</p>');
  assert.equal(f.db.prepare('SELECT revision FROM collaboration_documents').get().revision, 1);
  foreign.destroy(); seed.destroy();
});

test('record changes are scoped and presence identifies authenticated users', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client('bob');
  a.send({ type: 'subscribe', scope: 'team:a' }); b.send({ type: 'subscribe', scope: 'team:b' });
  await Promise.all([a.receive('subscribed'), b.receive('subscribed')]);
  await f.hub.publish('team:a', { type: 'record.updated', recordId: 'draft1' });
  assert.equal((await a.receive('change')).scope, 'team:a');
  assert.equal(b.backlog.some(message => message.type === 'change'), false);
  const seed = initial(); await joinRoom(a, { seed }); await joinRoom(b);
  b.send({ type: 'presence', scope: 'team:a', recordId: 'draft1', selection: { cursor: null }, displayName: 'Impersonated Alice' });
  const presence = await a.receive('presence', message => message.participants.length === 2);
  assert.deepEqual(presence.participants.map(user => user.displayName).sort(), ['Alice', 'Bob']);
  seed.destroy();
});

test('upgrade rejects untrusted origins, omitted origins and credentials in URL', async t => {
  const f = await fixture(t);
  for (const [origin, suffix] of [['http://evil.example', ''], [undefined, ''], ['http://localhost:3000', '?token=alice']]) {
    const response = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${f.port}/api/live${suffix}`, origin ? { origin } : {});
      socket.on('unexpected-response', (_request, response) => { resolve(response.statusCode); response.resume(); socket.terminate(); });
      socket.on('open', () => { socket.terminate(); reject(new Error('Untrusted socket accepted')); });
      socket.on('error', () => {});
    });
    assert.equal(response, 403);
  }
});

test('an authorization pending during disconnect or shutdown cannot revive a room', async t => {
  const f = await fixture(t);
  for (const shutdown of [false, true]) {
    const a = await f.client();
    const serverClient = [...f.hub.clients].find(client => client.user?.userId === 'alice');
    let entered, release;
    const began = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const authenticate = f.hub.authenticate;
    f.hub.authenticate = async request => { entered(); await blocked; return authenticate(request); };
    a.send({ type: 'join', scope: 'team:a', recordId: shutdown ? 'shutdown-draft' : 'disconnect-draft' });
    await began;
    if (shutdown) await f.hub.close();
    else { a.socket.terminate(); await new Promise(resolve => serverClient.ws.once('close', resolve)); }
    release();
    await serverClient.chain;
    assert.equal(serverClient.rooms.size, 0);
    assert.equal(f.hub.rooms.size, 0);
    f.hub.authenticate = authenticate;
  }
});
