import { randomUUID } from 'node:crypto';

const conflict = (code, message) => Object.assign(new Error(message), { status: 409, code });
const milliseconds = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/** Shared SQLite/libSQL event log, node liveness and fenced work leases. */
export class ClusterCoordinator {
  constructor({ db, nodeId = randomUUID(), pollMs = 500, nodeTtl = 30000, batchSize = 200, retentionMs = 86400000 } = {}) {
    if (!db) throw new TypeError('A shared database is required.');
    if (typeof nodeId !== 'string' || !/^[\w:.-]{1,160}$/.test(nodeId)) throw new TypeError('Invalid cluster node ID.');
    this.db = db; this.nodeId = nodeId; this.instanceId = randomUUID();
    this.pollMs = Math.max(10, pollMs); this.nodeTtl = Math.max(1000, nodeTtl); this.batchSize = Math.max(1, Math.min(1000, batchSize));
    this.retentionMs = retentionMs; this.running = false; this.cursor = 0; this.activeLeases = new Set();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cluster_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,node_id TEXT NOT NULL,scope TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cluster_events_created ON cluster_events(created_at);
      CREATE TABLE IF NOT EXISTS cluster_nodes(node_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,last_seq INTEGER NOT NULL,heartbeat INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_leases(lease_key TEXT PRIMARY KEY,node_id TEXT NOT NULL,holder TEXT NOT NULL,token INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_presence(client_id TEXT NOT NULL,record_id TEXT NOT NULL,node_id TEXT NOT NULL,scope TEXT NOT NULL,user_id TEXT NOT NULL,display_name TEXT NOT NULL,selection TEXT,expires INTEGER NOT NULL,PRIMARY KEY(client_id,record_id));
      CREATE INDEX IF NOT EXISTS collaboration_presence_room ON collaboration_presence(record_id,scope,expires);
    `);
    const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const trigger = (name, table, action, scope, event) => this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${action} ON ${table} BEGIN INSERT INTO cluster_events(node_id,scope,event,created_at) VALUES ('',${scope},${event},${milliseconds}); END;`);
    if (tables.has('records')) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      trigger(`cluster_records_${operation.toLowerCase()}`, 'records', operation, `${row}.scope`, `json_object('type',${operation === 'DELETE' ? "'record.deleted'" : `CASE WHEN ${row}.deleted=1 THEN 'record.deleted' ELSE 'record-change' END`},'recordId',${row}.id,'version',${row}.version)`);
    }
    if (tables.has('collaboration_documents')) for (const operation of ['INSERT', 'UPDATE']) trigger(`cluster_crdt_${operation.toLowerCase()}`, 'collaboration_documents', operation, 'NEW.scope', "json_object('type','collaboration.updated','recordId',NEW.record_id,'revision',NEW.revision)");
    if (tables.has('members')) for (const operation of ['INSERT', 'UPDATE OF role', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      trigger(`cluster_members_${operation.split(' ')[0].toLowerCase()}`, 'members', operation, `'team:' || ${row}.team`, `json_object('type','permissions-changed','userId',${row}.user)`);
    }
    if (tables.has('delegations')) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      trigger(`cluster_delegations_${operation.toLowerCase()}`, 'delegations', operation, `${row}.scope`, `json_object('type','permissions-changed','userId',${row}.user_id)`);
    }
    for (const table of ['auth_accounts', 'auth_sessions']) if (tables.has(table)) for (const operation of ['UPDATE', 'DELETE']) {
      trigger(`cluster_${table}_${operation.toLowerCase()}`, table, operation, "'*'", `json_object('type','authentication-changed','userId',${operation === 'DELETE' ? 'OLD' : 'NEW'}.user_id)`);
    }
    return this;
  }

  now() { return Number(this.db.prepare(`SELECT ${milliseconds} AS now`).get().now); }

  publish(scope, event) {
    if (typeof scope !== 'string' || scope.length > 200 || !event || typeof event !== 'object') throw new TypeError('A scope and event are required.');
    const json = JSON.stringify(event);
    if (Buffer.byteLength(json) > 65536) throw new RangeError('Cluster event exceeds 64 KiB.');
    const result = this.db.prepare(`INSERT INTO cluster_events(node_id,scope,event,created_at) VALUES (?,?,?,${milliseconds})`).run(this.nodeId, scope, json);
    return Number(result.lastInsertRowid);
  }

  start(onEvent) {
    if (this.running) return this;
    if (typeof onEvent !== 'function') throw new TypeError('An event handler is required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.now(), existing = this.db.prepare('SELECT * FROM cluster_nodes WHERE node_id=?').get(this.nodeId);
      if (existing && existing.expires > now && existing.instance_id !== this.instanceId) throw conflict('NODE_ACTIVE', 'This cluster node ID is already active. Use a unique ID for each running instance.');
      this.cursor = existing?.last_seq ?? Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM cluster_events').get().seq);
      this.db.prepare('INSERT INTO cluster_nodes VALUES (?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET instance_id=excluded.instance_id,last_seq=excluded.last_seq,heartbeat=excluded.heartbeat,expires=excluded.expires').run(this.nodeId, this.instanceId, this.cursor, now, now + this.nodeTtl);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.onEvent = onEvent; this.running = true;
    this.timer = setInterval(() => this.poll().catch(error => { this.lastError = error.message; }), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  async poll() {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      const heartbeat = this.db.prepare('UPDATE cluster_nodes SET heartbeat=?,expires=? WHERE node_id=? AND instance_id=?').run(now, now + this.nodeTtl, this.nodeId, this.instanceId);
      if (Number(heartbeat.changes) !== 1) { this.running = false; clearInterval(this.timer); throw conflict('NODE_REPLACED', 'This cluster node instance was replaced.'); }
      const events = this.db.prepare('SELECT * FROM cluster_events WHERE seq>? ORDER BY seq LIMIT ?').all(this.cursor, this.batchSize);
      for (const row of events) {
        if (!this.running) break;
        await this.onEvent({ id: Number(row.seq), nodeId: row.node_id, scope: row.scope, event: JSON.parse(row.event), createdAt: row.created_at });
        this.cursor = Number(row.seq);
        this.db.prepare('UPDATE cluster_nodes SET last_seq=? WHERE node_id=? AND instance_id=?').run(this.cursor, this.nodeId, this.instanceId);
      }
      if (!this.lastMaintenance || now - this.lastMaintenance >= Math.min(60000, this.nodeTtl)) {
        this.db.prepare('DELETE FROM collaboration_presence WHERE expires<=?').run(now);
        this.db.prepare('DELETE FROM cluster_events WHERE created_at<? AND seq<=COALESCE((SELECT MIN(last_seq) FROM cluster_nodes WHERE expires>?),0)').run(now - this.retentionMs, now);
        this.lastMaintenance = now;
      }
      this.lastError = null;
    } finally { this.polling = false; }
  }

  acquire(key, { ttl = 30000 } = {}) {
    if (typeof key !== 'string' || !key || key.length > 250) throw new TypeError('Invalid lease key.');
    ttl = Math.max(100, Math.min(3600000, Number(ttl) || 30000));
    const holder = randomUUID();
    let token, expires;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.now(), existing = this.db.prepare('SELECT * FROM cluster_leases WHERE lease_key=?').get(key);
      if (existing?.expires > now) throw conflict('LEASE_HELD', 'Another worker is handling this operation. Try again after it finishes.');
      token = Number(existing?.token || 0) + 1; expires = now + ttl;
      this.db.prepare('INSERT INTO cluster_leases VALUES (?,?,?,?,?) ON CONFLICT(lease_key) DO UPDATE SET node_id=excluded.node_id,holder=excluded.holder,token=excluded.token,expires=excluded.expires').run(key, this.nodeId, holder, token, expires);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const controller = new AbortController();
    const lease = { key, nodeId: this.nodeId, holder, token, expires, signal: controller.signal,
      assert: () => {
        const row = this.db.prepare('SELECT * FROM cluster_leases WHERE lease_key=?').get(key);
        if (!row || row.holder !== holder || row.token !== token || row.expires <= this.now()) { const error = conflict('LEASE_LOST', 'This worker no longer holds the operation lease.'); controller.abort(error); throw error; }
        return token;
      },
      renew: () => {
        const now = this.now();
        const changed = this.db.prepare('UPDATE cluster_leases SET expires=? WHERE lease_key=? AND holder=? AND token=? AND expires>?').run(now + ttl, key, holder, token, now);
        if (Number(changed.changes) !== 1) { const error = conflict('LEASE_LOST', 'This worker no longer holds the operation lease.'); controller.abort(error); throw error; }
        lease.expires = now + ttl;
        return lease.expires;
      },
      release: () => {
        this.db.prepare("UPDATE cluster_leases SET holder='',expires=0 WHERE lease_key=? AND holder=? AND token=?").run(key, holder, token);
        this.activeLeases.delete(lease);
      },
      abort: reason => controller.abort(reason),
    };
    this.activeLeases.add(lease);
    return lease;
  }

  async withLease(key, action, options = {}) {
    const lease = this.acquire(key, options);
    const timer = setInterval(() => { try { lease.renew(); } catch (error) { lease.abort(error); } }, Math.max(25, Math.floor((options.ttl || 30000) / 3)));
    timer.unref?.();
    try {
      const result = await action(lease);
      lease.assert();
      return result;
    } finally { clearInterval(timer); lease.release(); }
  }

  status() {
    const now = this.now();
    return { nodeId: this.nodeId, running: this.running, cursor: this.cursor, lastError: this.lastError || null,
      nodes: this.db.prepare('SELECT node_id AS nodeId,last_seq AS cursor,heartbeat,expires FROM cluster_nodes WHERE expires>? ORDER BY node_id').all(now),
      activeLeases: Number(this.db.prepare('SELECT COUNT(*) AS total FROM cluster_leases WHERE expires>?').get(now).total),
    };
  }

  async stop() {
    this.running = false; clearInterval(this.timer);
    for (const lease of this.activeLeases) { lease.abort(conflict('NODE_STOPPED', 'The cluster node is stopping.')); lease.release(); }
    this.db.prepare('UPDATE cluster_nodes SET expires=0 WHERE node_id=? AND instance_id=?').run(this.nodeId, this.instanceId);
    this.db.prepare('DELETE FROM collaboration_presence WHERE node_id=?').run(this.nodeId);
    while (this.polling) await new Promise(resolve => setTimeout(resolve, 5));
  }
}
