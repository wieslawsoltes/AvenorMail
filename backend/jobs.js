import { createHash, randomUUID } from 'node:crypto';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const userId = user => user?.userId || user?.id;
const digest = value => createHash('sha256').update(value).digest('hex');
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const publicJob = row => row && ({ id: row.id, type: row.type, payload: parse(row.payload), owner: row.owner, scope: row.scope, status: row.status, runAt: row.run_at, attempts: row.attempts, error: row.error, created: row.created, updated: row.updated });

export async function readJobBody(request) {
  if (Number(request.headers.get('content-length') || 0) > 32000) fail('Request is too large', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('A request body is required');
  const chunks = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 32000) { await reader.cancel(); fail('Request is too large', 413); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('Invalid JSON'); }
}

/** Synchronous SQLite transactions only: never hold a transaction across a handler await. */
export class DurableScheduler {
  constructor({ db, handlers = {}, now = Date.now, emit = () => {}, authorize, allowedOrigins = [], intervalMs = 1000, leaseMs = 60000, maxAttempts = 5 }) {
    Object.assign(this, { db, handlers, now, emit, authorize, allowedOrigins, intervalMs, leaseMs, maxAttempts });
    this.emit = event => emit(event.scope, { ...event, type: event.type === 'record' ? 'record-change' : `${event.type}-change`, ...(event.type === 'record' ? { recordId: event.id } : {}) });
    this.workerId = randomUUID(); this.timer = null; this.running = false;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
        owner TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        run_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5, lease_owner TEXT, lease_until INTEGER,
        accepted_at INTEGER, completed_at INTEGER, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
      CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, scope, created);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, record_id TEXT,
        type TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
        created INTEGER NOT NULL, read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS notification_owner ON notifications(owner, created);
      CREATE TABLE IF NOT EXISTS automation_state (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
    `);
    return this;
  }

  start() {
    this.migrate();
    if (!this.timer) { this.timer = setInterval(() => this.runDue().catch(error => console.error('Background scheduler failed', error)), this.intervalMs); this.timer.unref?.(); void this.runDue().catch(error => console.error('Background scheduler failed', error)); }
    return this;
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  enqueue({ id = randomUUID(), type, payload = {}, runAt = this.now(), owner, scope }) {
    const at = stamp(runAt);
    if (!type || !owner || !scope || !Number.isFinite(at)) fail('A job type, owner, workspace and valid run time are required');
    const encoded = JSON.stringify(payload); if (encoded.length > 180000) fail('Job is too large', 413);
    const now = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO jobs(id,type,payload,owner,scope,run_at,max_attempts,created,updated) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, type, encoded, owner, scope, at, this.maxAttempts, now, now);
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (row.type !== type || row.owner !== owner || row.scope !== scope || row.payload !== encoded || row.run_at !== at && row.attempts === 0) fail('This job identifier is already in use', 409);
    return publicJob(row);
  }

  async allowed(user, scope, recordId, action, extra = {}) {
    if (!userId(user)) fail('Sign in to open your workspace', 401);
    if (this.authorize) { if (await this.authorize({ user, scope, recordId, action, ...extra }) !== true) fail('You do not have access to this workspace', 403); }
    else if (scope !== `user:${userId(user)}`) fail('You do not have access to this workspace', 403);
  }

  async cancel(id, user) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row || row.owner !== userId(user)) fail('Job not found', 404);
    await this.allowed(user, row.scope, parse(row.payload).recordId, 'cancel-job');
    if (row.status === 'cancelled') return publicJob(row);
    const payload = parse(row.payload); let changedRecord;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare("UPDATE jobs SET status='cancelled',updated=? WHERE id=? AND status='pending'").run(this.now(), id);
      if (!result.changes) fail('This job has started or finished and cannot be cancelled', 409);
      if (row.type === 'send' && this.hasRecords()) {
        const record = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(payload.recordId);
        if (record) {
          const data = parse(record.data);
          if (data.scheduledJobId === id && record.version === payload.version) {
            delete data.scheduledAt; delete data.scheduledJobId; data.folder = 'drafts';
            this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=? AND version=?').run(JSON.stringify(data), this.now(), record.id, record.version);
            changedRecord = record;
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (changedRecord) this.emit({ type: 'record', scope: changedRecord.scope, owner: changedRecord.owner, id: changedRecord.id });
    this.emit({ type: 'job', scope: row.scope, owner: row.owner, id, status: 'cancelled' });
    return publicJob(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  }

  claim() {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A crashed worker may have reached a transport. Retrying a delivery risks sending twice.
      this.db.prepare(`UPDATE jobs SET status=CASE WHEN type IN ('provider_sync','automation') AND accepted_at IS NULL THEN 'pending' ELSE 'unknown' END,
        error='Worker lease expired; delivery acceptance could not be confirmed',lease_owner=NULL,lease_until=NULL,updated=?
        WHERE status='running' AND lease_until<=?`).run(now, now);
      const row = this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND run_at<=? ORDER BY run_at,created,id LIMIT 1").get(now);
      if (row) this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated=? WHERE id=? AND status='pending'").run(this.workerId, now + this.leaseMs, now, row.id);
      this.db.exec('COMMIT');
      return row ? this.db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id) : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async runDue() {
    if (this.running) return [];
    this.running = true; const results = [];
    try {
      this.scanRecords();
      for (let count = 0; count < 100; count++) {
        const row = this.claim(); if (!row) break;
        let accepted = !!row.accepted_at; const controller = new AbortController();
        const heartbeat = setInterval(() => {
          try { const result = this.db.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND status='running' AND lease_owner=?").run(this.now() + this.leaseMs, row.id, this.workerId); if (!result.changes) controller.abort(); } catch { controller.abort(); }
        }, Math.max(100, Math.floor(this.leaseMs / 3)));
        heartbeat.unref?.();
        const markAccepted = () => { accepted = true; this.db.prepare("UPDATE jobs SET accepted_at=?,updated=? WHERE id=? AND status='running' AND lease_owner=?").run(this.now(), this.now(), row.id, this.workerId); };
        let status, errorText = null, nextAt = row.run_at;
        try {
          const handler = this.handlers[row.type];
          if (!handler) throw Object.assign(new Error(`No handler configured for ${row.type}`), { retryable: false });
          const result = await handler(parse(row.payload), { job: publicJob(row), idempotencyKey: row.id, markAccepted, signal: controller.signal });
          status = ['accepted', 'completed', 'unknown'].includes(result?.status) ? result.status : 'unknown';
          if (status === 'accepted') markAccepted();
          if (status === 'unknown') errorText = 'Delivery acceptance could not be confirmed. Check the provider before sending again.';
        } catch (error) {
          errorText = String(error.message || 'Background job failed').slice(0, 1000);
          if (accepted || error.accepted || error.status === 'unknown' || error.unknown || error.uncertain || error.code === 'provider_send_unconfirmed') status = 'unknown';
          else if (error.retryable === true && row.attempts < row.max_attempts) { status = 'pending'; nextAt = this.now() + Math.min(3600000, 1000 * 2 ** (row.attempts - 1)); }
          else status = 'failed';
        } finally { clearInterval(heartbeat); }
        this.db.prepare(`UPDATE jobs SET status=?,run_at=?,error=?,lease_owner=NULL,lease_until=NULL,completed_at=?,updated=? WHERE id=? AND status='running' AND lease_owner=?`).run(status, nextAt, errorText, ['pending'].includes(status) ? null : this.now(), this.now(), row.id, this.workerId);
        const job = publicJob(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id)); results.push(job);
        this.emit({ type: 'job', scope: row.scope, owner: row.owner, id: row.id, status: job.status });
      }
      return results;
    } finally { this.running = false; }
  }

  hasRecords() { return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get(); }
  saveRecord(row, data) {
    const result = this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=? AND version=? AND deleted=0').run(JSON.stringify(data), this.now(), row.id, row.version);
    if (result.changes) this.emit({ type: 'record', scope: row.scope, owner: row.owner, id: row.id });
    return !!result.changes;
  }

  scanRecords() {
    if (!this.hasRecords()) return;
    const now = this.now(); const changed = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT * FROM records WHERE deleted=0 AND kind IN ('message','rule','task','event','settings')").all();
      const rules = new Map(), zones = new Map();
      for (const row of rows) {
        const data = parse(row.data);
        if (row.kind === 'rule' && data.enabled !== false) { if (!rules.has(row.scope)) rules.set(row.scope, []); rules.get(row.scope).push({ ...data, id: row.id, version: row.version }); }
        if (row.kind === 'settings' && data.timezone) zones.set(row.owner, data.timezone);
      }
      for (const row of rows) {
        const data = parse(row.data), before = JSON.stringify(data);
        if (row.kind === 'message') {
          const until = data.snoozedUntil || data.snoozeUntil;
          if (until && stamp(until) <= now && !['deleted','junk','sent','drafts','outbox'].includes(data.folder)) { data.folder = 'inbox'; data.snoozedUntil = null; delete data.snoozeUntil; }
          if (data.folder === 'inbox' && !data.snoozedUntil) {
            const active = (rules.get(row.scope) || []).sort((a, b) => a.id.localeCompare(b.id));
            const key = `rules:${row.id}`, signature = digest(active.map(r => `${r.id}:${r.version}`).join('|'));
            if (this.db.prepare('SELECT value FROM automation_state WHERE id=?').get(key)?.value !== signature) {
              for (const rule of active) if (['from','subject'].includes(rule.field) && rule.contains && String(data[rule.field] || '').toLowerCase().includes(String(rule.contains).toLowerCase())) {
                if (rule.target === 'read') data.read = true;
                else if (rule.target === 'flag') data.flagged = true;
                else if (['archive','deleted','junk'].includes(rule.target) || String(rule.target).startsWith('custom:')) data.folder = rule.target;
              }
              this.db.prepare('INSERT INTO automation_state(id,value,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(key, signature, now);
            }
          }
        }
        if (row.kind === 'task') {
          const zone = data.timezone || zones.get(row.owner) || 'UTC';
          let today; try { today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)); } catch { today = new Date(now).toISOString().slice(0, 10); }
          let lastDay; try { lastDay = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.updated)); } catch { lastDay = new Date(row.updated).toISOString().slice(0, 10); }
          if (data.myDay && (data.myDayDate || lastDay) < today) { data.myDay = false; data.myDayDate = null; }
          if (data.done && ['daily','weekly','monthly'].includes(data.repeat) && data.due) {
            const recurringId = `${row.id}:repeat:${data.due}`;
            if (!this.db.prepare('SELECT id FROM automation_state WHERE id=?').get(recurringId)) {
              const next = nextTaskDate(data.due, data.repeat);
              if (next && (!data.until || next <= data.until)) {
                const replacement = { ...data, due: next, done: false, myDay: false, myDayDate: null, steps: (data.steps || []).map(step => ({ ...step, done: false })), recurrenceParent: row.id };
                if (data.reminder && Number.isFinite(stamp(data.reminder))) replacement.reminder = new Date(stamp(data.reminder) + (Date.parse(next) - Date.parse(data.due))).toISOString();
                const id = `task:${digest(recurringId).slice(0, 32)}`;
                this.db.prepare("INSERT OR IGNORE INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES(?,?,?,'task',?,1,?,0)").run(id, row.owner, row.scope, JSON.stringify(replacement), now);
                changed.push({ type: 'record', scope: row.scope, owner: row.owner, id });
              }
              this.db.prepare('INSERT INTO automation_state(id,value,updated) VALUES(?,?,?)').run(recurringId, next || '', now);
            }
          }
        }
        if (['task','event'].includes(row.kind) && !data.done && data.reminder && Number.isFinite(stamp(data.reminder)) && stamp(data.reminder) <= now) {
          const id = `reminder:${digest(`${row.id}:${data.reminder}`)}`;
          const inserted = this.db.prepare('INSERT OR IGNORE INTO notifications(id,owner,scope,record_id,type,title,data,created) VALUES(?,?,?,?,?,?,?,?)').run(id, row.owner, row.scope, row.id, 'reminder', data.title || 'Reminder', JSON.stringify({ reminder: data.reminder, kind: row.kind }), now);
          if (inserted.changes) changed.push({ type: 'notification', scope: row.scope, owner: row.owner, id });
        }
        if (JSON.stringify(data) !== before) {
          this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=? AND version=?').run(JSON.stringify(data), now, row.id, row.version);
          changed.push({ type: 'record', scope: row.scope, owner: row.owner, id: row.id });
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const event of changed) this.emit(event);
  }

  async handle(request, user) {
    try {
      const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
      if (!/^\/api\/(jobs|notifications)(\/|$)/.test(path)) return null;
      if (!userId(user)) fail('Sign in to open your workspace', 401);
      if (!['GET','HEAD'].includes(request.method) && request.headers.get('origin') && request.headers.get('origin') !== url.origin && !this.allowedOrigins.includes(request.headers.get('origin'))) fail('This request must come from Avenor', 403);
      if (path === '/api/jobs' && request.method === 'GET') {
        const scope = url.searchParams.get('scope') || `user:${userId(user)}`; await this.allowed(user, scope, undefined, 'read-jobs');
        return json({ jobs: this.db.prepare('SELECT * FROM jobs WHERE owner=? AND scope=? ORDER BY created DESC LIMIT 200').all(userId(user), scope).map(publicJob) });
      }
      if (path === '/api/jobs' && request.method === 'POST') {
        const body = await readJobBody(request), runAt = stamp(body.runAt || body.date || body.scheduledAt), recordId = body.recordId || body.id;
        if ((body.type || 'send') !== 'send') fail('Only scheduled send can be requested here');
        if (!Number.isFinite(runAt) || runAt <= this.now() || runAt > this.now() + 366 * 86400000) fail('Choose a future send time within the next year');
        const row = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(recordId);
        if (!row) fail('Draft not found', 404);
        await this.allowed(user, row.scope, row.id, 'schedule-send', { accountId: body.accountId, version: body.version });
        const data = parse(row.data); if (row.kind !== 'message' || !['drafts','outbox'].includes(data.folder)) fail('Open a draft to schedule');
        if (!Number.isInteger(body.version) || row.version !== body.version) fail('Draft changed. Review it before scheduling.', 409);
        if (this.db.prepare("SELECT id FROM jobs WHERE type='send' AND status IN ('pending','running','unknown') AND json_extract(payload,'$.recordId')=?").get(row.id)) fail('This draft already has a scheduled or unresolved send', 409);
        const id = randomUUID(); data.folder = 'outbox'; data.scheduledAt = new Date(runAt).toISOString(); data.scheduledJobId = id;
        this.db.exec('BEGIN IMMEDIATE');
        let job;
        try {
          const update = this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=? AND version=? AND deleted=0').run(JSON.stringify(data), this.now(), row.id, body.version);
          if (!update.changes) fail('Draft changed. Review it before scheduling.', 409);
          job = this.enqueue({ id, type: 'send', payload: { recordId: row.id, version: row.version + 1, accountId: body.accountId || null, user: { userId: userId(user), email: user.email, displayName: user.displayName || user.name || user.fullName } }, runAt, owner: userId(user), scope: row.scope });
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        this.emit({ type: 'record', scope: row.scope, owner: row.owner, id: row.id });
        return json({ job, record: { ...data, id: row.id, kind: row.kind, scope: row.scope, owner: row.owner, version: row.version + 1, updated: this.now() } }, 201);
      }
      if (/^\/api\/jobs\/[^/]+$/.test(path) && request.method === 'DELETE') return json({ job: await this.cancel(decodeURIComponent(path.split('/').at(-1)), user) });
      if (path === '/api/notifications' && request.method === 'GET') {
        const scope = url.searchParams.get('scope') || `user:${userId(user)}`; await this.allowed(user, scope, undefined, 'read-notifications');
        return json({ notifications: this.db.prepare('SELECT * FROM notifications WHERE owner=? AND scope=? ORDER BY created DESC LIMIT 200').all(userId(user), scope).map(row => ({ id: row.id, scope: row.scope, recordId: row.record_id, type: row.type, title: row.title, data: parse(row.data), created: row.created, read: !!row.read_at })) });
      }
      if ((path === '/api/notifications' || /^\/api\/notifications\/[^/]+$/.test(path)) && request.method === 'PATCH') {
        const body = await readJobBody(request), id = path === '/api/notifications' ? body.id : decodeURIComponent(path.split('/').at(-1));
        const row = this.db.prepare('SELECT * FROM notifications WHERE id=? AND owner=?').get(id, userId(user)); if (!row) fail('Notification not found', 404);
        await this.allowed(user, row.scope, row.record_id, 'read-notifications');
        this.db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND owner=?').run(body.read === false ? null : this.now(), row.id, userId(user)); return json({ ok: true });
      }
      return json({ error: 'Endpoint not found' }, 404);
    } catch (error) { return json({ error: error.status ? error.message : 'Background request failed' }, error.status || 500); }
  }
}

export function nextTaskDate(date, repeat) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = new Date(`${date}T12:00:00Z`); if (!Number.isFinite(+value)) return null;
  if (repeat === 'monthly') { const day = value.getUTCDate(); value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + 1); const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate(); value.setUTCDate(Math.min(day, last)); }
  else value.setUTCDate(value.getUTCDate() + (repeat === 'weekly' ? 7 : 1));
  return value.toISOString().slice(0, 10);
}
