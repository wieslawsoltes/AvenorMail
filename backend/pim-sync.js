import { PimService } from './providers/pim.js';
import { error, digest } from './security.js';

const unpack = row => ({ ...JSON.parse(row.data), id: row.id, scope: row.scope, owner: row.owner, kind: row.kind, version: row.version, updated: row.updated, ...(row.deleted ? { deleted: true } : {}) });
const fields = ['provider', 'providerId', 'providerRaw', 'providerUpdatedAt', 'etag', 'sourceEtags', 'responseStatus', 'attendeeDetails', 'iCalUID', 'seriesMasterId', 'eventType', 'originalStart', 'calendarComponent', 'externalScheduling', 'retainedByPolicy', 'providerDeleted'];
const validKey = key => typeof key === 'string' && /^[A-Za-z0-9:._-]{8,200}$/.test(key);
const localConflict = () => Object.assign(error('The provider accepted this change, but the local item changed. Review its local conflict before continuing.', 409), { code: 'pim_local_conflict' });

/** Durable bridge between provider acceptance and versioned application records. */
export class PimGateway {
  constructor({ db, providers, env, emit, permissions, auth, coordinator, compliance, service }) {
    Object.assign(this, { db, providers, env, emit, permissions, auth, coordinator, compliance });
    this.service = service || new PimService({ db, providers, env, emit: (owner, event) => emit('user:' + owner, event) });
    this.service.migrate();
    db.exec(`CREATE TABLE IF NOT EXISTS pim_local_operations(record_id TEXT PRIMARY KEY,owner TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,record TEXT NOT NULL,kind TEXT NOT NULL,method TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,result TEXT,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pim_gateway_resolutions(owner TEXT NOT NULL,account_id TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,intent TEXT NOT NULL,status TEXT NOT NULL,result TEXT,updated INTEGER NOT NULL,PRIMARY KEY(owner,account_id,key));`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(pim_local_operations)').all().map(column => column.name));
      if (!columns.has('accepted_result')) db.exec('ALTER TABLE pim_local_operations ADD COLUMN accepted_result TEXT');
      if (!columns.has('conflict_version')) db.exec('ALTER TABLE pim_local_operations ADD COLUMN conflict_version INTEGER');
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }

  locked(id) { return this.db.prepare("SELECT record_id,key,status FROM pim_local_operations WHERE record_id=? AND status IN ('submitting','unknown','conflict')").get(id); }
  async lease(accountId, fn) { return this.coordinator ? this.coordinator.withLease('pim-ingest:' + accountId, fn) : fn({ assert: () => true }); }
  account(user, accountId) { return this.providers.account(user, accountId); }

  localRow(user, id, { allowMissing = false } = {}) {
    const row = this.db.prepare('SELECT * FROM records WHERE id=?').get(id);
    if (!row && allowMissing) return null;
    if (!row || row.owner !== user.userId || row.scope !== 'user:' + user.userId) throw error('Item not found in your personal workspace', 404);
    return row;
  }

  persist(user, record) {
    if (!record?.id || !['event', 'contact'].includes(record.kind)) throw error('Provider returned an invalid calendar/contact identity', 502);
    const scope = 'user:' + user.userId, old = this.db.prepare('SELECT * FROM records WHERE id=?').get(record.id);
    if (old && (old.scope !== scope || old.owner !== user.userId || old.kind !== record.kind)) throw error('Provider record identity conflicts with another workspace', 409);
    if (this.compliance?.wasPurged(record.id)) return { ok: true, id: record.id, skipped: 'purged' };
    if (record.deleted && this.compliance && !this.compliance.canDelete(scope, record.id).allowed) {
      // Keep the held local record intact. The remote deletion can still be
      // acknowledged, preventing endless replay of a provider tombstone.
      return old ? { ...unpack(old), retainedByPolicy: true, providerDeleted: true } : { ok: true, id: record.id, skipped: 'retention' };
    }
    const data = { ...record, sample: false };
    for (const key of ['id', 'scope', 'owner', 'kind', 'version', 'updated', 'deleted']) delete data[key];
    if (record.deleted) {
      if (old && !old.deleted) this.db.prepare('UPDATE records SET deleted=1,version=version+1,updated=? WHERE id=?').run(Date.now(), record.id);
      return { ok: true, id: record.id };
    }
    if(old && !old.deleted && old.data === JSON.stringify(data)) return unpack(old);
    this.db.prepare(`INSERT INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES(?,?,?,?,?,1,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=records.version+1,updated=excluded.updated,deleted=0`).run(record.id, user.userId, scope, record.kind, JSON.stringify(data), Date.now());
    return unpack(this.db.prepare('SELECT * FROM records WHERE id=?').get(record.id));
  }

  async sync(user, accountId) {
    return this.lease(accountId, async lease => {
      const batch = await this.service.syncAccount(user, accountId);
      let pending = 0;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        lease.assert(); this.account(user, accountId);
        for (const record of batch) {
          // Preserve a staged local conflict while allowing unrelated provider
          // changes and the durable cursor to progress.
          if (this.locked(record.id)) { pending++; continue; }
          this.persist(user, record);
        }
        this.service.acknowledgeSync(user, accountId, batch.batchId);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.emit('user:' + user.userId, { type: 'record-change' });
      return { count: batch.length - pending, pending, collections: batch.collections };
    });
  }

  stageConflict(user, accountId, record, accepted, { key, signature, method, version }) {
    const current = this.localRow(user, record.id, { allowMissing: true });
    this.db.prepare(`INSERT INTO pim_local_operations(record_id,owner,key,signature,record,kind,method,version,status,result,updated,accepted_result,conflict_version)
      VALUES(?,?,?,?,?,?,?,?,'conflict',NULL,?,?,?) ON CONFLICT(record_id) DO UPDATE SET owner=excluded.owner,key=excluded.key,signature=excluded.signature,record=excluded.record,kind=excluded.kind,method=excluded.method,version=excluded.version,status='conflict',result=NULL,updated=excluded.updated,accepted_result=excluded.accepted_result,conflict_version=excluded.conflict_version`)
      .run(record.id, user.userId, key, signature, JSON.stringify({ ...record, accountId }), record.kind, method, version, Date.now(), JSON.stringify(accepted), current?.version || 0);
  }

  async write({ user, accountId, kind, record, method, version = 0, key, signature }) {
    if (!validKey(key)) throw error('An idempotency key is required for provider changes');
    return this.lease(accountId, async lease => {
      const id = record.id || digest(user.userId + ':/api/record:' + key);
      record = { ...record, id, accountId, kind };
      this.account(user, accountId);
      await this.permissions.require({ user, scope: 'user:' + user.userId, recordId: method === 'create' ? undefined : id, action: 'write' });
      const intent = signature || digest(JSON.stringify({ record, method, version }));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        lease.assert(); this.account(user, accountId);
        const prior = this.db.prepare('SELECT * FROM pim_local_operations WHERE record_id=?').get(id), current = this.localRow(user, id, { allowMissing: true });
        if (prior?.key === key) {
          if (prior.owner !== user.userId || prior.signature !== intent) throw error('Operation key was used for different provider data', 409);
          if (prior.status === 'completed') { this.db.exec('COMMIT'); return JSON.parse(prior.result); }
          if (prior.status === 'conflict') throw localConflict();
          record = JSON.parse(prior.record); version = prior.version; method = prior.method; kind = prior.kind;
        } else {
          if (prior && ['submitting', 'unknown', 'conflict'].includes(prior.status)) throw error('A previous provider write awaits reconciliation. Review its pending change first.', 409);
          if (method !== 'create' && (!current || current.deleted || current.version !== version) || method === 'create' && current && (!version || current.version !== version || JSON.parse(current.data).providerId)) throw error('This item changed; reload before saving', 409);
          this.db.prepare(`INSERT INTO pim_local_operations(record_id,owner,key,signature,record,kind,method,version,status,result,updated,accepted_result,conflict_version)
            VALUES(?,?,?,?,?,?,?,?,'submitting',NULL,?,NULL,NULL) ON CONFLICT(record_id) DO UPDATE SET owner=excluded.owner,key=excluded.key,signature=excluded.signature,record=excluded.record,kind=excluded.kind,method=excluded.method,version=excluded.version,status='submitting',result=NULL,updated=excluded.updated,accepted_result=NULL,conflict_version=NULL`)
            .run(id, user.userId, key, intent, JSON.stringify(record), kind, method, version, Date.now());
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      let accepted;
      try { accepted = await this.service.writeRecord({ user, accountId, kind, record, method, idempotencyKey: key }); }
      catch (error) {
        // A fenced-out worker must not mutate its successor's operation state.
        try { lease.assert(); this.db.prepare('UPDATE pim_local_operations SET status=?,updated=? WHERE record_id=? AND key=?').run(error.uncertain || error.code === 'pim_write_uncertain' ? 'unknown' : 'rejected', Date.now(), id, key); } catch { /* durable submitting state remains recoverable */ }
        throw error;
      }
      let result, conflict = false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        lease.assert(); this.account(user, accountId);
        const current = this.localRow(user, id, { allowMissing: true });
        if (!accepted || accepted.id !== id || accepted.kind !== kind) throw error('Provider accepted an unexpected item identity', 502);
        if ((current?.version || 0) !== version || current?.deleted) {
          this.stageConflict(user, accountId, record, accepted, { key, signature: intent, method, version }); conflict = true;
        } else {
          result = this.persist(user, accepted);
          this.db.prepare("UPDATE pim_local_operations SET status='completed',result=?,accepted_result=?,updated=? WHERE record_id=? AND key=?").run(JSON.stringify(result), JSON.stringify(accepted), Date.now(), id, key);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.emit('user:' + user.userId, { type: 'record-change', recordId: id });
      if (conflict) throw localConflict();
      return result;
    });
  }

  status(user, accountId) {
    const status = this.service.status(user, accountId);
    const operations = this.db.prepare("SELECT * FROM pim_local_operations WHERE owner=? AND json_extract(record,'$.accountId')=? AND status IN ('submitting','unknown','conflict')").all(user.userId, accountId);
    return { ...status, conflicts: (status.conflicts || []).map(conflict => ({ ...conflict, version: this.localRow(user, conflict.id, { allowMissing: true })?.version || 0, remoteVersion: conflict.remoteVersion || conflict.remote?.etag || 'sha256:' + digest(JSON.stringify(conflict.remote)) })), pendingLocalWrites: operations.filter(row => row.status !== 'conflict').map(row => ({ recordId: row.record_id, status: row.status })),
      localConflicts: operations.filter(row => row.status === 'conflict').map(row => {
        const current = this.localRow(user, row.record_id, { allowMissing: true }), provider = JSON.parse(row.accepted_result);
        return { recordId: row.record_id, status: row.status, version: current?.version || 0, local: current ? unpack(current) : null, provider, expectedRemoteEtag: provider.etag || null };
      }),
    };
  }

  async resolve(user, accountId, body, key, action) {
    if (!validKey(key)) throw error('A stable idempotency key is required for conflict resolution');
    if (!Number.isInteger(body.version) || body.version < 0) throw error('The displayed local item version is required', 409);
    const allowed = action === 'recover' ? ['provider', 'local'] : ['remote', 'local'];
    if (!allowed.includes(body.resolution)) throw error('Choose the provider version or reapply your local version');
    return this.lease(accountId, async lease => {
      this.account(user, accountId);
      const signature = digest(JSON.stringify({ action, recordId: body.recordId, resolution: body.resolution, version: body.version, expectedRemoteEtag: body.expectedRemoteEtag ?? null }));
      let intent;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        lease.assert();
        const prior = this.db.prepare('SELECT * FROM pim_gateway_resolutions WHERE owner=? AND account_id=? AND key=?').get(user.userId, accountId, key);
        if (prior) {
          if (prior.signature !== signature) throw error('Resolution key was used for a different choice', 409);
          if (prior.status === 'completed') { this.db.exec('COMMIT'); return JSON.parse(prior.result); }
          if (prior.status === 'conflict') throw localConflict();
          intent = JSON.parse(prior.intent);
        } else {
          const current = this.localRow(user, body.recordId, { allowMissing: true });
          if ((current?.version || 0) !== body.version) throw error('This item changed; refresh the comparison before resolving it', 409);
          let provider;
          if (action === 'recover') {
            const operation = this.db.prepare("SELECT * FROM pim_local_operations WHERE record_id=? AND owner=? AND status='conflict'").get(body.recordId, user.userId);
            if (!operation || JSON.parse(operation.record).accountId !== accountId) throw error('Local provider conflict not found', 404);
            provider = JSON.parse(operation.accepted_result);
            if (!Object.hasOwn(body, 'expectedRemoteEtag') || (provider.etag || null) !== body.expectedRemoteEtag) throw error('The provider comparison changed; refresh before resolving it', 409);
            if (body.resolution === 'local' && !current) throw error('There is no local version to reapply', 409);
          } else {
            if (this.locked(body.recordId)) throw error('Resolve the pending local provider operation first', 409);
            if (!current) throw error('Calendar/contact item not found', 404);
            const remoteConflict = (this.service.status(user, accountId).conflicts || []).find(conflict => conflict.id === body.recordId);
            if (!remoteConflict) throw error('Provider conflict not found', 404);
            if (!Object.hasOwn(body, 'expectedRemoteEtag') || (remoteConflict.remoteVersion || remoteConflict.remote?.etag || 'sha256:' + digest(JSON.stringify(remoteConflict.remote))) !== body.expectedRemoteEtag) throw error('The provider comparison changed; refresh before resolving it', 409);
          }
          intent = { action, recordId: body.recordId, resolution: body.resolution, version: body.version, expectedRemoteEtag: body.expectedRemoteEtag, local: current ? unpack(current) : null, provider };
          this.db.prepare("INSERT INTO pim_gateway_resolutions(owner,account_id,key,signature,intent,status,result,updated) VALUES(?,?,?,?,?,'submitting',NULL,?)").run(user.userId, accountId, key, signature, JSON.stringify(intent), Date.now());
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      let accepted;
      if (action === 'conflicts') accepted = await this.service.resolveConflict({ user, accountId, recordId: intent.recordId, resolution: intent.resolution, idempotencyKey: key, expectedRemoteEtag: intent.expectedRemoteEtag });
      else if (intent.resolution === 'provider') accepted = intent.provider;
      else {
        const record = { ...intent.local };
        for (const field of fields) if (Object.hasOwn(intent.provider, field)) record[field] = intent.provider[field];
        record.accountId = accountId;
        const method = intent.local.deleted ? 'delete' : intent.provider.deleted ? 'create' : 'update';
        if (method === 'delete' && this.compliance && !this.compliance.canDelete('user:' + user.userId, record.id).allowed) throw error('This item is protected by a retention policy or legal hold', 403);
        accepted = await this.service.writeRecord({ user, accountId, kind: record.kind, record, method, idempotencyKey: key });
      }
      let result, conflict = false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        lease.assert(); this.account(user, accountId);
        const current = this.localRow(user, intent.recordId, { allowMissing: true });
        if (!accepted || accepted.id !== intent.recordId) throw error('Provider conflict returned an unexpected item identity', 502);
        if ((current?.version || 0) !== intent.version) {
          this.stageConflict(user, accountId, intent.local || accepted, accepted, { key, signature, method: 'update', version: intent.version });
          this.db.prepare("UPDATE pim_gateway_resolutions SET status='conflict',result=?,updated=? WHERE owner=? AND account_id=? AND key=?").run(JSON.stringify(accepted), Date.now(), user.userId, accountId, key);
          conflict = true;
        } else {
          result = this.persist(user, accepted);
          this.db.prepare("UPDATE pim_gateway_resolutions SET status='completed',result=?,updated=? WHERE owner=? AND account_id=? AND key=?").run(JSON.stringify(result), Date.now(), user.userId, accountId, key);
          if (action === 'recover') this.db.prepare("UPDATE pim_local_operations SET status='completed',result=?,accepted_result=?,updated=? WHERE record_id=? AND owner=?").run(JSON.stringify(result), JSON.stringify(accepted), Date.now(), intent.recordId, user.userId);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.emit('user:' + user.userId, { type: 'record-change', recordId: intent.recordId });
      if (conflict) throw localConflict();
      return result;
    });
  }

  async recordRequest(request, user, body, row) {
    const current = row ? unpack(row) : null, kind = current?.kind || body.kind, values = request.method === 'POST' ? body.data : body.patch || {};
    if (!['event', 'contact'].includes(kind) || current?.externalScheduling) return null;
    if (fields.some(field => Object.hasOwn(values || {}, field))) throw error('Provider identities, versions and scheduling metadata are managed by the server');
    if (current?.providerId && Object.hasOwn(values, 'accountId') && values.accountId !== current.accountId) throw error('A provider item cannot be moved to another account');
    const accountId = current?.accountId || values?.accountId;
    if (!accountId) return null;
    const scope = current?.scope || body.scope || 'user:' + user.userId;
    if (scope !== 'user:' + user.userId) throw error('Connected calendar and contact records belong in their owner’s personal workspace', 403);
    const result = await this.write({ user, accountId, kind, record: { ...current, ...values }, method: request.method === 'POST' ? 'create' : request.method === 'DELETE' ? 'delete' : 'update', version: body.version || 0, key: request.headers.get('idempotency-key'), signature: digest(request.method + JSON.stringify(body)) });
    return Response.json(result, { status: request.method === 'POST' ? 201 : 200 });
  }

  async handle(request, user) {
    const url = new URL(request.url), match = url.pathname.match(/^\/api\/pim\/([^/]+)(?:\/(sync|conflicts|publish|recover))?$/);
    if (!match) return null;
    const accountId = decodeURIComponent(match[1]), action = match[2], body = request.method === 'POST' ? await request.json() : {};
    if (!action && request.method === 'GET') return Response.json(this.status(user, accountId));
    if (action === 'sync' && request.method === 'POST') return Response.json(await this.sync(user, accountId));
    if (['conflicts', 'recover'].includes(action) && request.method === 'POST') return Response.json(await this.resolve(user, accountId, body, body.idempotencyKey || request.headers.get('idempotency-key'), action));
    if (action === 'publish' && request.method === 'POST') {
      const row = this.localRow(user, body.recordId), record = unpack(row);
      if (row.deleted || !['event', 'contact'].includes(record.kind) || record.providerId) throw error('Choose a local calendar event or contact');
      if (row.version !== body.version) throw error('Item changed; reload before publishing', 409);
      return Response.json(await this.write({ user, accountId, kind: row.kind, record: { ...record, collectionId: body.collectionId }, method: 'create', version: body.version, key: request.headers.get('idempotency-key'), signature: digest(JSON.stringify(body)) }));
    }
    return Response.json({ error: 'Unsupported provider calendar/contact operation' }, { status: 405 });
  }
}
