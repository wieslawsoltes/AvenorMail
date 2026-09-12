import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';

export const LIVE_LIMITS = Object.freeze({ message: 384 * 1024, update: 256 * 1024, document: 2 * 1024 * 1024, rooms: 8, scopes: 16 });
const id = value => typeof value === 'string' && /^[\w:.-]{1,160}$/.test(value);
const encode = bytes => Buffer.from(bytes).toString('base64');
const failure = (code, message) => Object.assign(new Error(message), { code });
const xmlNodes = new Set(['paragraph', 'heading', 'blockquote', 'code_block', 'horizontal_rule', 'bullet_list', 'ordered_list', 'list_item', 'hard_break']);

function decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(LIVE_LIMITS.update / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failure('BAD_UPDATE', 'Invalid document update.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > LIVE_LIMITS.update) throw failure('BAD_UPDATE', 'Document update exceeds the limit.');
  return bytes;
}

function validateDocument(doc) {
  if ([...doc.share.keys()].some(name => name !== 'prosemirror')) throw failure('BAD_DOCUMENT', 'Unexpected shared document type.');
  const root = doc.getXmlFragment('prosemirror');
  let nodes = 0, characters = 0;
  const visit = (node, depth) => {
    if (++nodes > 30000 || depth > 40) throw failure('BAD_DOCUMENT', 'Document is too complex.');
    if (node instanceof Y.XmlText) {
      characters += node.length;
      for (const run of node.toDelta()) {
        if (typeof run.insert !== 'string') throw failure('BAD_DOCUMENT', 'Embedded content is unsupported.');
        for (const [mark, attrs] of Object.entries(run.attributes || {})) {
          if (!['strong', 'em', 'underline', 'code', 'link'].includes(mark)) throw failure('BAD_DOCUMENT', 'Unsupported text format.');
          if (mark === 'link' && (!attrs || typeof attrs.href !== 'string' || !/^(https?:\/\/|mailto:)/i.test(attrs.href) || attrs.href.length > 2048)) throw failure('BAD_DOCUMENT', 'Unsupported link.');
        }
      }
    } else if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      if (node instanceof Y.XmlElement && !xmlNodes.has(node.nodeName)) throw failure('BAD_DOCUMENT', 'Unsupported document element.');
      for (const [key, value] of Object.entries(node.getAttributes?.() || {})) {
        if (!['level', 'order', 'params'].includes(key) || JSON.stringify(value).length > 200) throw failure('BAD_DOCUMENT', 'Unsupported document attribute.');
      }
      const children = node.toArray();
      const inline = node instanceof Y.XmlElement && ['paragraph', 'heading', 'code_block'].includes(node.nodeName);
      for (const child of children) {
        if (inline ? !(child instanceof Y.XmlText || (child instanceof Y.XmlElement && child.nodeName === 'hard_break')) : !(child instanceof Y.XmlElement)) throw failure('BAD_DOCUMENT', 'Invalid document structure.');
        if (node instanceof Y.XmlElement && ['bullet_list', 'ordered_list'].includes(node.nodeName) && child.nodeName !== 'list_item') throw failure('BAD_DOCUMENT', 'Invalid list structure.');
        visit(child, depth + 1);
      }
    } else throw failure('BAD_DOCUMENT', 'Unsupported document value.');
  };
  visit(root, 0);
  if (characters > 500000 || doc.store.pendingStructs || doc.store.pendingDs) throw failure('BAD_DOCUMENT', 'Document update is incomplete or exceeds the limit.');
  const state = Y.encodeStateAsUpdate(doc);
  if (state.length > LIVE_LIMITS.document) throw failure('BAD_DOCUMENT', 'Document exceeds the storage limit.');
  return state;
}

/** Authenticated, workspace-scoped durable CRDT and record event transport. */
export class RealtimeHub {
  constructor({ db, authenticate, authorize, allowedOrigins = [], emit = () => {} }) {
    if (!db || !authenticate || !authorize) throw new TypeError('db, authenticate and authorize are required');
    this.db = db;
    this.authenticate = authenticate;
    this.authorize = authorize;
    this.allowedOrigins = new Set(allowedOrigins);
    this.emit = emit;
    this.clients = new Set();
    this.rooms = new Map();
    this.closed = false;
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_documents (
      record_id TEXT PRIMARY KEY, scope TEXT NOT NULL, state BLOB NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS collaboration_scope ON collaboration_documents(scope);`);
    this.select = this.db.prepare('SELECT * FROM collaboration_documents WHERE record_id = ?');
    this.insert = this.db.prepare('INSERT INTO collaboration_documents(record_id, scope, state, revision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET state=excluded.state, revision=excluded.revision, updated_at=excluded.updated_at WHERE collaboration_documents.scope=excluded.scope');
    return this;
  }

  attach(server) {
    if (this.wss) throw new Error('Realtime server already attached');
    if (!this.select) this.migrate();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_LIMITS.message, perMessageDeflate: false });
    this.upgrade = (request, socket, head) => {
      let url;
      try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
      if (url.pathname !== '/api/live') return;
      if (url.search || !request.headers.origin || !this.allowedOrigins.has(request.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => this.accept(ws, request));
    };
    this.server = server;
    server.on('upgrade', this.upgrade);
    this.timer = setInterval(() => this.sweep().catch(() => {}), 2000);
    this.timer.unref();
    return this;
  }

  accept(ws, request) {
    const client = { ws, request, id: randomUUID(), user: null, scopes: new Set(), rooms: new Map(), tokens: 120, tick: Date.now(), chain: Promise.resolve(), queuedBytes: 0, queuedMessages: 0, closed: false };
    this.clients.add(client);
    const authTimer = setTimeout(() => ws.close(4401, 'Authentication required'), 5000);
    authTimer.unref();
    ws.on('message', (raw, binary) => {
      const now = Date.now();
      client.tokens = Math.min(120, client.tokens + (now - client.tick) * 0.06);
      client.tick = now;
      if (binary || raw.length > LIVE_LIMITS.message || client.tokens < 1 || client.queuedMessages >= 120 || client.queuedBytes + raw.length > LIVE_LIMITS.document) { ws.close(4429, 'Message limit exceeded'); return; }
      client.tokens--;
      client.queuedBytes += raw.length;
      client.queuedMessages++;
      // Each connection is ordered; every operation performs fresh authorization.
      client.chain = client.chain.then(async () => {
        if (client.closed) return;
        let message;
        try {
          message = JSON.parse(raw.toString());
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw failure('BAD_MESSAGE', 'Invalid message.');
          await this.handle(client, message);
          if (client.user) clearTimeout(authTimer);
        } catch (error) {
          this.send(client, { type: 'error', code: error.code || 'LIVE_ERROR', message: error.code ? error.message : 'Live operation failed.', requestId: typeof message?.requestId === 'string' ? message.requestId.slice(0, 100) : undefined, recordId: id(message?.recordId) ? message.recordId : undefined });
          if (error.code === 'UNAUTHENTICATED') ws.close(4401, 'Session expired');
        }
      }).finally(() => { client.queuedBytes -= raw.length; client.queuedMessages--; });
    });
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(authTimer); this.removeClient(client); });
  }

  send(client, data) {
    if (client.closed || client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > 4 * LIVE_LIMITS.document) { client.ws.close(4429, 'Slow consumer'); return; }
    client.ws.send(JSON.stringify(data));
  }

  async freshUser(client) {
    if (this.closed || client.closed || client.ws.readyState !== WebSocket.OPEN) throw failure('UNAUTHENTICATED', 'Connection is closed.');
    if (!client.authRequest) throw failure('UNAUTHENTICATED', 'Authenticate before subscribing.');
    const user = await this.authenticate(client.authRequest);
    if (this.closed || client.closed || client.ws.readyState !== WebSocket.OPEN) throw failure('UNAUTHENTICATED', 'Connection is closed.');
    if (!user?.userId || (client.user && user.userId !== client.user.userId)) throw failure('UNAUTHENTICATED', 'Your session has expired.');
    client.user = user;
    return user;
  }

  async can(client, scope, recordId, action) {
    if (this.closed || client.closed || client.ws.readyState !== WebSocket.OPEN) throw failure('UNAUTHENTICATED', 'Connection is closed.');
    const allowed = await this.authorize({ user: client.user, scope, recordId, action });
    if (this.closed || client.closed || client.ws.readyState !== WebSocket.OPEN) throw failure('UNAUTHENTICATED', 'Connection is closed.');
    return Boolean(allowed);
  }

  room(recordId, scope) {
    let room = this.rooms.get(recordId);
    if (room && room.scope !== scope) throw failure('SCOPE_MISMATCH', 'The document belongs to another workspace.');
    if (!room) {
      const row = this.select.get(recordId);
      if (row && row.scope !== scope) throw failure('SCOPE_MISMATCH', 'The document belongs to another workspace.');
      const doc = new Y.Doc();
      if (row) Y.applyUpdate(doc, row.state);
      room = { recordId, scope, doc, revision: row?.revision || 0, initialized: Boolean(row), clients: new Set() };
      this.rooms.set(recordId, room);
    }
    return room;
  }

  persist(room, bytes) {
    if (this.closed) throw failure('UNAUTHENTICATED', 'Connection is closed.');
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
      Y.applyUpdate(candidate, bytes);
      const state = validateDocument(candidate);
      const revision = room.revision + 1;
      // Native SQLite autocommit completes before any acknowledgement/broadcast.
      const result = this.insert.run(room.recordId, room.scope, state, revision, Date.now());
      if (result.changes !== 1) throw failure('SCOPE_MISMATCH', 'The document belongs to another workspace.');
      room.doc.destroy();
      room.doc = candidate;
      room.revision = revision;
      room.initialized = true;
      return state;
    } catch (error) {
      candidate.destroy();
      if (error.code && ['BAD_DOCUMENT', 'SCOPE_MISMATCH'].includes(error.code)) throw error;
      throw failure('BAD_UPDATE', 'Unable to persist this document update.');
    }
  }

  async handle(client, message) {
    if (message.type === 'auth') {
      if (client.user || typeof message.token !== 'string' || !message.token || message.token.length > 8192) throw failure('UNAUTHENTICATED', 'Invalid authentication frame.');
      client.authRequest = Object.create(client.request);
      client.authRequest.headers = { ...client.request.headers, authorization: `Bearer ${message.token}` };
      await this.freshUser(client);
      this.send(client, { type: 'ready', clientId: client.id, user: { userId: client.user.userId, displayName: client.user.displayName || client.user.email || 'Teammate' } });
      return;
    }
    await this.freshUser(client);
    if (message.type === 'ping') { this.send(client, { type: 'pong' }); return; }
    const { scope, recordId } = message;
    if (!id(scope)) throw failure('BAD_SCOPE', 'A valid workspace is required.');
    if (message.type === 'unsubscribe') {
      client.scopes.delete(scope);
      for (const room of client.rooms.values()) if (room.scope === scope) this.leave(client, room.recordId);
      return;
    }
    if (!await this.can(client, scope, undefined, 'subscribe')) {
      this.revokeScope(client, scope);
      throw failure('FORBIDDEN', 'You do not have access to this workspace.');
    }
    if (message.type === 'subscribe') {
      if (client.scopes.size >= LIVE_LIMITS.scopes && !client.scopes.has(scope)) throw failure('LIMIT', 'Too many subscriptions.');
      client.scopes.add(scope);
      this.send(client, { type: 'subscribed', scope });
      return;
    }
    if (!id(recordId)) throw failure('BAD_RECORD', 'A valid document is required.');
    if (message.type === 'leave') { this.leave(client, recordId); return; }
    if (!await this.can(client, scope, recordId, 'read')) {
      this.leave(client, recordId);
      throw failure('FORBIDDEN', 'You do not have access to this document.');
    }
    if (message.type === 'join') {
      if (client.rooms.size >= LIVE_LIMITS.rooms && !client.rooms.has(recordId)) throw failure('LIMIT', 'Too many open documents.');
      const writable = await this.can(client, scope, recordId, 'write');
      const room = this.room(recordId, scope);
      let seed;
      if (!room.initialized && writable && message.initialUpdate) {
        seed = decode(message.initialUpdate);
        this.persist(room, seed);
      }
      room.clients.add(client);
      client.rooms.set(recordId, room);
      client.scopes.add(scope);
      this.send(client, { type: 'joined', scope, recordId, readOnly: !writable, initialized: room.initialized, state: encode(Y.encodeStateAsUpdate(room.doc)), vector: encode(Y.encodeStateVector(room.doc)), revision: room.revision });
      if (seed) await this.broadcastRoom(room, { type: 'update', scope, recordId, update: encode(seed), revision: room.revision }, client);
      await this.presence(room);
      return;
    }
    const room = client.rooms.get(recordId);
    if (!room || room.scope !== scope) throw failure('NOT_JOINED', 'Join the document first.');
    if (message.type === 'update') {
      if (!await this.can(client, scope, recordId, 'write')) {
        this.send(client, { type: 'permission', recordId, scope, readOnly: true });
        throw failure('READ_ONLY', 'This draft is read only or has already been sent.');
      }
      const bytes = decode(message.update);
      this.persist(room, bytes);
      this.send(client, { type: 'ack', recordId, scope, requestId: message.requestId, revision: room.revision });
      await this.broadcastRoom(room, { type: 'update', scope, recordId, update: encode(bytes), revision: room.revision }, client);
      try { this.emit({ type: 'collaboration.updated', scope, recordId, revision: room.revision }); } catch { /* telemetry must not invalidate durable writes */ }
      return;
    }
    if (message.type === 'presence') {
      const selection = message.selection;
      if (selection !== null && selection !== undefined && (typeof selection !== 'object' || Array.isArray(selection) || JSON.stringify(selection).length > 4096)) throw failure('BAD_PRESENCE', 'Invalid selection.');
      if (selection?.cursor) {
        const position = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['type', 'tname', 'item', 'assoc'].includes(key)) && ['type', 'item'].every(key => value[key] == null || (typeof value[key] === 'object' && Number.isSafeInteger(value[key].client) && value[key].client >= 0 && Number.isSafeInteger(value[key].clock) && value[key].clock >= 0)) && (value.tname == null || value.tname === 'prosemirror') && (value.assoc == null || [-1, 0, 1].includes(value.assoc));
        if (!position(selection.cursor.anchor) || !position(selection.cursor.head)) throw failure('BAD_PRESENCE', 'Invalid cursor position.');
      }
      client.selection = { recordId, value: selection || null };
      await this.presence(room);
      return;
    }
    throw failure('BAD_MESSAGE', 'Unknown live message type.');
  }

  async broadcastRoom(room, event, except) {
    await Promise.all([...room.clients].filter(client => client !== except).map(async client => {
      try {
        await this.freshUser(client);
        if (!await this.can(client, room.scope, room.recordId, 'read') || !await this.can(client, room.scope, undefined, 'subscribe')) { this.send(client, { type: 'revoked', scope: room.scope, recordId: room.recordId }); this.leave(client, room.recordId); return; }
        this.send(client, event);
      } catch { client.ws.close(4401, 'Session expired'); }
    }));
  }

  async presence(room) {
    // Presence and selection are ephemeral, never trusted as authorization claims.
    const participants = [...room.clients].filter(client => !client.closed).map(client => ({ clientId: client.id, userId: client.user.userId, displayName: client.user.displayName || client.user.email || 'Teammate', selection: client.selection?.recordId === room.recordId ? client.selection.value : null }));
    await this.broadcastRoom(room, { type: 'presence', scope: room.scope, recordId: room.recordId, participants });
  }

  leave(client, recordId) {
    const room = client.rooms.get(recordId);
    if (!room) return;
    room.clients.delete(client);
    client.rooms.delete(recordId);
    if (room.clients.size) this.presence(room).catch(() => {});
    else { room.doc.destroy(); this.rooms.delete(recordId); }
  }

  revokeScope(client, scope) {
    client.scopes.delete(scope);
    for (const room of [...client.rooms.values()]) if (room.scope === scope) this.leave(client, room.recordId);
    this.send(client, { type: 'revoked', scope });
  }

  removeClient(client) {
    client.closed = true;
    this.clients.delete(client);
    for (const recordId of [...client.rooms.keys()]) this.leave(client, recordId);
  }

  async sweep() {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      await Promise.all([...this.clients].filter(client => client.user).map(async client => {
        try {
          await this.freshUser(client);
          for (const scope of [...client.scopes]) if (!await this.can(client, scope, undefined, 'subscribe')) this.revokeScope(client, scope);
          for (const room of [...client.rooms.values()]) {
            if (!await this.can(client, room.scope, room.recordId, 'read')) { this.send(client, { type: 'revoked', scope: room.scope, recordId: room.recordId }); this.leave(client, room.recordId); }
            else this.send(client, { type: 'permission', scope: room.scope, recordId: room.recordId, readOnly: !await this.can(client, room.scope, room.recordId, 'write') });
          }
        } catch { client.ws.close(4401, 'Session expired'); }
      }));
    } finally { this.sweeping = false; }
  }

  async publish(scope, event) {
    if (!id(scope) || !event || typeof event !== 'object') return;
    await Promise.all([...this.clients].filter(client => client.scopes.has(scope)).map(async client => {
      try {
        await this.freshUser(client);
        if (!await this.can(client, scope, undefined, 'subscribe')) { this.revokeScope(client, scope); return; }
        if (event.recordId && !await this.can(client, scope, event.recordId, 'read') && event.type !== 'record.deleted') return;
        this.send(client, { type: 'change', scope, event });
      } catch { client.ws.close(4401, 'Session expired'); }
    }));
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.server?.off('upgrade', this.upgrade);
    for (const client of [...this.clients]) { client.ws.terminate(); this.removeClient(client); }
    for (const room of this.rooms.values()) room.doc.destroy();
    this.rooms.clear();
    if (this.wss) await new Promise(resolve => this.wss.close(resolve));
  }
}

const escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
/** Read the durable collaborative body for API responses and the send snapshot. */
export function collaborationDocumentHTML(db, recordId) {
  const row = db.prepare('SELECT state FROM collaboration_documents WHERE record_id=?').get(recordId);
  if (!row) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, row.state);
    const render = node => {
      if (node instanceof Y.XmlText) return node.toDelta().map(run => {
        let content = escapeHTML(run.insert);
        for (const [mark, attrs] of Object.entries(run.attributes || {})) {
          if (mark === 'link') content = `<a href="${escapeHTML(attrs.href)}" rel="noopener noreferrer">${content}</a>`;
          else { const tag = { strong: 'strong', em: 'em', underline: 'u', code: 'code' }[mark]; if (tag) content = `<${tag}>${content}</${tag}>`; }
        }
        return content;
      }).join('');
      const content = node.toArray().map(render).join('');
      if (!(node instanceof Y.XmlElement)) return content;
      if (node.nodeName === 'hard_break') return '<br>';
      if (node.nodeName === 'horizontal_rule') return '<hr>';
      if (node.nodeName === 'code_block') return `<pre><code>${content}</code></pre>`;
      const tag = node.nodeName === 'heading' ? `h${Math.max(1, Math.min(6, Number(node.getAttribute('level')) || 1))}` : { paragraph: 'p', blockquote: 'blockquote', bullet_list: 'ul', ordered_list: 'ol', list_item: 'li' }[node.nodeName];
      return tag ? `<${tag}${node.nodeName === 'ordered_list' ? ` start="${Math.max(1, Number(node.getAttribute('order')) || 1)}"` : ''}>${content}</${tag}>` : content;
    };
    return render(doc.getXmlFragment('prosemirror'));
  } finally { doc.destroy(); }
}
