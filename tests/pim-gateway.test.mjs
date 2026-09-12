import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PimGateway } from '../backend/pim-sync.js';
import { ClusterCoordinator } from '../backend/cluster.js';

function fixture(t, { compliance, coordinator: clustered = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records(id TEXT PRIMARY KEY,owner TEXT,scope TEXT,kind TEXT,data TEXT,version INTEGER,updated INTEGER,deleted INTEGER DEFAULT 0)');
  const user = { userId: 'alice' }, accountId = 'account-one';
  let writes = 0, resolutions = 0, acknowledgments = 0;
  const service = {
    migrate() {},
    conflicts: [], batch: [],
    status() { return { collections: [], conflicts: this.conflicts }; },
    async syncAccount() { return this.batch; },
    acknowledgeSync() { acknowledgments++; },
    async writeRecord({ record, method }) { writes++; return { ...record, providerId: 'provider-one', etag: 'accepted-etag', ...(method === 'delete' ? { deleted: true } : {}) }; },
    async resolveConflict({ recordId }) { resolutions++; return { id: recordId, kind: 'event', accountId, title: 'Provider chosen', providerId: 'provider-one', etag: 'remote-etag' }; },
  };
  const providers = { account(who, id) { if (who.userId !== 'alice' || id !== accountId) throw Object.assign(new Error('Forbidden'), { status: 403 }); return { id, owner: who.userId }; } };
  const coordinator = clustered ? new ClusterCoordinator({ db, nodeId: 'node-one' }).migrate() : null;
  const gateway = new PimGateway({ db, providers, service, env: {}, emit() {}, permissions: { async require() {} }, coordinator, compliance });
  const put = (title = 'Original', id = 'event-one') => {
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,1,0,0)').run(id, 'alice', 'user:alice', 'event', JSON.stringify({ title, accountId, providerId: 'provider-one', etag: 'old-etag' }));
  };
  const change = (title, id = 'event-one') => db.prepare('UPDATE records SET data=json_set(data,\'$.title\',?),version=version+1 WHERE id=?').run(title, id);
  const read = id => { const row = db.prepare('SELECT * FROM records WHERE id=?').get(id || 'event-one'); return row ? { ...JSON.parse(row.data), id: row.id, kind: row.kind, version: row.version, deleted: !!row.deleted } : null; };
  t.after(async () => { await coordinator?.stop(); db.close(); });
  return { db, user, accountId, gateway, service, providers, coordinator, put, change, read, get writes() { return writes; }, get resolutions() { return resolutions; }, get acknowledgments() { return acknowledgments; } };
}

const write = (f, overrides = {}) => f.gateway.write({ user: f.user, accountId: f.accountId, kind: 'event', record: { ...f.read(), title: 'Submitted' }, method: 'update', version: 1, key: 'write-operation-1', ...overrides });

async function createLocalConflict(f) {
  const original = f.service.writeRecord.bind(f.service);
  f.service.writeRecord = async args => { const accepted = await original(args); f.change('Concurrent local'); return accepted; };
  await assert.rejects(write(f), error => error.code === 'pim_local_conflict');
  f.service.writeRecord = original;
  return f.gateway.status(f.user, f.accountId).localConflicts[0];
}

test('provider acceptance with a changed local version is staged and can be explicitly recovered', async t => {
  const f = fixture(t); f.put();
  const conflict = await createLocalConflict(f);
  assert.equal(f.read().title, 'Concurrent local');
  assert.equal(conflict.provider.title, 'Submitted');
  assert.equal(conflict.version, 2);
  assert.equal(conflict.expectedRemoteEtag, 'accepted-etag');
  assert.equal(f.gateway.locked('event-one').status, 'conflict');
  const body = { recordId: conflict.recordId, resolution: 'provider', version: conflict.version, expectedRemoteEtag: conflict.expectedRemoteEtag };
  const result = await f.gateway.resolve(f.user, f.accountId, body, 'recover-operation-1', 'recover');
  assert.equal(result.title, 'Submitted'); assert.equal(f.read().version, 3);
  assert.equal(f.gateway.locked('event-one'), undefined);
  assert.equal(f.writes, 1, 'Using the accepted provider snapshot does not send another write');
});

test('recovery retries return the durable response without replacing a newer local edit', async t => {
  const f = fixture(t); f.put();
  const conflict = await createLocalConflict(f);
  const body = { recordId: conflict.recordId, resolution: 'provider', version: conflict.version, expectedRemoteEtag: conflict.expectedRemoteEtag };
  const result = await f.gateway.resolve(f.user, f.accountId, body, 'recover-operation-1', 'recover');
  f.change('Later local edit');
  const repeated = await f.gateway.resolve(f.user, f.accountId, body, 'recover-operation-1', 'recover');
  assert.deepEqual(repeated, result);
  assert.equal(f.read().title, 'Later local edit');
  assert.equal(f.read().version, 4);
  await assert.rejects(f.gateway.resolve(f.user, f.accountId, { ...body, resolution: 'local' }, 'recover-operation-1', 'recover'), /different choice/);
});

test('local recovery reapplies the explicitly reviewed current local body with the accepted provider etag', async t => {
  const f = fixture(t); f.put();
  const conflict = await createLocalConflict(f);
  let submitted;
  const original = f.service.writeRecord.bind(f.service);
  f.service.writeRecord = async args => { submitted = args; return original(args); };
  const body = { recordId: conflict.recordId, resolution: 'local', version: conflict.version, expectedRemoteEtag: conflict.expectedRemoteEtag };
  const result = await f.gateway.resolve(f.user, f.accountId, body, 'reapply-operation-1', 'recover');
  assert.equal(submitted.record.title, 'Concurrent local');
  assert.equal(submitted.record.etag, 'accepted-etag');
  assert.equal(submitted.idempotencyKey, 'reapply-operation-1');
  assert.equal(result.title, 'Concurrent local');
  assert.equal(f.writes, 2);
});

test('recovery rejects stale local and provider comparisons before a provider side effect', async t => {
  const f = fixture(t); f.put();
  const conflict = await createLocalConflict(f);
  const body = { recordId: conflict.recordId, resolution: 'local', version: conflict.version, expectedRemoteEtag: conflict.expectedRemoteEtag };
  await assert.rejects(f.gateway.resolve(f.user, f.accountId, { ...body, version: 1 }, 'wrong-version-1', 'recover'), /item changed/);
  await assert.rejects(f.gateway.resolve(f.user, f.accountId, { ...body, expectedRemoteEtag: 'stale' }, 'wrong-etag-1', 'recover'), /comparison changed/);
  assert.equal(f.writes, 1);
});

test('ordinary provider conflict resolution uses local CAS, remote fingerprint and durable replay', async t => {
  const f = fixture(t); f.put();
  f.service.conflicts = [{ id: 'event-one', local: f.read(), remote: { title: 'Provider chosen', etag: 'remote-etag' }, remoteVersion: 'remote-etag' }];
  const status = f.gateway.status(f.user, f.accountId);
  assert.equal(status.conflicts[0].version, 1);
  const body = { recordId: 'event-one', resolution: 'remote', version: 1, expectedRemoteEtag: 'remote-etag' };
  const result = await f.gateway.resolve(f.user, f.accountId, body, 'conflict-operation-1', 'conflicts');
  f.change('After resolution');
  assert.deepEqual(await f.gateway.resolve(f.user, f.accountId, body, 'conflict-operation-1', 'conflicts'), result);
  assert.equal(f.read().title, 'After resolution');
  assert.equal(f.resolutions, 1);
});

test('a concurrent edit during provider conflict resolution creates a recoverable local conflict', async t => {
  const f = fixture(t); f.put();
  f.service.conflicts = [{ id: 'event-one', remote: { etag: 'remote-etag' }, remoteVersion: 'remote-etag' }];
  const original = f.service.resolveConflict.bind(f.service);
  f.service.resolveConflict = async args => { const accepted = await original(args); f.change('While resolving'); return accepted; };
  await assert.rejects(f.gateway.resolve(f.user, f.accountId, { recordId: 'event-one', resolution: 'remote', version: 1, expectedRemoteEtag: 'remote-etag' }, 'conflict-operation-1', 'conflicts'), error => error.code === 'pim_local_conflict');
  assert.equal(f.read().title, 'While resolving');
  assert.equal(f.gateway.status(f.user, f.accountId).localConflicts[0].provider.title, 'Provider chosen');
});

test('sync preserves held/deleted records and purged identities while acknowledging the durable batch', async t => {
  const f = fixture(t, { compliance: { wasPurged: id => id === 'purged', canDelete: () => ({ allowed: false }) } }); f.put();
  f.service.batch = [{ id: 'event-one', kind: 'event', deleted: true }, { id: 'purged', kind: 'contact', name: 'Must not return' }, { id: 'fresh', kind: 'contact', name: 'Fresh' }];
  Object.defineProperty(f.service.batch, 'batchId', { value: 'batch-one' });
  await f.gateway.sync(f.user, f.accountId);
  assert.equal(f.read().deleted, false); assert.equal(f.read().title, 'Original');
  assert.equal(f.read('purged'), null); assert.equal(f.read('fresh').name, 'Fresh');
  assert.equal(f.acknowledgments, 1);
});

test('sync advances unrelated records while a durable accepted local conflict awaits review', async t => {
  const f = fixture(t); f.put(); await createLocalConflict(f);
  f.service.batch = [{ id: 'event-one', kind: 'event', title: 'Remote now' }, { id: 'fresh', kind: 'contact', name: 'Fresh' }];
  const result = await f.gateway.sync(f.user, f.accountId);
  assert.equal(result.pending, 1);
  assert.equal(f.read().title, 'Concurrent local'); assert.equal(f.read('fresh').name, 'Fresh');
  assert.equal(f.acknowledgments, 1);
});

test('lease loss after provider I/O cannot overwrite local records or advance the sync cursor', async t => {
  const f = fixture(t, { coordinator: true }); f.put();
  const other = new ClusterCoordinator({ db: f.db, nodeId: 'replacement' }).migrate();
  let replacement;
  const take = () => { f.db.prepare('UPDATE cluster_leases SET expires=0 WHERE lease_key=?').run('pim-ingest:' + f.accountId); replacement = other.acquire('pim-ingest:' + f.accountId); };
  const original = f.service.writeRecord.bind(f.service);
  f.service.writeRecord = async args => { const accepted = await original(args); take(); return accepted; };
  await assert.rejects(write(f), error => error.code === 'LEASE_LOST');
  assert.equal(f.read().title, 'Original'); assert.equal(f.read().version, 1);
  replacement.release();
  f.service.syncAccount = async () => { take(); return [{ id: 'fresh', kind: 'contact', name: 'Unsafe' }]; };
  await assert.rejects(f.gateway.sync(f.user, f.accountId), error => error.code === 'LEASE_LOST');
  assert.equal(f.read('fresh'), null); assert.equal(f.acknowledgments, 0);
  replacement.release(); await other.stop();
});

test('resolution authorization and retention apply to the owner and account identity', async t => {
  const f = fixture(t); f.put(); const conflict = await createLocalConflict(f);
  const body = { recordId: conflict.recordId, resolution: 'provider', version: conflict.version, expectedRemoteEtag: conflict.expectedRemoteEtag };
  await assert.rejects(f.gateway.resolve({ userId: 'bob' }, f.accountId, body, 'forbidden-resolution', 'recover'), /Forbidden/);
  await assert.rejects(f.gateway.resolve(f.user, 'other-account', body, 'forbidden-resolution', 'recover'), /Forbidden/);
  assert.equal(f.read().title, 'Concurrent local');
});
