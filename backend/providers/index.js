import { randomUUID } from 'node:crypto';
import { ProviderLeases } from './lease.js';
import { dataKey, fail, hash, json, publicOrigin, readJSON, requireUser, seal, unseal } from './security.js';
import { authorizationRequest, fetchJSON, oauthConfig, providerIdentity, tokenRequest } from './oauth.js';
import { canonicalMime, cloudSend, fetchRaw, gmailSync, graphSync } from './cloud-mail.js';
import { sendSmtp, syncImap, updateImap, validateMailConfig } from './mail-protocols.js';
import { updateGmailMessage, updateGraphMessage, validateMessagePatch } from './mutations.js';
import { attachSharedMailbox, discoverSharedMailboxes, grantedScopes } from './shared-mailboxes.js';

const accountContext = row => `account:${row.owner}:${row.id}:${row.provider}`;
const batchContext = row => `batch:${row.owner}:${row.account_id}:${row.id}`;
const publicAccount = row => ({ id: row.id, provider: row.provider, email: row.email,
  displayName: row.display_name, status: row.status, lastSync: row.last_sync || null,
  lastError: row.last_error || null, createdAt: row.created_at, canSend: true, canSync: true,
  parentAccountId: row.parent_account_id || null, shared: Boolean(row.parent_account_id),
  ...(row.parent_account_id ? {sendPermission:'checked-at-submission',verifiedFolders:JSON.parse(row.shared_folders_json || '[]')} : {}),
  folders: JSON.parse(row.cursor_json || '{}').folders instanceof Array ? JSON.parse(row.cursor_json).folders : [],
  syncPending: Boolean(JSON.parse(row.cursor_json || '{}').cycle || JSON.parse(row.cursor_json || '{}').building) });
const encodeMessages = messages => messages.map(message => ({ ...message,
  ...(message.attachments ? { attachments: message.attachments.map(a => ({ name: a.name, type: a.type, bytesBase64: Buffer.from(a.bytes).toString('base64') })) } : {}),
}));
const decodeMessages = messages => messages.map(message => ({ ...message,
  ...(message.attachments ? { attachments: message.attachments.map(a => ({ name: a.name, type: a.type, bytes: new Uint8Array(Buffer.from(a.bytesBase64, 'base64')) })) } : {}),
}));

export class ProviderService {
  constructor({ db, env = {}, fetchImpl = fetch, emit = () => {} }) {
    this.db = db; this.env = env; this.fetchImpl = fetchImpl; this.emit = emit;
    this.leases = new ProviderLeases(db,env);
    this.syncLocks = new Map(); this.tokenLocks = new Map(); this.mutationQueues = new Map();
  }

  migrate() {
    this.leases.migrate();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_accounts (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL,
        email TEXT NOT NULL, display_name TEXT NOT NULL, provider_user_id TEXT,
        encrypted_secret TEXT NOT NULL, cursor_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'connected', last_error TEXT, last_sync INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(owner, provider, email)
      );
      CREATE INDEX IF NOT EXISTS provider_accounts_owner ON provider_accounts(owner);
      CREATE TABLE IF NOT EXISTS provider_oauth_states (
        state_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL,
        encrypted_verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_sends (
        owner TEXT NOT NULL, account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner, account_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS provider_sync_batches (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE,
        encrypted_batch TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_mutations (
        owner TEXT NOT NULL, account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        provider_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner, account_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS provider_mutations_message ON provider_mutations(owner,account_id,provider_id,status);
      CREATE TABLE IF NOT EXISTS provider_message_aliases (
        owner TEXT NOT NULL, account_id TEXT NOT NULL, alias TEXT NOT NULL, canonical TEXT NOT NULL,
        record_id TEXT NOT NULL, folder TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner, account_id, alias)
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO provider_migrations (version,applied_at) VALUES (?,?)').run(1, Date.now());
    this.db.prepare('INSERT OR IGNORE INTO provider_migrations (version,applied_at) VALUES (?,?)').run(2, Date.now());
    const columns = new Set(this.db.prepare('PRAGMA table_info(provider_accounts)').all().map(row=>row.name));
    for (const [name,type] of [['parent_account_id','TEXT'],['mailbox_target','TEXT'],['shared_folders_json',"TEXT NOT NULL DEFAULT '[]'"]]) if (!columns.has(name)) this.db.exec(`ALTER TABLE provider_accounts ADD COLUMN ${name} ${type}`);
    this.db.prepare('INSERT OR IGNORE INTO provider_migrations (version,applied_at) VALUES (?,?)').run(3, Date.now());
  }

  providerStatus() {
    let encrypted = false, origin = false;
    try { dataKey(this.env); encrypted = true; } catch { /* Surface setup state without exposing configuration values. */ }
    try { publicOrigin(this.env); origin = true; } catch { /* See above. */ }
    return ['microsoft', 'google', 'smtp'].map(id => {
      let configured = encrypted;
      if (id !== 'smtp') {
        configured &&= origin;
        try { oauthConfig(id, this.env); } catch { configured = false; }
      }
      return { id, configured, label: id === 'microsoft' ? 'Microsoft 365 / Outlook' : id === 'google' ? 'Gmail / Google Workspace' : 'SMTP / IMAP',
        ...(configured ? {} : { reason: !encrypted ? 'External mail encryption is not configured.' : !origin ? 'The public callback URL is not configured.' : 'OAuth application credentials are not configured.' }) };
    });
  }

  listAccounts(user) {
    const owner = requireUser(user);
    return this.db.prepare('SELECT * FROM provider_accounts WHERE owner=? ORDER BY created_at,id').all(owner).map(row => {
      const visible = publicAccount(row);
      if (row.parent_account_id) {
        const parent = this.account(user,row.parent_account_id), scopes = grantedScopes(parent,this.env);
        visible.canSend = scopes.has('mail.send.shared');
        visible.canSync = scopes.has('mail.read.shared') || scopes.has('mail.readwrite.shared');
        if (parent.status !== 'connected') visible.status = parent.status;
      }
      return visible;
    });
  }

  account(user, id) {
    const owner = requireUser(user);
    const row = this.db.prepare('SELECT * FROM provider_accounts WHERE owner=? AND id=?').get(owner, String(id || ''));
    if (!row) fail('Connected mail account not found.', 404, 'provider_account_not_found');
    return row;
  }

  notify(owner, event) {
    // Provider changes must remain successful if a disconnected live subscriber fails.
    try { const result = this.emit(owner, event); if (result?.catch) result.catch(() => {}); } catch { /* Best effort notification only. */ }
  }

  async addSmtpAccount(user,input) {
    const owner=requireUser(user),config=validateMailConfig(input,this.env);
    return this.leases.run('account-config:'+owner,async()=>{
      const row=this.db.prepare("SELECT id FROM provider_accounts WHERE owner=? AND provider='smtp' AND email=?").get(owner,config.email);
      return row?this.leases.run('mail:'+row.id,()=>this.performAddSmtpAccount(user,input)):this.performAddSmtpAccount(user,input);
    });
  }

  async performAddSmtpAccount(user, input) {
    const owner = requireUser(user);
    dataKey(this.env);
    const config = validateMailConfig(input, this.env);
    const existing = this.db.prepare('SELECT * FROM provider_accounts WHERE owner=? AND provider=? AND email=?').get(owner, 'smtp', config.email);
    let changedServer = false;
    if (existing) {
      try {const old=unseal(existing.encrypted_secret,this.env,accountContext(existing)).imap;changedServer=['host','port','user'].some(key=>old?.[key]!==config.imap[key]);}
      catch {changedServer=true;}
    }
    const row = { id: existing?.id || randomUUID(), owner, provider: 'smtp' };
    const now = Date.now();
    this.db.prepare(`INSERT INTO provider_accounts (id,owner,provider,email,display_name,encrypted_secret,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner,provider,email) DO UPDATE SET display_name=excluded.display_name,
      encrypted_secret=excluded.encrypted_secret,status='connected',last_error=NULL,updated_at=excluded.updated_at`).run(
      row.id, owner, 'smtp', config.email, config.displayName || config.email, seal(config, this.env, accountContext(row)), now, now);
    if (existing) this.db.prepare('DELETE FROM provider_sync_batches WHERE owner=? AND account_id=?').run(owner, row.id);
    if (changedServer) {
      this.db.prepare("UPDATE provider_accounts SET cursor_json='{}',last_sync=NULL WHERE owner=? AND id=?").run(owner,row.id);
      this.db.prepare('DELETE FROM provider_message_aliases WHERE owner=? AND account_id=?').run(owner,row.id);
    }
    this.notify(owner, { type: 'accounts-changed' });
    return publicAccount(this.account(user, row.id));
  }

  startOAuth(user, provider) {
    const owner = requireUser(user);
    dataKey(this.env);
    const request = authorizationRequest(provider, this.env);
    const stateHash = hash(request.state);
    const now = Date.now();
    this.db.prepare('DELETE FROM provider_oauth_states WHERE expires_at<?').run(now);
    this.db.prepare(`INSERT INTO provider_oauth_states (state_hash,owner,provider,encrypted_verifier,redirect_uri,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      stateHash, owner, provider, seal({ verifier: request.verifier }, this.env, `oauth:${owner}:${stateHash}`), request.redirectUri, now + 10 * 60000, now);
    return { url: request.url };
  }

  async callback(provider, url, user) {
    const state = url.searchParams.get('state') || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) fail('The mail authorization state is missing or invalid.', 400, 'oauth_state_invalid');
    const stateHash = hash(state);
    const record = this.db.prepare('SELECT * FROM provider_oauth_states WHERE state_hash=?').get(stateHash);
    if (!record || record.provider !== provider || record.expires_at <= Date.now()) fail('The mail authorization expired or was already used. Start again.', 400, 'oauth_state_invalid');
    if (user?.userId && String(user.userId) !== record.owner) fail('This authorization belongs to a different signed-in user.', 403, 'oauth_owner_mismatch');
    // Consume synchronously before any network request, including provider denials.
    if (!this.db.prepare('DELETE FROM provider_oauth_states WHERE state_hash=?').run(stateHash).changes) fail('This authorization was already used.', 400, 'oauth_state_invalid');
    if (url.searchParams.has('error')) fail('Mail authorization was canceled or denied. Start again to connect.', 400, 'oauth_denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 8192) fail('The mail authorization code is missing or invalid.');
    const { verifier } = unseal(record.encrypted_verifier, this.env, `oauth:${record.owner}:${stateHash}`);
    const tokens = await tokenRequest(provider, this.env, this.fetchImpl, { grant_type: 'authorization_code', code,
      redirect_uri: record.redirect_uri, code_verifier: verifier });
    const identity = await providerIdentity(provider, tokens.accessToken, this.fetchImpl);
    const existing = this.db.prepare('SELECT * FROM provider_accounts WHERE owner=? AND provider=? AND email=?').get(record.owner, provider, identity.email);
    const row = { id: existing?.id || randomUUID(), owner: record.owner, provider };
    if (!tokens.refreshToken && existing) tokens.refreshToken = unseal(existing.encrypted_secret, this.env, accountContext(existing)).refreshToken;
    if (!tokens.refreshToken) fail('The provider did not grant offline access. Revoke the old app consent and connect again.', 409, 'oauth_offline_access_required');
    const now = Date.now();
    await this.leases.run('credentials:'+row.id,async()=>{
    this.db.prepare(`INSERT INTO provider_accounts (id,owner,provider,email,display_name,provider_user_id,encrypted_secret,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,provider,email) DO UPDATE SET display_name=excluded.display_name,
      provider_user_id=excluded.provider_user_id,encrypted_secret=excluded.encrypted_secret,status='connected',last_error=NULL,updated_at=excluded.updated_at`).run(
      row.id, row.owner, provider, identity.email, identity.displayName, identity.providerUserId, seal(tokens, this.env, accountContext(row)), now, now);
    });
    this.notify(row.owner, { type: 'accounts-changed' });
    let frontend;
    try { frontend = new URL(this.env.FRONTEND_URL || publicOrigin(this.env)); } catch { fail('FRONTEND_URL is invalid.', 503); }
    if (!['http:', 'https:'].includes(frontend.protocol) || frontend.username || frontend.password) fail('FRONTEND_URL is invalid.', 503);
    frontend.searchParams.set('mailConnected', provider);
    return new Response(null, { status: 303, headers: { Location: frontend.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }

  async accessToken(account, force = false) {
    if (account.parent_account_id) return this.accessToken(this.account({userId:account.owner},account.parent_account_id),force);
    if (this.tokenLocks.has(account.id)) return this.tokenLocks.get(account.id);
    const task = this.leases.run('credentials:'+account.id,async () => {
      const row = this.account({ userId: account.owner }, account.id);
      const secret = unseal(row.encrypted_secret, this.env, accountContext(row));
      if (!force && secret.expiresAt > Date.now() + 60000 && secret.accessToken) return secret.accessToken;
      if (!secret.refreshToken) fail('Reconnect this mailbox to renew authorization.', 409, 'provider_reconnect_required');
      let refreshed;
      try { refreshed = await tokenRequest(row.provider, this.env, this.fetchImpl, { grant_type: 'refresh_token', refresh_token: secret.refreshToken }); }
      catch (error) {
        if (error.providerStatus === 400 || error.providerStatus === 401) {
          this.db.prepare("UPDATE provider_accounts SET status='reconnect_required',last_error=?,updated_at=? WHERE id=? AND owner=?").run('Mail authorization expired. Reconnect this account.', Date.now(), row.id, row.owner);
          fail('Mail authorization expired. Reconnect this account.', 409, 'provider_reconnect_required');
        }
        throw error;
      }
      this.leases.assertCurrent();
      refreshed.refreshToken ||= secret.refreshToken;
      if (!refreshed.scopeProvided) refreshed.scope=secret.scope || '';
      delete refreshed.scopeProvided;
      this.db.prepare("UPDATE provider_accounts SET encrypted_secret=?,status='connected',last_error=NULL,updated_at=? WHERE id=? AND owner=?").run(seal(refreshed, this.env, accountContext(row)), Date.now(), row.id, row.owner);
      return refreshed.accessToken;
    });
    this.tokenLocks.set(account.id, task);
    try { return await task; } finally { this.tokenLocks.delete(account.id); }
  }

  async api(account, url, init = {}, raw = false) {
    account=this.account({userId:account.owner},account.id);
    let target;
    try { target = new URL(url); } catch { fail('The provider returned an invalid continuation URL.', 502); }
    const allowed = account.provider === 'microsoft' ? target.hostname === 'graph.microsoft.com' && target.pathname.startsWith('/v1.0/') :
      account.provider === 'google' && (target.hostname === 'gmail.googleapis.com' && target.pathname.startsWith('/gmail/v1/users/me/') ||
        target.hostname === 'www.googleapis.com' && target.pathname.startsWith('/calendar/v3/') ||
        target.hostname === 'people.googleapis.com' && target.pathname.startsWith('/v1/'));
    if (target.protocol !== 'https:' || !allowed || (target.port && target.port !== '443') || target.username || target.password || target.hash) fail('The provider returned an unsafe continuation URL.', 502, 'provider_invalid_url');
    if (account.parent_account_id) {
      const prefix = `/v1.0/users/${encodeURIComponent(account.mailbox_target)}`;
      if (/^\/v1\.0\/me(?:\/|$)/.test(target.pathname)) target.pathname = target.pathname.replace(/^\/v1\.0\/me/,prefix);
      const parts = target.pathname.split('/');
      if (parts[2] !== 'users' || decodeURIComponent(parts[3] || '').toLowerCase() !== account.mailbox_target.toLowerCase()) fail('A delegated mailbox continuation attempted to leave its mailbox.',502,'provider_mailbox_scope');
    }
    const token = await this.accessToken(account);
    const call = async accessToken => {
      this.leases.assertCurrent();
      const result=await (raw ? fetchRaw : fetchJSON)(this.fetchImpl, target.toString(), { ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}` } });
      this.leases.assertCurrent();return result;
    };
    try { return await call(token); }
    catch (error) {
      // A rejected bearer token has not authorized the operation. Refresh once;
      // never retry transport failures or other write errors automatically.
      if (error.providerStatus !== 401) throw error;
      return call(await this.accessToken(account, true));
    }
  }

  async cloudRequest(user, accountId, url, init = {}) {
    const account=this.account(user,accountId);
    return this.leases.run('mail:'+account.id,()=>this.api(account,url,init));
  }

  async syncAccount(user, id) {
    const account = this.account(user, id);
    if (this.syncLocks.has(account.id)) return this.syncLocks.get(account.id);
    const task = this.leases.run('mail:'+account.id,async () => {
      // Reload the checkpoint after acquiring ownership: another node may have
      // completed and acknowledged a batch while this request waited.
      const current=this.account(user,account.id);Object.assign(account,current);
      const pending = this.db.prepare('SELECT * FROM provider_sync_batches WHERE owner=? AND account_id=?').get(account.owner, account.id);
      if (pending) {
        const messages = decodeMessages(unseal(pending.encrypted_batch, this.env, batchContext(pending)).messages);
        Object.defineProperty(messages, 'batchId', { value: pending.id });
        return messages;
      }
      let previous = JSON.parse(account.cursor_json || '{}');
      if (account.provider === 'smtp' && previous.schemaVersion !== 3) {
        const entries = {};
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get()) {
          for (const row of this.db.prepare("SELECT data FROM records WHERE owner=? AND kind='message' AND json_extract(data,'$.accountId')=?").all(account.owner,account.id)) {
            const message = JSON.parse(row.data), id = message.providerId;
            if (typeof id !== 'string' || !id.startsWith('imap:')) continue;
            entries[id] = {mailbox:message.providerMailbox || 'INBOX',folder:message.folder,read:message.read,flagged:message.flagged};
          }
        }
        previous = {schemaVersion:3,entries,cycle:null};
      }
      const configuredLimit = Number(this.env.PROVIDER_SYNC_LIMIT);
      const limit = Number.isInteger(configuredLimit) ? Math.min(500, Math.max(6, configuredLimit)) : 100;
      let result;
      try {
        if (account.provider === 'smtp') result = await syncImap(unseal(account.encrypted_secret, this.env, accountContext(account)), previous, this.env);
        else {
          const api = (url, init) => this.api(account, url, init);
          result = account.provider === 'microsoft' ? await graphSync(api, (url, init) => this.api(account, url, init, true), previous, limit, account.parent_account_id ? {folders:JSON.parse(account.shared_folders_json || '[]').map(folder=>folder.key)} : {}) : await gmailSync(api, previous, limit);
        }
      } catch (error) {
        this.db.prepare('UPDATE provider_accounts SET last_error=?,updated_at=? WHERE id=? AND owner=?').run(error.status ? error.message : 'Mailbox synchronization failed. Try again.', Date.now(), account.id, account.owner);
        throw error;
      }
      this.leases.assertCurrent();
      const messages = [];
      const batch = { id: randomUUID(), owner: account.owner, account_id: account.id };
      this.db.exec('SAVEPOINT provider_sync_stage');
      try {
        for (const m of result.messages) {
          let alias = this.db.prepare('SELECT * FROM provider_message_aliases WHERE owner=? AND account_id=? AND alias=?').get(account.owner,account.id,String(m.providerId));
          if (alias && alias.canonical !== m.providerId && !m.previousProviderId) continue;
          if (m.deleted && alias && m.folder && alias.folder && m.folder !== alias.folder) continue;
          if (m.previousProviderId) {
            const previousAlias = this.db.prepare('SELECT * FROM provider_message_aliases WHERE owner=? AND account_id=? AND alias=?').get(account.owner,account.id,m.previousProviderId);
            const recordId = previousAlias?.record_id || `provider:${account.id}:${hash(String(m.previousProviderId)).slice(0,32)}`;
            this.db.prepare('UPDATE provider_message_aliases SET canonical=?,folder=?,updated_at=? WHERE owner=? AND account_id=? AND canonical=?').run(m.providerId,m.folder,Date.now(),account.owner,account.id,m.previousProviderId);
            for (const name of [m.previousProviderId,m.providerId]) this.db.prepare(`INSERT INTO provider_message_aliases(owner,account_id,alias,canonical,record_id,folder,updated_at) VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(owner,account_id,alias) DO UPDATE SET canonical=excluded.canonical,record_id=excluded.record_id,folder=excluded.folder,updated_at=excluded.updated_at`).run(account.owner,account.id,name,m.providerId,recordId,m.folder,Date.now());
            alias = {record_id:recordId};
          }
          const normalized = {...m,id:alias?.record_id || `provider:${account.id}:${hash(String(m.providerId)).slice(0,32)}`,accountId:account.id,provider:account.provider,sample:false};
          delete normalized.previousProviderId;
          messages.push(normalized);
        }
        this.db.prepare('INSERT INTO provider_sync_batches (id,owner,account_id,encrypted_batch,created_at) VALUES (?,?,?,?,?)').run(
          batch.id, batch.owner, batch.account_id, seal({ messages: encodeMessages(messages), cursor: result.cursor }, this.env, batchContext(batch)), Date.now());
        this.db.exec('RELEASE provider_sync_stage');
      } catch(error) { this.db.exec('ROLLBACK TO provider_sync_stage; RELEASE provider_sync_stage'); throw error; }
      Object.defineProperty(messages, 'batchId', { value: batch.id });
      return messages;
    });
    this.syncLocks.set(account.id, task);
    try { return await task; } finally { this.syncLocks.delete(account.id); }
  }

  acknowledgeSync(user, id, batchId) {
    const account = this.account(user, id);
    const batch = this.db.prepare('SELECT * FROM provider_sync_batches WHERE owner=? AND account_id=?').get(account.owner, account.id);
    if (!batch) return;
    if (batchId && batch.id !== batchId) fail('A different synchronization batch is awaiting persistence.', 409);
    const { cursor } = unseal(batch.encrypted_batch, this.env, batchContext(batch));
    this.db.exec('SAVEPOINT provider_sync_ack');
    try {
      this.db.prepare("UPDATE provider_accounts SET cursor_json=?,last_sync=?,last_error=NULL,status='connected',updated_at=? WHERE id=? AND owner=?").run(JSON.stringify(cursor), Date.now(), Date.now(), account.id, account.owner);
      this.db.prepare('DELETE FROM provider_sync_batches WHERE id=? AND owner=?').run(batch.id, account.owner);
      this.db.exec('RELEASE provider_sync_ack');
    } catch (error) { this.db.exec('ROLLBACK TO provider_sync_ack; RELEASE provider_sync_ack'); throw error; }
    this.notify(account.owner, { type: 'mail-synced', accountId: account.id });
  }

  async sendMail(input) {
    const account=this.account(input.user,input.accountId);
    return this.leases.run('mail:'+account.id,()=>this.performSendMail(input));
  }

  async performSendMail({ user, accountId, message, mime, idempotencyKey }) {
    const account = this.account(user, accountId);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) fail('A stable mail idempotency key (8–200 characters) is required.');
    if (account.parent_account_id && !grantedScopes(this.account(user,account.parent_account_id),this.env).has('mail.send.shared')) fail('Reconnect Microsoft and grant shared-mailbox send permission.',409,'provider_reconnect_required');
    const prepared = await canonicalMime(account, message, mime);
    const existing = this.db.prepare('SELECT * FROM provider_sends WHERE owner=? AND account_id=? AND idempotency_key=?').get(account.owner, account.id, idempotencyKey);
    if (existing) {
      if (existing.payload_hash !== prepared.fingerprint) fail('This send key was already used for a different message.', 409, 'idempotency_conflict');
      if (existing.status === 'accepted') return JSON.parse(existing.result_json);
      const unknown = existing.status !== 'failed';
      throw Object.assign(new Error(unknown ? 'The previous send has no confirmed outcome. Check the provider Sent folder before making a new attempt.' : 'The previous send was rejected. Review the error and explicitly create a new send attempt.'),
        { status: 409, code: unknown ? 'provider_send_unconfirmed' : 'provider_send_failed', unknown, uncertain: unknown });
    }
    // Resolve authorization before recording a potentially irreversible operation.
    if (account.provider !== 'smtp') await this.accessToken(account);
    this.leases.assertCurrent();
    const now = Date.now();
    this.db.prepare('INSERT INTO provider_sends (owner,account_id,idempotency_key,payload_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(account.owner, account.id, idempotencyKey, prepared.fingerprint, 'pending', now, now);
    let result;
    try {
      result = account.provider === 'smtp' ? await sendSmtp(unseal(account.encrypted_secret, this.env, accountContext(account)), { message, mime: prepared.mime, envelope: prepared.envelope }, this.env)
        : await cloudSend(account.provider, (url, init) => this.api(account, url, init), prepared.mime);
      this.leases.assertCurrent();
      if (result?.status !== 'accepted') fail('The provider did not confirm acceptance. Check Sent mail before retrying.', 502, 'provider_send_unconfirmed');
      this.db.prepare("UPDATE provider_sends SET status='accepted',result_json=?,updated_at=? WHERE owner=? AND account_id=? AND idempotency_key=?").run(JSON.stringify(result), Date.now(), account.owner, account.id, idempotencyKey);
      return result;
    } catch (error) {
      const definitive = error.providerStatus >= 400 && error.providerStatus < 500 || error.status === 400 || error.status === 403 || error.code === 'MAIL_RECIPIENTS_REJECTED';
      this.db.prepare('UPDATE provider_sends SET status=?,updated_at=? WHERE owner=? AND account_id=? AND idempotency_key=?').run(definitive ? 'failed' : 'unknown', Date.now(), account.owner, account.id, idempotencyKey);
      if (!definitive) { error.unknown = true; error.uncertain = true; }
      if (result?.status === 'accepted') error.accepted = true;
      throw error;
    }
  }

  async updateMessage(user, accountId, providerId, inputPatch, { idempotencyKey } = {}) {
    const account = this.account(user, accountId);
    const patch = validateMessagePatch(inputPatch);
    if (typeof providerId !== 'string' || !providerId || providerId.length > 2048 || /[\r\n\0]/.test(providerId)) fail('A valid provider message identifier is required.', 400);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) fail('A stable provider mutation key (8–200 characters) is required.', 400);
    const before = this.mutationQueues.get(account.id) || Promise.resolve();
    const task = before.catch(() => {}).then(() => this.leases.run('mail:'+account.id,()=>this.performMessageMutation(account, providerId, patch, idempotencyKey)));
    this.mutationQueues.set(account.id, task);
    try { return await task; } finally { if (this.mutationQueues.get(account.id) === task) this.mutationQueues.delete(account.id); }
  }

  async performMessageMutation(account, originalId, patch, key) {
    // Content identity uses the caller's original reference; aliases only
    // redirect the actual operation after an earlier MOVE was acknowledged.
    const fingerprint = hash(JSON.stringify({ providerId: originalId, patch }));
    const prior = this.db.prepare('SELECT * FROM provider_mutations WHERE owner=? AND account_id=? AND idempotency_key=?').get(account.owner,account.id,key);
    if (prior) {
      if (prior.payload_hash !== fingerprint) fail('This mutation key was already used for a different change.', 409, 'idempotency_conflict');
      if (prior.status === 'applied') return JSON.parse(prior.result_json);
      const unknown = prior.status !== 'failed';
      throw Object.assign(new Error(unknown ? 'A prior provider change has an unknown outcome. Reconcile the mailbox before continuing.' : 'The previous provider change was rejected. Review it before creating a new operation.'),
        { status:409, code:unknown ? 'provider_mutation_unconfirmed' : 'provider_mutation_failed', unknown, uncertain:unknown, retryable:false });
    }
    const alias = this.db.prepare('SELECT * FROM provider_message_aliases WHERE owner=? AND account_id=? AND alias=?').get(account.owner,account.id,originalId);
    const currentId = alias?.canonical || originalId;
    const unresolved = this.db.prepare("SELECT 1 FROM provider_mutations WHERE owner=? AND account_id=? AND provider_id=? AND status IN ('pending','unknown') LIMIT 1").get(account.owner,account.id,currentId);
    if (unresolved) throw Object.assign(new Error('An earlier change to this message is unresolved. Reconcile it before applying newer changes.'), {status:409,code:'provider_mutation_unconfirmed',unknown:true,uncertain:true,retryable:false});
    if (account.provider !== 'smtp') {
      await this.accessToken(account);
      const fresh = this.account({ userId: account.owner },account.parent_account_id || account.id);
      const secret = unseal(fresh.encrypted_secret,this.env,accountContext(fresh));
      const scopes = String(secret.scope || '').toLowerCase().split(/\s+/);
      const allowed = account.provider === 'google' ? scopes.includes('https://www.googleapis.com/auth/gmail.modify') || scopes.includes('https://mail.google.com/') : scopes.some(scope => {const name=account.parent_account_id?'mail.readwrite.shared':'mail.readwrite';return scope===name || scope.endsWith('/'+name);});
      if (!allowed) fail('Reconnect this mailbox and grant permission to update messages.',409,'provider_reconnect_required');
    }
    this.leases.assertCurrent();
    const now = Date.now();
    this.db.prepare('INSERT INTO provider_mutations (owner,account_id,idempotency_key,provider_id,payload_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(account.owner,account.id,key,currentId,fingerprint,'pending',now,now);
    let writes = 0, confirmedWrites = 0, result;
    const api = async (url, init = {}) => {
      const write = !['GET','HEAD'].includes(init.method || 'GET');
      if (write) writes++;
      const value = await this.api(account,url,init);
      if (write) confirmedWrites++;
      return value;
    };
    try {
      result = account.provider === 'smtp' ? await updateImap(unseal(account.encrypted_secret,this.env,accountContext(account)),currentId,patch,this.env) :
        account.provider === 'microsoft' ? await updateGraphMessage(api,currentId,patch) : await updateGmailMessage(api,currentId,patch);
      this.leases.assertCurrent();
      if (result?.status !== 'applied' || !result.providerId) fail('The provider did not confirm the update.',502,'provider_mutation_unconfirmed');
      const recordId = alias?.record_id || `provider:${account.id}:${hash(originalId).slice(0,32)}`;
      const folder = result.folder || alias?.folder || null;
      this.db.exec('SAVEPOINT provider_mutation_commit');
      try {
        this.db.prepare('UPDATE provider_message_aliases SET canonical=?,folder=?,updated_at=? WHERE owner=? AND account_id=? AND canonical=?').run(result.providerId,folder,Date.now(),account.owner,account.id,currentId);
        for (const name of new Set([originalId,currentId,result.providerId])) this.db.prepare(`INSERT INTO provider_message_aliases(owner,account_id,alias,canonical,record_id,folder,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(owner,account_id,alias) DO UPDATE SET canonical=excluded.canonical,record_id=excluded.record_id,folder=excluded.folder,updated_at=excluded.updated_at`).run(account.owner,account.id,name,result.providerId,recordId,folder,Date.now());
        this.db.prepare("UPDATE provider_mutations SET status='applied',result_json=?,updated_at=? WHERE owner=? AND account_id=? AND idempotency_key=?").run(JSON.stringify(result),Date.now(),account.owner,account.id,key);
        this.db.exec('RELEASE provider_mutation_commit');
      } catch (error) { this.db.exec('ROLLBACK TO provider_mutation_commit; RELEASE provider_mutation_commit'); throw error; }
      this.notify(account.owner,{ type:'mail-updated',accountId:account.id,providerId:result.providerId });
      return result;
    } catch (error) {
      const unknown = Boolean(error.unknown || error.uncertain || confirmedWrites || result?.status === 'applied' || writes && !(error.providerStatus >= 400 && error.providerStatus < 500));
      error.unknown = unknown; error.uncertain = unknown; error.retryable = false;
      this.db.prepare('UPDATE provider_mutations SET status=?,updated_at=? WHERE owner=? AND account_id=? AND idempotency_key=?').run(unknown ? 'unknown' : 'failed',Date.now(),account.owner,account.id,key);
      throw error;
    }
  }

  async handle(request, user) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const oauth = path.match(/^\/api\/oauth\/(google|microsoft)\/(start|callback)$/);
    const shared = path.match(/^\/api\/accounts\/([^/]+)\/shared-mailboxes$/);
    const item = path.match(/^\/api\/accounts\/([^/]+)(?:\/(sync))?$/);
    if (path !== '/api/accounts' && !oauth && !item && !shared) return null;
    if (oauth?.[2] === 'callback' && request.method === 'GET') return this.callback(oauth[1], url, user);
    requireUser(user);
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.get('origin');
      const allowed = new Set([url.origin]);
      if (this.env.FRONTEND_URL) { try { allowed.add(new URL(this.env.FRONTEND_URL).origin); } catch { /* Invalid config never expands access. */ } }
      if (origin && !allowed.has(origin)) fail('This request must come from Avenor.', 403);
    }
    if (shared && request.method === 'GET') {const id=decodeURIComponent(shared[1]);this.account(user,id);return json(await this.leases.run('mail:'+id,()=>discoverSharedMailboxes(this,user,id,url.searchParams.get('q'))));}
    if (shared && request.method === 'POST') {const id=decodeURIComponent(shared[1]),input=await readJSON(request);this.account(user,id);return json({account:await this.leases.run('mail:'+id,()=>attachSharedMailbox(this,user,id,input))},201);}
    if (oauth?.[2] === 'start' && ['GET','POST'].includes(request.method)) return json(this.startOAuth(user, oauth[1]));
    if (path === '/api/accounts' && request.method === 'GET') return json({ accounts: this.listAccounts(user), providers: this.providerStatus() });
    if (path === '/api/accounts' && request.method === 'POST') {
      const input = await readJSON(request);
      if (input.provider !== 'smtp' && input.provider !== 'imap') fail('Connect Microsoft or Google mail through OAuth.');
      return json({ account: await this.addSmtpAccount(user, input) }, 201);
    }
    if (item && item[2] === 'sync' && request.method === 'POST') {
      const messages = await this.syncAccount(user, decodeURIComponent(item[1]));
      return json({ messages: encodeMessages(messages), count: messages.length, batchId: messages.batchId, requiresAcknowledgement: true });
    }
    if (item && !item[2] && request.method === 'DELETE') {
      const account = this.account(user, decodeURIComponent(item[1]));
      await this.leases.run('mail:'+account.id,async()=>{
        const children=this.db.prepare('SELECT id FROM provider_accounts WHERE owner=? AND parent_account_id=? ORDER BY id').all(account.owner,account.id).map(row=>row.id);
        const keys=[...children.map(id=>'mail:'+id),'credentials:'+(account.parent_account_id||account.id)];
        const hold=async index=>{
          if(index<keys.length)return this.leases.run(keys[index],()=>hold(index+1));
          const ids=[account.id,...children];this.leases.assertCurrent();
          this.db.exec('SAVEPOINT provider_disconnect');
          try {
            for (const id of ids) {
              this.db.prepare('DELETE FROM provider_sync_batches WHERE owner=? AND account_id=?').run(account.owner,id);
              this.db.prepare('DELETE FROM provider_accounts WHERE owner=? AND id=?').run(account.owner,id);
            }
            this.db.exec('RELEASE provider_disconnect');
          } catch(error) {this.db.exec('ROLLBACK TO provider_disconnect; RELEASE provider_disconnect');throw error;}
        };
        return hold(0);
      });
      this.notify(account.owner, { type: 'accounts-changed' });
      return json({ ok: true });
    }
    fail('Method not allowed for this mail endpoint.', 405);
  }
}

export default ProviderService;
