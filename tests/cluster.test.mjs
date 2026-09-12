import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RemoteDatabase } from '../backend/remote-db.js';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { prosemirrorToYDoc } from 'y-prosemirror';
import { schema } from 'prosemirror-schema-basic';
import { ClusterCoordinator } from '../backend/cluster.js';
import { RealtimeHub, collaborationDocumentHTML } from '../backend/realtime.js';

const seed = text => prosemirrorToYDoc(schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]), 'prosemirror');
const content = doc => doc.getXmlFragment('prosemirror').get(0).get(0);
const encode = value => Buffer.from(value).toString('base64');
const until = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for cluster state'); await new Promise(resolve => setTimeout(resolve, 5)); } };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'avenor-cluster-'));
  const filename = join(directory, 'cluster.sqlite');
  const a = new DatabaseSync(filename), b = new DatabaseSync(filename);
  a.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000'); b.exec('PRAGMA busy_timeout=5000');
  a.exec('CREATE TABLE members(team TEXT,user TEXT,role TEXT,seen INTEGER,PRIMARY KEY(team,user)); CREATE TABLE records(id TEXT PRIMARY KEY,scope TEXT,version INTEGER,deleted INTEGER); CREATE TABLE delegations(scope TEXT,user_id TEXT,permissions TEXT,PRIMARY KEY(scope,user_id)); CREATE TABLE auth_sessions(hash TEXT PRIMARY KEY,user_id TEXT,expires INTEGER)');
  const first = new ClusterCoordinator({ db: a, nodeId: 'first', pollMs: 60000 }).migrate();
  const second = new ClusterCoordinator({ db: b, nodeId: 'second', pollMs: 60000 }).migrate();
  const cleanup = [];
  t.after(async () => { for (const callback of cleanup.reverse()) await callback(); await first.stop(); await second.stop(); a.close(); b.close(); await rm(directory, { recursive: true, force: true }); });
  return { a, b, first, second, cleanup };
}

test('shared durable event log includes writes committed by another connection and resumes its cursor', async t => {
  const f = await fixture(t), events = [];
  f.first.start(() => {}); f.second.start(event => events.push(event));
  f.a.prepare('INSERT INTO records VALUES (?,?,?,?)').run('draft', 'team:mail', 1, 0);
  f.first.publish('team:mail', { type: 'notification-change', recordId: 'draft' });
  await f.second.poll();
  assert.deepEqual(events.map(value => value.event.type), ['record-change', 'notification-change']);
  assert.ok(events[0].id < events[1].id);
  assert.equal(events[0].scope, 'team:mail');
  assert.equal(events[1].nodeId, 'first');
  const cursor = f.second.cursor;
  await f.second.stop();
  f.a.prepare('UPDATE records SET version=2 WHERE id=?').run('draft');
  f.second.start(event => events.push(event));
  assert.equal(f.second.cursor, cursor);
  await f.second.poll();
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).event.version, 2);
  assert.equal(f.second.status().nodes.length, 2);
});

test('leases exclude other workers, increase fencing tokens after expiry, and reject stale renew/release', async t => {
  const f = await fixture(t);
  const firstLease = f.first.acquire('provider:one', { ttl: 1000 });
  assert.throws(() => f.second.acquire('provider:one'), error => error.status === 409 && error.code === 'LEASE_HELD');
  firstLease.renew();
  f.b.prepare('UPDATE cluster_leases SET expires=0 WHERE lease_key=?').run('provider:one');
  const nextLease = f.second.acquire('provider:one');
  assert.ok(nextLease.token > firstLease.token);
  assert.throws(() => firstLease.renew(), error => error.code === 'LEASE_LOST');
  assert.equal(firstLease.signal.aborted, true);
  firstLease.release();
  assert.equal(nextLease.assert(), nextLease.token, 'A stale release must not erase the replacement lease');
  nextLease.release();
  const value = await f.first.withLease('provider:one', async lease => { assert.equal(lease.assert(), lease.token); return 42; });
  assert.equal(value, 42);
  assert.equal(f.first.status().activeLeases, 0);
});

test('withLease rejects a callback result after fencing ownership was replaced', async t => {
  const f = await fixture(t);
  let replacement;
  await assert.rejects(f.first.withLease('job:1', async lease => {
    f.b.prepare('UPDATE cluster_leases SET expires=0 WHERE lease_key=?').run(lease.key);
    replacement = f.second.acquire(lease.key);
    return 'stale-success';
  }), error => error.code === 'LEASE_LOST');
  assert.equal(replacement.assert(), replacement.token);
  replacement.release();
});

test('active duplicate node identities are rejected and failed consumers do not advance the cursor', async t => {
  const f = await fixture(t);
  f.first.start(() => {});
  const duplicate = new ClusterCoordinator({ db: f.b, nodeId: 'first' }).migrate();
  assert.throws(() => duplicate.start(() => {}), error => error.code === 'NODE_ACTIVE');
  let fail = true, delivered = 0;
  f.second.start(() => { if (fail) throw new Error('temporary'); delivered++; });
  const before = f.second.cursor;
  f.first.publish('team:a', { type: 'work' });
  await assert.rejects(f.second.poll(), /temporary/);
  assert.equal(f.second.cursor, before);
  fail = false; await f.second.poll();
  assert.equal(delivered, 1);
});

async function hubFixture(t) {
  const f = await fixture(t);
  f.a.prepare('INSERT INTO members VALUES (?,?,?,0)').run('mail', 'alice', 'editor');
  f.a.prepare('INSERT INTO members VALUES (?,?,?,0)').run('mail', 'bob', 'editor');
  const allowed = (db, { user, scope, action }) => scope === 'team:mail' && Boolean(db.prepare('SELECT role FROM members WHERE team=? AND user=?').get('mail', user.userId)) && (action !== 'write' || db.prepare('SELECT role FROM members WHERE team=? AND user=?').get('mail', user.userId)?.role === 'editor');
  const make = async (db, coordinator) => {
    const hub = new RealtimeHub({ db, coordinator, allowedOrigins: ['https://mail.example.test'], authenticate: request => ({ userId: request.headers.authorization.slice(7), displayName: request.headers.authorization.slice(7) }), authorize: args => allowed(db, args), authorizeWrite: args => allowed(db, args) }).migrate();
    const server = createServer(); hub.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    coordinator.start(event => hub.receiveClusterEvent(event));
    f.cleanup.push(async () => { await hub.close(); await new Promise(resolve => server.close(resolve)); });
    return { hub, server };
  };
  const firstHub = await make(f.a, f.first), secondHub = await make(f.b, f.second);
  const client = async (host, user) => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.server.address().port}/api/live`, { origin: 'https://mail.example.test' });
    const messages = [], doc = new Y.Doc();
    ws.on('message', data => { const message = JSON.parse(data); messages.push(message); if (message.type === 'joined') Y.applyUpdate(doc, Buffer.from(message.state, 'base64')); if (message.type === 'update') Y.applyUpdate(doc, Buffer.from(message.update, 'base64')); });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = message => ws.send(JSON.stringify(message));
    send({ type: 'auth', token: user }); await until(() => messages.some(message => message.type === 'ready'));
    f.cleanup.push(() => { ws.terminate(); doc.destroy(); });
    return { ws, doc, messages, send };
  };
  return { ...f, firstHub, secondHub, client };
}

test('independent hubs merge concurrent edits from stale rooms without lost writes and share presence', async t => {
  const f = await hubFixture(t);
  const alice = await f.client(f.firstHub, 'alice'), bob = await f.client(f.secondHub, 'bob');
  const initial = seed('Hello');
  alice.send({ type: 'join', scope: 'team:mail', recordId: 'draft', initialUpdate: encode(Y.encodeStateAsUpdate(initial)) });
  await until(() => alice.messages.some(message => message.type === 'joined'));
  bob.send({ type: 'join', scope: 'team:mail', recordId: 'draft', initialUpdate: encode(Y.encodeStateAsUpdate(initial)) });
  await until(() => bob.messages.some(message => message.type === 'joined'));
  const leftVector = Y.encodeStateVector(alice.doc), rightVector = Y.encodeStateVector(bob.doc);
  content(alice.doc).insert(5, ' Alice'); content(bob.doc).insert(5, ' Bob');
  alice.send({ type: 'update', scope: 'team:mail', recordId: 'draft', requestId: 'alice:1', update: encode(Y.encodeStateAsUpdate(alice.doc, leftVector)) });
  bob.send({ type: 'update', scope: 'team:mail', recordId: 'draft', requestId: 'bob:1', update: encode(Y.encodeStateAsUpdate(bob.doc, rightVector)) });
  await until(() => alice.messages.some(message => message.type === 'ack') && bob.messages.some(message => message.type === 'ack'));
  const stored = collaborationDocumentHTML(f.a, 'draft');
  assert.match(stored, /Alice/); assert.match(stored, /Bob/);
  assert.equal(f.a.prepare('SELECT revision FROM collaboration_documents WHERE record_id=?').get('draft').revision, 3);
  await Promise.all([f.first.poll(), f.second.poll()]);
  await until(() => content(alice.doc).toString() === content(bob.doc).toString());
  assert.match(content(alice.doc).toString(), /Alice/); assert.match(content(alice.doc).toString(), /Bob/);
  await until(() => alice.messages.some(message => message.type === 'presence' && message.participants.length === 2));
  const presence = alice.messages.filter(message => message.type === 'presence').at(-1);
  assert.deepEqual(presence.participants.map(person => person.userId).sort(), ['alice', 'bob']);
  initial.destroy();
});

test('competing first seeds initialize exactly once and cached joins refresh from the shared database', async t => {
  const f = await hubFixture(t);
  const left = f.firstHub.hub.room('seed-race', 'team:mail'), right = f.secondHub.hub.room('seed-race', 'team:mail');
  const one = seed('First'), two = seed('Different second seed');
  f.firstHub.hub.persist(left, Y.encodeStateAsUpdate(one), { initialize: true });
  f.secondHub.hub.persist(right, Y.encodeStateAsUpdate(two), { initialize: true });
  assert.equal(collaborationDocumentHTML(f.a, 'seed-race'), '<p>First</p>');
  assert.equal(right.revision, 1);
  assert.equal(right.seedAccepted, false);
  assert.equal(content(right.doc).toString(), 'First');
  one.destroy(); two.destroy();
});

test('cross-node membership changes revoke remote sockets and expired-node presence disappears', async t => {
  const f = await hubFixture(t);
  const alice = await f.client(f.firstHub, 'alice'), bob = await f.client(f.secondHub, 'bob'), initial = seed('Private');
  for (const client of [alice, bob]) { client.send({ type: 'join', scope: 'team:mail', recordId: 'draft', initialUpdate: encode(Y.encodeStateAsUpdate(initial)) }); await until(() => client.messages.some(message => message.type === 'joined')); }
  await Promise.all([f.first.poll(), f.second.poll()]);
  f.a.prepare('DELETE FROM members WHERE user=?').run('bob');
  await f.second.poll();
  await until(() => bob.messages.some(message => message.type === 'revoked'));
  assert.equal(f.b.prepare('SELECT COUNT(*) AS count FROM collaboration_presence WHERE user_id=?').get('bob').count, 0);
  const count = bob.messages.filter(message => message.type === 'update').length;
  f.firstHub.hub.persist(f.firstHub.hub.rooms.get('draft'), Y.encodeStateAsUpdate(initial));
  await Promise.all([f.first.poll(), f.second.poll()]);
  assert.equal(bob.messages.filter(message => message.type === 'update').length, count);
  f.a.prepare('INSERT INTO collaboration_presence VALUES (?,?,?,?,?,?,?,?)').run('dead', 'draft', 'dead-node', 'team:mail', 'gone', 'Gone', null, 0);
  await f.firstHub.hub.sweep();
  assert.equal(f.a.prepare('SELECT COUNT(*) AS count FROM collaboration_presence WHERE node_id=?').get('dead-node').count, 0);
  initial.destroy();
});

test('transactional write authorization rejects a change after the earlier asynchronous authorization passed', async t => {
  const f = await hubFixture(t);
  const room = f.firstHub.hub.room('guarded', 'team:mail'), initial = seed('Authorized');
  assert.throws(() => f.firstHub.hub.persist(room, Y.encodeStateAsUpdate(initial), { initialize: true, guard: () => false }), error => error.code === 'READ_ONLY');
  assert.equal(f.a.prepare('SELECT * FROM collaboration_documents WHERE record_id=?').get('guarded'), undefined);
  f.firstHub.hub.persist(room, Y.encodeStateAsUpdate(initial), { initialize: true, guard: () => true });
  const changed = new Y.Doc(); Y.applyUpdate(changed, Y.encodeStateAsUpdate(initial)); content(changed).insert(0, 'Rejected ');
  assert.throws(() => f.firstHub.hub.persist(room, Y.encodeStateAsUpdate(changed), { guard: () => false }), error => error.code === 'READ_ONLY');
  assert.equal(collaborationDocumentHTML(f.a, 'guarded'), '<p>Authorized</p>');
  assert.throws(() => f.firstHub.hub.persist(room, Y.encodeStateAsUpdate(changed), { guard: async () => true }), error => error.code === 'BAD_CONFIGURATION');
  initial.destroy(); changed.destroy();
});


test('cluster transactions, triggers and CRDT merge operate through the libSQL worker facade', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'avenor-cluster-libsql-'));
  const url = pathToFileURL(join(directory, 'shared.db')).href;
  const first = new RemoteDatabase({ url }), second = new RemoteDatabase({ url });
  const left = new ClusterCoordinator({ db: first, nodeId: 'libsql-left', pollMs: 60000 }).migrate();
  const right = new ClusterCoordinator({ db: second, nodeId: 'libsql-right', pollMs: 60000 }).migrate();
  const leftHub = new RealtimeHub({ db: first, coordinator: left, authenticate: () => ({}), authorize: () => true }).migrate();
  const rightHub = new RealtimeHub({ db: second, coordinator: right, authenticate: () => ({}), authorize: () => true }).migrate();
  t.after(async () => { await leftHub.close(); await rightHub.close(); await left.stop(); await right.stop(); first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const events = [];
  left.start(() => {}); right.start(event => events.push(event));
  const initial = seed('Shared');
  const leftRoom = leftHub.room('doc', 'team:mail');
  leftHub.persist(leftRoom, Y.encodeStateAsUpdate(initial), { initialize: true });
  const rightRoom = rightHub.room('doc', 'team:mail');
  const a = new Y.Doc(), b = new Y.Doc();
  Y.applyUpdate(a, Y.encodeStateAsUpdate(initial)); Y.applyUpdate(b, Y.encodeStateAsUpdate(initial));
  const vector = Y.encodeStateVector(initial);
  content(a).insert(6, ' left'); content(b).insert(6, ' right');
  leftHub.persist(leftRoom, Y.encodeStateAsUpdate(a, vector));
  rightHub.persist(rightRoom, Y.encodeStateAsUpdate(b, vector));
  const html = collaborationDocumentHTML(first, 'doc');
  assert.match(html, /left/); assert.match(html, /right/);
  await right.poll();
  assert.equal(events.filter(value => value.event.type === 'collaboration.updated').length, 3);
  const lease = left.acquire('exclusive');
  assert.throws(() => right.acquire('exclusive'), error => error.code === 'LEASE_HELD');
  lease.release();
  initial.destroy(); a.destroy(); b.destroy();
});
