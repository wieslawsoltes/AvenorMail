import * as Y from 'yjs';

const EMPTY = () => new Uint8Array([0, 0]);
const merge = (...values) => Y.mergeUpdates(values.filter(value => value?.byteLength));
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });

/** Identity-scoped, atomic CRDT journal. Never stores bearer tokens or HTML. */
export class CollaborationStore {
  constructor({ indexedDB = globalThis.indexedDB, name = 'avenor-collaboration-v1' } = {}) {
    this.indexedDB = indexedDB;
    this.name = name;
    this.connection = null;
    this.opening = null;
  }

  static key({ url, userId, scope, recordId }) {
    if (!url || !userId || !scope || !recordId) throw new Error('A verified identity and document scope are required for collaborative storage.');
    const endpoint = new URL(url);
    endpoint.hash = ''; endpoint.search = '';
    return JSON.stringify([endpoint.href, String(userId), String(scope), String(recordId)]);
  }

  async open() {
    if (this.connection) return this.connection;
    if (this.opening) return this.opening;
    if (!this.indexedDB) throw new Error('IndexedDB is required to protect unsent collaborative edits.');
    this.opening = new Promise((resolve, reject) => {
      const operation = this.indexedDB.open(this.name, 1);
      operation.onupgradeneeded = () => operation.result.createObjectStore('documents', { keyPath: 'key' });
      operation.onerror = () => { this.opening = null; reject(operation.error); };
      operation.onblocked = () => { this.opening = null; reject(new Error('Close older Avenor tabs to open collaborative storage.')); };
      operation.onsuccess = () => {
        const db = operation.result;
        db.onversionchange = () => { db.close(); this.connection = null; this.opening = null; };
        this.connection = db;
        resolve(db);
      };
    });
    return this.opening;
  }

  async load(key) {
    const db = await this.open();
    return await request(db.transaction('documents').objectStore('documents').get(key)) || null;
  }

  async mutate(key, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result;
      // Request strict durability when implemented; unsupported engines still
      // provide the normal IndexedDB transaction-commit guarantee.
      let transaction;
      try { transaction = db.transaction('documents', 'readwrite', { durability: 'strict' }); }
      catch { transaction = db.transaction('documents', 'readwrite'); }
      const objectStore = transaction.objectStore('documents');
      const get = objectStore.get(key);
      get.onsuccess = () => {
        try {
          const current = get.result || { key, state: EMPTY(), serverState: EMPTY(), serverVector: new Uint8Array([0]), revision: 0, pending: [], revoked: false };
          result = operation(current);
          if (result) { result.updatedAt = Date.now(); objectStore.put(result); }
          else objectStore.delete(key);
        } catch (error) { reject(error); transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Collaborative storage failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Collaborative storage transaction was aborted.'));
    });
  }

  append(key, update, id = crypto.randomUUID()) {
    const bytes = new Uint8Array(update);
    return this.mutate(key, record => {
      if (record.revoked) throw new Error('Document access was revoked; local changes cannot be submitted.');
      record.state = merge(record.state, bytes);
      if (!record.pending.some(entry => entry.id === id)) record.pending.push({ id, update: bytes, createdAt: Date.now() });
      return record;
    }).then(record => ({ record, id }));
  }

  checkpoint(key, update, { revision = 0, vector, authorized = false } = {}) {
    const bytes = new Uint8Array(update);
    return this.mutate(key, record => {
      // An authorization denial is durable across tabs. Only a new successful
      // server join can unlock its journal; background ACKs cannot do so.
      if (record.revoked && !authorized) return record;
      record.revoked = false;
      record.serverState = merge(record.serverState, bytes);
      record.state = merge(record.state, bytes);
      record.serverVector = vector ? new Uint8Array(vector) : Y.encodeStateVectorFromUpdate(record.serverState);
      record.revision = Math.max(record.revision, revision);
      return record;
    });
  }

  acknowledge(key, ids, update, revision = 0) {
    const accepted = new Set(ids);
    const bytes = new Uint8Array(update);
    return this.mutate(key, record => {
      if (record.revoked) return record;
      record.serverState = merge(record.serverState, bytes);
      record.state = merge(record.state, bytes);
      record.serverVector = Y.encodeStateVectorFromUpdate(record.serverState);
      record.revision = Math.max(record.revision, revision);
      record.pending = record.pending.filter(entry => !accepted.has(entry.id));
      return record;
    });
  }

  revoke(key) {
    // Keep a tombstone to reject a concurrent tab's queued persistence operation.
    // Cached content is removed after an explicit server access denial.
    return this.mutate(key, record => ({ ...record, state: EMPTY(), serverState: EMPTY(), serverVector: new Uint8Array([0]), pending: [], revoked: true }));
  }

  async close() {
    const db = this.connection || await this.opening;
    db?.close(); this.connection = null; this.opening = null;
  }
}
