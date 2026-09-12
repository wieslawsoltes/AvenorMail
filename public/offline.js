/** Durable storage. Connected caches are namespaced by server AND signed-in user. */
const copy = value => structuredClone(value);
const uid = () => globalThis.crypto.randomUUID();
const error = (message, status = 400, extra = {}) => Object.assign(new Error(message), {status, ...extra});
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = transaction.onerror = () => reject(transaction.error || error('Local storage transaction failed'));
});

/** Stop at the first unresolved operation: dependent updates retain their original versions. */
export async function flushQueue(entries, send, persist, remove) {
  const outcomes = [];
  for (const entry of entries.sort((a, b) => a.sequence - b.sequence)) {
    if (entry.status === 'conflict' || entry.status === 'blocked') {
      outcomes.push({id: entry.id, status: entry.status, error: entry.error});
      break;
    }
    try {
      const result = await send(copy(entry));
      if (result instanceof Response && !result.ok) {
        const payload = await result.json().catch(() => ({}));
        throw error(payload.error || `Request failed (${result.status})`, result.status, {details: payload});
      }
      if (result?.queued) throw error('Request is still offline', 0);
      await remove(entry.id);
      outcomes.push({id: entry.id, status: 'synced', result});
    } catch (cause) {
      const status = cause.status === 409 ? 'conflict' : cause.status >= 400 && cause.status < 500 ? 'blocked' : 'pending';
      const updated = {...entry, status, attempts: (entry.attempts || 0) + 1, error: cause.message, lastAttempt: Date.now()};
      await persist(updated);
      outcomes.push({id: entry.id, status, error: cause.message, details: cause.details});
      break;
    }
  }
  return outcomes;
}

export class OfflineStore {
  constructor({namespace = 'device-local'} = {}) {
    this.namespace = namespace;
    this.name = `avenor-v1:${namespace}`;
    this.db = null;
    this.opening = null;
    this.flushing = null;
  }
  async open() {
    if (this.db) return this;
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(error('IndexedDB is unavailable. Enable browser storage to use this workspace.')); return; }
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('snapshots');
        db.createObjectStore('pending', {keyPath: 'id'});
        db.createObjectStore('blobs');
        db.createObjectStore('meta');
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => this.close();
        resolve(this);
      };
      request.onerror = () => { this.opening = null; reject(request.error); };
      request.onblocked = () => { this.opening = null; reject(error('Close older Avenor tabs to upgrade local storage.')); };
    });
    return this.opening;
  }
  async get(store, key) {
    await this.open();
    return requestResult(this.db.transaction(store).objectStore(store).get(key));
  }
  async put(store, key, value) {
    await this.open();
    const tx = this.db.transaction(store, 'readwrite');
    const done = transactionDone(tx);
    if (key === undefined) tx.objectStore(store).put(copy(value));
    else tx.objectStore(store).put(copy(value), key);
    await done;
    return value;
  }
  getSnapshot(scope) { return this.get('snapshots', scope); }
  setSnapshot(scope, data) { return this.put('snapshots', scope, data); }
  /** The callback is synchronous so read + write remain one atomic IndexedDB transaction. */
  async updateSnapshot(scope, update) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      let result;
      const request = store.get(scope);
      request.onsuccess = () => {
        try {
          const next = update(request.result);
          if (next && typeof next.then === 'function') throw error('Snapshot updates must be synchronous');
          result = next.result;
          store.put(next.value, scope);
        } catch (cause) { tx.abort(); reject(cause); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || error('Local save was cancelled'));
    });
  }
  async enqueue({id = uid(), method, path, body, scope, baseVersion}) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['pending', 'meta'], 'readwrite');
      const pending = tx.objectStore('pending');
      let result;
      const existing = pending.get(id);
      existing.onsuccess = () => {
        if (existing.result) { result = existing.result; return; }
        const sequence = tx.objectStore('meta').get('sequence');
        sequence.onsuccess = () => {
          const number = (sequence.result || 0) + 1;
          result = {id, method: method.toUpperCase(), path, body: copy(body), scope, baseVersion, sequence: number, created: Date.now(), status: 'pending', attempts: 0};
          pending.add(result);
          tx.objectStore('meta').put(number, 'sequence');
        };
      };
      tx.oncomplete = () => resolve(copy(result));
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async pending() {
    await this.open();
    const rows = await requestResult(this.db.transaction('pending').objectStore('pending').getAll());
    return rows.sort((a, b) => a.sequence - b.sequence);
  }
  async removePending(id) {
    await this.open();
    const tx = this.db.transaction('pending', 'readwrite'), done = transactionDone(tx);
    tx.objectStore('pending').delete(id);
    await done;
  }
  /** Resolution is explicit. Call after presenting original body and current server record. */
  async resolveConflict(id, replacement) {
    const existing = await this.get('pending', id);
    if (!existing) throw error('Pending change not found', 404);
    if (!replacement) return this.removePending(id);
    // New idempotency key: a resolved edit is a new request, never an overwrite of an old key.
    const tx = this.db.transaction('pending', 'readwrite'), done = transactionDone(tx);
    tx.objectStore('pending').put({...existing, ...copy(replacement), id: uid(), status: 'pending', attempts: 0, error: undefined});
    tx.objectStore('pending').delete(id);
    await done;
  }
  async flush(send) {
    if (this.flushing) return this.flushing;
    const run = () => this.pending().then(entries => flushQueue(entries, send, item => this.put('pending', undefined, item), id => this.removePending(id)));
    this.flushing = (globalThis.navigator?.locks ? navigator.locks.request(this.name + ':flush', run) : run()).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  putBlob(id, blob) {
    if (!(blob instanceof Blob)) throw error('Expected attachment bytes');
    return this.put('blobs', id, blob);
  }
  getBlob(id) { return this.get('blobs', id); }
  async deleteBlob(id) {
    await this.open();
    const tx = this.db.transaction('blobs', 'readwrite'), done = transactionDone(tx);
    tx.objectStore('blobs').delete(id);
    await done;
  }
  async clear() {
    await this.open();
    const tx = this.db.transaction(['snapshots', 'pending', 'blobs', 'meta'], 'readwrite'), done = transactionDone(tx);
    for (const name of ['snapshots', 'pending', 'blobs', 'meta']) tx.objectStore(name).clear();
    await done;
  }
  close() { this.db?.close(); this.db = null; this.opening = null; }
}

/** JSON transport. Select an identity-specific namespace before caching connected user data. */
export function createOfflineTransport({apiBase = '/api', namespace, getToken = () => null, onStatus = () => {}}) {
  if (!namespace) throw error('Connected offline storage requires a server and user-specific namespace');
  const store = new OfflineStore({namespace});
  const base = new URL(apiBase.replace(/\/$/, '') + '/', globalThis.location?.href || 'http://localhost/');
  const network = async ({method = 'GET', path, body, id}) => {
    const token = await getToken();
    const headers = {Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (id) headers['Idempotency-Key'] = id;
    const target = new URL(path.replace(/^\//, ''), base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw error('Request must stay within the configured API', 400);
    const response = await fetch(target, {method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw error(data.error || `Request failed (${response.status})`, response.status, {details: data});
    return data;
  };
  return {
    store,
    async call(path, {method = 'GET', body, scope, id} = {}) {
      method = method.toUpperCase();
      if (typeof body === 'string') body = JSON.parse(body);
      if (body instanceof FormData) throw error('Upload attachment bytes with the upload transport before queuing a record', 400);
      if (method === 'GET') {
        let data;
        try { data = await network({path, method}); }
        catch (cause) {
          if (cause.status) throw cause; // Authentication and permission errors never reveal a cached workspace.
          const cached = await store.getSnapshot(path);
          if (!cached) throw error('No saved copy is available on this device. Reconnect to load this workspace.', 503);
          onStatus({status: 'offline'});
          return {...cached, offline: true};
        }
        try { await store.setSnapshot(path, data); onStatus({status: 'online'}); }
        catch (cause) { onStatus({status: 'storage-error', error: cause.message}); }
        return data;
      }
      // Persist before delivery so a lost connection or closed tab cannot discard the request.
      const operation = await store.enqueue({id, method, path, body, scope: scope || body?.scope, baseVersion: body?.version});
      const results = await store.flush(network);
      const own = results.find(row => row.id === operation.id);
      if (own?.status === 'synced') { onStatus({status: 'online', outcomes: results}); return own.result; }
      onStatus({status: own?.status || 'pending', outcomes: results});
      if (own?.status === 'blocked' || own?.status === 'conflict') throw error(own.error, own.status === 'conflict' ? 409 : 400, {queued: true, mutationId: operation.id, details: own.details});
      return {queued: true, mutationId: operation.id, delivery: 'pending'};
    },
    async flush() { const outcomes = await store.flush(network); onStatus({status: outcomes.some(x => x.status !== 'synced') ? 'pending' : 'online', outcomes}); return outcomes; }
  };
}

const localKinds = new Set(['message', 'event', 'task', 'contact', 'folder', 'rule', 'comment', 'settings']);
function validateLocal(kind, data) {
  if (!localKinds.has(kind)) throw error('Unknown record type');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('Invalid record');
  const clean = copy(data);
  for (const key of ['id', 'kind', 'scope', 'owner', 'version', 'updated', '__proto__', 'constructor']) delete clean[key];
  if (JSON.stringify(clean).length > 150000) throw error('Record is too large', 413);
  if (['event', 'task', 'folder', 'rule'].includes(kind) && !clean.title?.trim()) throw error('A title is required');
  if (kind === 'contact' && !clean.name?.trim()) throw error('A contact name is required');
  if (kind === 'event' && (!Number.isFinite(+new Date(clean.start)) || !(new Date(clean.end) > new Date(clean.start)))) throw error('End time must be after the start');
  if (kind === 'comment' && (!clean.parent || !clean.body?.trim())) throw error('Write a comment first');
  if (clean.attachments && (!Array.isArray(clean.attachments) || clean.attachments.length > 20)) throw error('Maximum 20 attachments');
  return clean;
}

/** Explicit standalone workspace: private to this browser profile, synchronized only between its tabs. */
export class LocalWorkspace {
  constructor({namespace = 'device-local', user, onChange = () => {}} = {}) {
    this.store = new OfflineStore({namespace});
    this.user = user || {id: 'device-local', email: 'you@avenor.local', name: 'You'};
    this.scope = 'user:' + this.user.id;
    this.onChange = onChange;
    this.channel = globalThis.BroadcastChannel ? new BroadcastChannel('avenor-local:' + namespace) : null;
    if (this.channel) this.channel.onmessage = event => this.onChange(event.data);
    this.ready = null;
  }
  async open() {
    if (!this.ready) this.ready = (async () => {
      const {seedData} = await import('./seed.js');
      const rows = seedData({userId: this.user.id, email: this.user.email, fullName: this.user.name});
      await this.store.updateSnapshot('local-state', state => ({value: state || {
        user: this.user, teams: [], files: {}, records: [
          ...rows.map((row, index) => ({...row.data, id: `${this.user.id}:sample:${index}`, kind: row.kind, owner: this.user.id, scope: this.scope, version: 1, updated: Date.now()})),
          {id: this.user.id + ':settings', kind: 'settings', title: 'Preferences', signature: '', showSamples: true, owner: this.user.id, scope: this.scope, version: 1, updated: Date.now()}
        ]
      }, result: null}));
      return this;
    })().catch(cause => { this.ready = null; throw cause; });
    return this.ready;
  }
  notify(scope) { const change = {scope, updated: Date.now(), mode: 'device-local'}; this.channel?.postMessage(change); this.onChange(change); }
  async getFile(id) {
    await this.open();
    const blob = await this.store.getBlob(id);
    if (!blob) throw error('Attachment not found on this device', 404);
    return blob;
  }
  async call(path, {method = 'GET', body} = {}) {
    await this.open();
    method = method.toUpperCase();
    const url = new URL(path.replace(/^\/?api\//, ''), 'http://local/');
    const route = url.pathname.replace(/^\//, '');
    const b = typeof body === 'string' ? JSON.parse(body) : body || {};
    if (route.startsWith('file/') && method === 'GET') return this.getFile(decodeURIComponent(route.slice(5)));
    if (route === 'data' && method === 'GET') {
      const state = await this.store.getSnapshot('local-state');
      const scope = url.searchParams.get('scope') || this.scope;
      if (scope !== this.scope && !state.teams.some(team => 'team:' + team.id === scope)) throw error('Workspace not found', 404);
      const rows = state.records.filter(row => row.scope === scope && row.id > (url.searchParams.get('cursor') || '')).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return {user: state.user, scope, teams: state.teams, members: scope.startsWith('team:') ? [{...state.user, role: 'owner', seen: Date.now()}] : [], records: rows.slice(0, 500), nextCursor: rows.length > 500 ? rows[499].id : null, serverTime: Date.now(), mode: 'device-local', live: false, role: 'owner', capabilities: {externalMail: false, collaboration: false, local: true}};
    }
    if (route === 'upload' && method === 'POST') {
      const file = b instanceof FormData ? b.get('file') : b.file;
      const scope = String(b instanceof FormData ? b.get('scope') || this.scope : b.scope || this.scope);
      const state = await this.store.getSnapshot('local-state');
      if (scope !== this.scope && !state.teams.some(team => 'team:' + team.id === scope)) throw error('Workspace not found', 404);
      if (!(file instanceof Blob) || !file.size || file.size > 10 * 1024 * 1024) throw error('Choose a file up to 10 MB');
      const item = {id: uid(), name: String(file.name || 'attachment').replace(/[\r\n\\/]/g, '_').slice(0, 255), size: file.size, type: file.type || 'application/octet-stream', scope};
      await this.store.putBlob(item.id, file);
      try { await this.store.updateSnapshot('local-state', state => { state.files[item.id] = item; return {value: state, result: null}; }); }
      catch (cause) { await this.store.deleteBlob(item.id); throw cause; }
      return item;
    }
    const stagedFiles = [];
    if (route === 'send' && method === 'POST') {
      const state = await this.store.getSnapshot('local-state');
      const draft = state.records.find(row => row.id === b.id);
      try {
        for (const attachment of draft?.attachments || []) {
          const file = state.files[attachment.id], blob = await this.store.getBlob(attachment.id);
          if (!file || !blob) throw error('An attachment is missing on this device. Upload it again before sending.', 409);
          if (draft.scope !== this.scope) {
            const delivered = {...file, id: uid(), scope: this.scope};
            await this.store.putBlob(delivered.id, blob);
            stagedFiles.push(delivered);
          }
        }
      } catch (cause) { for (const file of stagedFiles) await this.store.deleteBlob(file.id); throw cause; }
    }
    let result;
    try { result = await this.store.updateSnapshot('local-state', state => {
      const now = Date.now(), scope = b.scope || this.scope;
      if (scope !== this.scope && !state.teams.some(team => 'team:' + team.id === scope)) throw error('Workspace not found', 404);
      const index = state.records.findIndex(row => row.id === b.id), record = state.records[index];
      const requireRecord = () => { if (!record) throw error('Record not found', 404); };
      const requireVersion = () => { requireRecord(); if (b.version !== record.version) throw error('This item changed in another tab. Your changes were not overwritten. Reload it and review your edit.', 409, {current: copy(record)}); };
      const attachments = data => { for (const item of data.attachments || []) { const file = state.files[item.id]; if (!file || file.scope !== (record?.scope || scope)) throw error('Attachment must belong to this workspace', 403); Object.assign(item, file); } };
      let result;
      if (route === 'record' && method === 'POST') {
        const data = validateLocal(b.kind, b.data); attachments(data);
        if (b.kind === 'comment') { const parent = state.records.find(row => row.id === data.parent); if (!parent || parent.scope !== scope) throw error('Comment parent not found', 404); Object.assign(data, {author: state.user.name, authorId: state.user.id, date: new Date(now).toISOString()}); }
        result = {...data, id: uid(), kind: b.kind, scope, owner: state.user.id, version: 1, updated: now}; state.records.push(result);
      } else if (route === 'record' && method === 'PATCH') {
        requireVersion(); const data = validateLocal(record.kind, {...record, ...b.patch}); attachments(data);
        if (record.kind === 'comment') for (const key of ['author', 'authorId', 'date', 'parent']) data[key] = record[key];
        result = {...data, id: record.id, kind: record.kind, scope: record.scope, owner: record.owner, version: record.version + 1, updated: now}; state.records[index] = result;
      } else if (route === 'record' && method === 'DELETE') {
        requireVersion(); state.records.splice(index, 1); result = {ok: true};
      } else if (route === 'send' && method === 'POST') {
        requireVersion(); if (record.kind !== 'message' || !['drafts', 'outbox'].includes(record.folder)) throw error('Open a draft to send');
        const addresses = [...new Set([record.to, record.cc, record.bcc].filter(Boolean).flatMap(value => value.split(/[,;]+/)).map(value => value.trim().toLowerCase()).filter(Boolean))];
        if (!addresses.length || !record.subject?.trim()) throw error('Add a recipient and subject before sending');
        if (addresses.some(address => address !== state.user.email.toLowerCase())) throw error('Device-local mode can deliver only to your own local inbox. This draft is saved; export it as .eml or connect a mail server to reach other people.', 409);
        result = {...record, from: state.user.email, name: state.user.name, folder: 'sent', read: true, sample: false, delivery: 'device-local', date: new Date(now).toISOString(), version: record.version + 1, updated: now};
        state.records[index] = result;
        for (const file of stagedFiles) state.files[file.id] = file;
        state.records.push({...copy(result), id: uid(), scope: this.scope, folder: 'inbox', read: false, bcc: undefined, version: 1, attachments: stagedFiles.length ? copy(stagedFiles) : copy(result.attachments || [])});
      } else if (route === 'team' && method === 'POST') {
        if (b.action !== 'create') throw error('Invitations and shared membership require a connected server. Local workspaces are available only in this browser.', 409);
        if (!String(b.name || '').trim()) throw error('Name your workspace');
        result = {id: uid(), name: String(b.name).trim().slice(0, 100), owner: state.user.id, role: 'owner', local: true}; state.teams.push(result);
      } else throw error('This feature requires a connected server', 501);
      return {value: state, result: copy(result)};
    }); } catch (cause) { for (const file of stagedFiles) await this.store.deleteBlob(file.id); throw cause; }
    this.notify(b.scope || this.scope);
    return result;
  }
  close() { this.channel?.close(); this.store.close(); this.ready = null; }
}
