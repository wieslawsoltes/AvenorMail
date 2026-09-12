import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { CollaborationStore } from '../public/collab-store.js';

const identity = { url: 'wss://mail.example.test/api/live', userId: 'alice', scope: 'team:mail', recordId: 'draft:1' };
const key = CollaborationStore.key(identity);
const open = indexedDB => new CollaborationStore({ indexedDB });
const text = update => { const doc = new Y.Doc(); Y.applyUpdate(doc, update); const result = doc.getText('text').toString(); doc.destroy(); return result; };

function documents() {
  const seed = new Y.Doc(); seed.getText('text').insert(0, 'Start');
  const state = Y.encodeStateAsUpdate(seed);
  const left = new Y.Doc(), right = new Y.Doc();
  Y.applyUpdate(left, state); Y.applyUpdate(right, state);
  const updates = [];
  left.on('update', update => updates.push(update));
  left.getText('text').insert(5, ' left');
  const leftUpdate = updates.at(-1);
  right.on('update', update => updates.push(update));
  right.getText('text').insert(5, ' right');
  const rightUpdate = updates.at(-1);
  return { seed, state, left, right, leftUpdate, rightUpdate, close() { seed.destroy(); left.destroy(); right.destroy(); } };
}

test('a committed journal survives database connection replacement with its server checkpoint', async () => {
  const indexedDB = new IDBFactory();
  let journal = open(indexedDB);
  const docs = documents();
  try {
    await journal.checkpoint(key, docs.state, { revision: 1, vector: Y.encodeStateVector(docs.seed), authorized: true });
    await journal.append(key, docs.leftUpdate, 'edit-1');
    await journal.close();
    journal = open(indexedDB);
    const saved = await journal.load(key);
    assert.equal(text(saved.state), 'Start left');
    assert.equal(text(saved.serverState), 'Start');
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.pending.map(edit => edit.id), ['edit-1']);
    assert.deepEqual(saved.serverVector, Y.encodeStateVector(docs.seed));
  } finally { docs.close(); await journal.close(); }
});

test('concurrent tabs merge their journals atomically and one ACK cannot discard another pending edit', async () => {
  const indexedDB = new IDBFactory(), first = open(indexedDB), second = open(indexedDB);
  const docs = documents();
  try {
    await first.checkpoint(key, docs.state, { authorized: true });
    await Promise.all([first.append(key, docs.leftUpdate, 'left'), second.append(key, docs.rightUpdate, 'right')]);
    let state = await first.load(key);
    assert.match(text(state.state), /left/); assert.match(text(state.state), /right/);
    assert.equal(state.pending.length, 2);
    await first.acknowledge(key, ['left'], docs.leftUpdate, 2);
    state = await second.load(key);
    assert.deepEqual(state.pending.map(entry => entry.id), ['right']);
    assert.equal(text(state.serverState), 'Start left');
    await second.acknowledge(key, ['right'], docs.rightUpdate, 3);
    state = await first.load(key);
    assert.equal(text(state.serverState), text(state.state));
    assert.equal(state.pending.length, 0);
  } finally { docs.close(); await first.close(); await second.close(); }
});

test('lost ACK replay remains idempotent for deleted text and clears only replayed journal entries', async () => {
  const indexedDB = new IDBFactory(), journal = open(indexedDB);
  const doc = new Y.Doc(); doc.getText('text').insert(0, 'abcdef');
  const server = new Y.Doc(); Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
  try {
    await journal.checkpoint(key, Y.encodeStateAsUpdate(server), { authorized: true });
    let deletion;
    doc.on('update', update => { deletion = update; });
    doc.getText('text').delete(1, 3);
    await journal.append(key, deletion, 'delete');
    Y.applyUpdate(server, deletion); // accepted; response lost
    const snapshot = await journal.checkpoint(key, Y.encodeStateAsUpdate(server), { authorized: true });
    const restored = new Y.Doc(); Y.applyUpdate(restored, snapshot.state);
    const replay = Y.encodeStateAsUpdate(restored, Y.encodeStateVector(server));
    Y.applyUpdate(server, replay);
    await journal.acknowledge(key, snapshot.pending.map(entry => entry.id), replay, 3);
    assert.equal(server.getText('text').toString(), 'aef');
    assert.equal((await journal.load(key)).pending.length, 0);
    restored.destroy();
  } finally { doc.destroy(); server.destroy(); await journal.close(); }
});

test('server, authenticated identity, scope and record each partition local text', async () => {
  const indexedDB = new IDBFactory(), journal = open(indexedDB), docs = documents();
  try {
    await journal.checkpoint(key, docs.state, { authorized: true });
    await journal.append(key, docs.leftUpdate);
    for (const change of [{ url: 'wss://other.example.test/api/live' }, { userId: 'bob' }, { scope: 'team:other' }, { recordId: 'draft:2' }]) {
      assert.equal(await journal.load(CollaborationStore.key({ ...identity, ...change })), null);
    }
    assert.throws(() => CollaborationStore.key({ ...identity, userId: '' }), /verified identity/);
  } finally { docs.close(); await journal.close(); }
});

test('permission revocation erases cached content, blocks stale-tab appends and survives late ACKs', async () => {
  const indexedDB = new IDBFactory(), first = open(indexedDB), second = open(indexedDB), docs = documents();
  try {
    await first.checkpoint(key, docs.state, { authorized: true });
    await first.append(key, docs.leftUpdate, 'left');
    await second.revoke(key);
    await assert.rejects(first.append(key, docs.rightUpdate), /revoked/);
    await first.acknowledge(key, ['left'], docs.leftUpdate, 2);
    await first.checkpoint(key, docs.state, { revision: 3 });
    const revoked = await first.load(key);
    assert.equal(revoked.revoked, true);
    assert.equal(text(revoked.state), '');
    assert.equal(text(revoked.serverState), '');
    assert.equal(revoked.pending.length, 0);
    // Only an explicit authorized join can reopen the tombstone.
    const restored = await first.checkpoint(key, docs.state, { authorized: true });
    assert.equal(restored.revoked, false);
    assert.equal(text(restored.state), 'Start');
  } finally { docs.close(); await first.close(); await second.close(); }
});

test('durability failure is explicit when IndexedDB is unavailable', async () => {
  const journal = new CollaborationStore({ indexedDB: null });
  await assert.rejects(journal.load(key), /IndexedDB is required/);
});
