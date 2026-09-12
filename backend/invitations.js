import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readJobBody } from './jobs.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const identity = user => user?.userId || user?.id;
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizeEmail = value => { const email = String(value || '').trim().toLowerCase(); if (!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(email) || email.length > 254) fail('Enter valid attendee email addresses'); return email; };
const icalText = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const html = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const utc = value => { const date = new Date(value); if (!Number.isFinite(+date)) fail('Invalid calendar date'); return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); };
const partstats = new Set(['NEEDS-ACTION','ACCEPTED','DECLINED','TENTATIVE']);

function fold(line) {
  const lines = []; let current = '', length = 0;
  for (const char of line) { const bytes = Buffer.byteLength(char); if (length + bytes > 75) { lines.push(current); current = ' '; length = 1; } current += char; length += bytes; }
  lines.push(current); return lines.join('\r\n');
}

export function calendarIcs({ event, uid, sequence = 0, organizer, attendees = [], method = 'REQUEST', now = Date.now() }) {
  if (!['REQUEST','CANCEL','REPLY'].includes(method)) fail('Invalid calendar method');
  organizer = normalizeEmail(organizer);
  if (!uid || /[\r\n]/.test(uid) || !Number.isSafeInteger(sequence) || sequence < 0) fail('Invalid calendar identity');
  if (!(new Date(event.end) > new Date(event.start))) fail('Event end must be after its start');
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Avenor//Calendar//EN','CALSCALE:GREGORIAN', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${icalText(uid)}`, `SEQUENCE:${sequence}`, `DTSTAMP:${utc(now)}`];
  if (event.allDay) {
    const date = value => { try { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: event.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)); const get = key => parts.find(x => x.type === key).value; return `${get('year')}${get('month')}${get('day')}`; } catch { return utc(value).slice(0, 8); } };
    const start = date(event.start), end = date(event.end); if (end <= start) fail('An all-day event must end on a later date');
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
  } else lines.push(`DTSTART:${utc(event.start)}`, `DTEND:${utc(event.end)}`);
  lines.push(`SUMMARY:${icalText(event.title)}`, `DESCRIPTION:${icalText(event.notes || '')}`, `LOCATION:${icalText(event.location || '')}`, `ORGANIZER:mailto:${organizer}`);
  for (const attendee of attendees) {
    const email = normalizeEmail(typeof attendee === 'string' ? attendee : attendee.email), partstat = typeof attendee === 'string' ? 'NEEDS-ACTION' : attendee.partstat || 'NEEDS-ACTION';
    if (!partstats.has(partstat)) fail('Invalid attendee response');
    lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat}${method === 'REQUEST' ? ';RSVP=TRUE' : ''}:mailto:${email}`);
  }
  if (['daily','weekly','monthly'].includes(event.repeat)) lines.push(`RRULE:FREQ=${event.repeat.toUpperCase()}${event.until && /^\d{4}-\d{2}-\d{2}$/.test(event.until) ? `;UNTIL=${event.until.replaceAll('-', '')}${event.allDay ? '' : 'T235959Z'}` : ''}`);
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT','END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function calendarMime({ from, to, subject, text = '', calendar, method = 'REQUEST', id = randomUUID(), now = Date.now() }) {
  const sender = normalizeEmail(from), recipients = (Array.isArray(to) ? to : [to]).map(normalizeEmail);
  if (!['REQUEST','CANCEL','REPLY'].includes(method)) fail('Invalid calendar method');
  const boundary = `avenor_${hash(id).slice(0, 40)}`, b64 = value => Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  const safeId = hash(id);
  const words = []; let word = '';
  for (const character of String(subject || '')) { if (Buffer.byteLength(word + character) > 42) { words.push(word); word = ''; } word += character; }
  words.push(word);
  const encodedSubject = words.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
  return [`From: ${sender}`,`To: ${recipients.join(', ')}`,`Subject: ${encodedSubject}`,`Date: ${new Date(now).toUTCString()}`,`Message-ID: <${safeId}@avenor>`, 'MIME-Version: 1.0',`Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text), `--${boundary}`, `Content-Type: text/calendar; charset=UTF-8; method=${method}; name="invite.ics"`, 'Content-Transfer-Encoding: base64', 'Content-Disposition: inline; filename="invite.ics"', '', b64(calendar), `--${boundary}--`, ''].join('\r\n');
}

/** Owns organizer-authorized invitation revisions and bearer-token RSVP confirmations. */
export class InvitationService {
  constructor({ db, scheduler, deliver, env = {}, authorize, resolveAccount, emit = () => {}, now = Date.now }) {
    Object.assign(this, { db, scheduler, deliver, env, authorize, resolveAccount, emit, now });
    if (scheduler) {
      scheduler.handlers['invitation-delivery'] = (payload, context) => this.deliverInvitation(payload, context);
      scheduler.handlers['invitation-reply'] = (payload, context) => this.deliverReply(payload, context);
    }
  }

  migrate() {
    this.scheduler?.migrate();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, scope TEXT NOT NULL,
        account_id TEXT, organizer TEXT NOT NULL, organizer_name TEXT NOT NULL, uid TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL, method TEXT NOT NULL, event_version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitation_attendees (
        invitation_id TEXT NOT NULL, email TEXT NOT NULL, partstat TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
        sequence INTEGER NOT NULL, token_hash TEXT UNIQUE, expires INTEGER, responded_at INTEGER,
        PRIMARY KEY(invitation_id,email), FOREIGN KEY(invitation_id) REFERENCES invitations(id)
      );
      CREATE INDEX IF NOT EXISTS invitation_owner ON invitations(owner, scope);
    `);
    return this;
  }

  async allowed(user, scope, recordId, action, extra = {}) {
    if (!identity(user)) fail('Sign in to open your workspace', 401);
    if (this.authorize) { if (await this.authorize({ user, scope, recordId, action, ...extra }) !== true) fail('You do not have access to this workspace', 403); }
    else if (scope !== `user:${identity(user)}`) fail('You do not have access to this workspace', 403);
  }

  summary(invitation) {
    return { id: invitation.id, eventId: invitation.event_id, uid: invitation.uid, sequence: invitation.sequence, method: invitation.method, organizer: invitation.organizer, version: invitation.event_version, attendees: this.db.prepare('SELECT email,partstat,responded_at AS respondedAt FROM invitation_attendees WHERE invitation_id=? ORDER BY email').all(invitation.id) };
  }

  origin(request) {
    let url; try { url = new URL(this.env.PUBLIC_URL || request?.url); } catch { fail('Configure PUBLIC_URL before sending calendar invitations', 503); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) fail('Calendar response links require an HTTPS PUBLIC_URL', 503);
    return url.origin;
  }

  async create(body, user, request) {
    if (!this.scheduler || !this.deliver) fail('Calendar invitation delivery is not configured', 503);
    const row = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(body.eventId);
    if (!row || row.kind !== 'event') fail('Event not found', 404);
    await this.allowed(user, row.scope, row.id, 'invite', { accountId: body.accountId, version: body.version });
    if (row.owner !== identity(user)) fail('Only the event organizer can send invitations', 403);
    if (!Number.isInteger(body.version) || row.version !== body.version) fail('Event changed. Review the latest version before inviting guests.', 409);
    const event = JSON.parse(row.data);
    const existing = this.db.prepare('SELECT * FROM invitations WHERE event_id=?').get(row.id);
    const requestedAccount = body.accountId || existing?.account_id || null;
    const account = this.resolveAccount ? await this.resolveAccount({ user, accountId: requestedAccount, scope: row.scope }) : null;
    const organizer = normalizeEmail(account?.email || user.email);
    if (existing && existing.organizer !== organizer || event.organizer && normalizeEmail(typeof event.organizer === 'object' ? event.organizer.email : event.organizer) !== organizer) fail('Only the original organizer can update invitations', 403);
    const method = body.method || body.action === 'cancel' && 'CANCEL' || 'REQUEST';
    if (!['REQUEST','CANCEL'].includes(method)) fail('Choose REQUEST or CANCEL');
    if (method === 'CANCEL' && !existing) fail('This event has no invitation to cancel', 409);
    if (existing?.event_version === row.version && existing.method === method) return { ...this.summary(existing), duplicate: true };
    const previousAttendees = existing ? this.db.prepare('SELECT email,partstat FROM invitation_attendees WHERE invitation_id=?').all(existing.id) : [];
    const emails = method === 'CANCEL' ? previousAttendees.map(a => a.email) : [...new Set((Array.isArray(event.attendees) ? event.attendees.map(a => typeof a === 'string' ? a : a.email) : String(event.attendees || '').split(/[,;]+/)).filter(Boolean).map(normalizeEmail))];
    if (!emails.length || emails.length > 50) fail('Add between one and 50 attendees before sending invitations');
    const id = existing?.id || randomUUID(), uid = existing?.uid || `${randomUUID()}@avenor`, sequence = existing ? existing.sequence + 1 : 0, now = this.now(), origin = this.origin(request);
    const accountId = account?.id || requestedAccount;
    const snapshot = { title: event.title, start: event.start, end: event.end, allDay: !!event.allDay, timezone: event.timezone, repeat: event.repeat, until: event.until, notes: event.notes, location: event.location };
    calendarIcs({ event: snapshot, uid, sequence, organizer, attendees: emails, method, now });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Check again inside the write transaction so concurrent invitation updates cannot share a sequence.
      const current = this.db.prepare('SELECT sequence,event_version,method FROM invitations WHERE event_id=?').get(row.id);
      const currentRecord = this.db.prepare('SELECT version FROM records WHERE id=? AND deleted=0').get(row.id);
      if (currentRecord?.version !== row.version) fail('Event changed. Review the latest version before inviting guests.', 409);
      if (current && (!existing || current.sequence !== existing.sequence)) fail('Invitations changed. Refresh before sending.', 409);
      this.db.prepare(`INSERT INTO invitations(id,event_id,owner,scope,account_id,organizer,organizer_name,uid,sequence,method,event_version,snapshot,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET account_id=excluded.account_id,sequence=excluded.sequence,method=excluded.method,event_version=excluded.event_version,snapshot=excluded.snapshot,updated=excluded.updated`).run(id, row.id, row.owner, row.scope, accountId, organizer, user.displayName || user.fullName || organizer, uid, sequence, method, row.version, JSON.stringify(snapshot), now, now);
      this.db.prepare('DELETE FROM invitation_attendees WHERE invitation_id=?').run(id);
      for (const email of emails) {
        this.db.prepare('INSERT INTO invitation_attendees(invitation_id,email,partstat,sequence) VALUES(?,?,?,?)').run(id, email, method === 'CANCEL' ? previousAttendees.find(a => a.email === email)?.partstat || 'NEEDS-ACTION' : 'NEEDS-ACTION', sequence);
        this.scheduler.enqueue({ id: `invitation:${id}:${sequence}:${hash(email).slice(0, 24)}`, type: 'invitation-delivery', payload: { invitationId: id, sequence, email, origin }, runAt: now, owner: row.owner, scope: row.scope });
      }
      if (method === 'REQUEST') for (const attendee of previousAttendees.filter(a => !emails.includes(a.email))) {
        this.scheduler.enqueue({ id: `invitation:${id}:${sequence}:${hash(attendee.email).slice(0, 24)}`, type: 'invitation-delivery', payload: { invitationId: id, sequence, email: attendee.email, origin, removed: true, partstat: attendee.partstat, event: snapshot }, runAt: now, owner: row.owner, scope: row.scope });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.emit(row.scope, { type: 'invitation-change', eventId: row.id, invitationId: id });
    return this.summary(this.db.prepare('SELECT * FROM invitations WHERE id=?').get(id));
  }

  async deliverInvitation(payload, context) {
    const invitation = this.db.prepare('SELECT * FROM invitations WHERE id=?').get(payload.invitationId);
    if (!invitation || invitation.sequence !== payload.sequence && !payload.removed) return { status: 'completed', skipped: true };
    const attendee = this.db.prepare('SELECT * FROM invitation_attendees WHERE invitation_id=? AND email=? AND sequence=?').get(invitation.id, payload.email, payload.sequence);
    if (!attendee && !payload.removed) return { status: 'completed', skipped: true };
    const user = { userId: invitation.owner, email: invitation.organizer, displayName: invitation.organizer_name };
    await this.allowed(user, invitation.scope, invitation.event_id, 'deliver-invitation', { accountId: invitation.account_id });
    let responseUrl;
    const method = payload.removed ? 'CANCEL' : invitation.method;
    if (method === 'REQUEST' && !attendee.responded_at) {
      const token = randomBytes(32).toString('base64url');
      responseUrl = `${payload.origin}/api/invitations/respond/${token}`;
      this.db.prepare('UPDATE invitation_attendees SET token_hash=?,expires=? WHERE invitation_id=? AND email=? AND sequence=? AND responded_at IS NULL').run(hash(token), this.now() + 90 * 86400000, invitation.id, payload.email, payload.sequence);
    }
    // A removed guest still needs the queued cancellation after later revisions.
    // Its older sequence lets a newer re-invitation supersede it in calendar clients.
    const event = payload.removed ? payload.event : JSON.parse(invitation.snapshot), attendees = payload.removed ? [{ email: payload.email, partstat: payload.partstat || 'NEEDS-ACTION' }] : this.db.prepare('SELECT email,partstat FROM invitation_attendees WHERE invitation_id=?').all(invitation.id);
    const calendar = calendarIcs({ event, uid: invitation.uid, sequence: payload.sequence, organizer: invitation.organizer, attendees, method, now: this.now() });
    const subject = `${method === 'CANCEL' ? 'Cancelled: ' : 'Invitation: '}${event.title}`, text = `${subject}\n${event.start} – ${event.end}\n${event.location || ''}\n\n${event.notes || ''}${responseUrl ? `\n\nReview and respond: ${responseUrl}\nOpening the link does not send a response.` : ''}`;
    const raw = calendarMime({ from: invitation.organizer, to: payload.email, subject, text, calendar, method, id: context.idempotencyKey, now: this.now() });
    const result = await this.deliver({ user, scope: invitation.scope, recordId: invitation.event_id, accountId: invitation.account_id, to: payload.email, subject, text, calendar, raw, idempotencyKey: context.idempotencyKey, signal: context.signal, markAccepted: context.markAccepted });
    return result || { status: 'unknown' };
  }

  async deliverReply(payload, context) {
    const invitation = this.db.prepare('SELECT * FROM invitations WHERE id=?').get(payload.invitationId);
    if (!invitation || invitation.sequence !== payload.sequence) return { status: 'completed', skipped: true };
    const user = { userId: invitation.owner, email: invitation.organizer, displayName: invitation.organizer_name };
    await this.allowed(user, invitation.scope, invitation.event_id, 'deliver-invitation', { accountId: invitation.account_id });
    const event = JSON.parse(invitation.snapshot), calendar = calendarIcs({ event, uid: invitation.uid, sequence: payload.sequence, organizer: invitation.organizer, attendees: [{ email: payload.email, partstat: payload.partstat }], method: 'REPLY', now: this.now() });
    const subject = `${payload.partstat}: ${event.title}`, text = `${payload.email} responded ${payload.partstat.toLowerCase()} to ${event.title}.\n\nThis RSVP was confirmed ${payload.via === 'token' ? 'using the recipient’s invitation link' : 'by the signed-in workspace attendee'}.`;
    const raw = calendarMime({ from: invitation.organizer, to: invitation.organizer, subject, text, calendar, method: 'REPLY', id: context.idempotencyKey, now: this.now() });
    return await this.deliver({ user, scope: invitation.scope, recordId: invitation.event_id, accountId: invitation.account_id, to: invitation.organizer, subject, text, calendar, raw, idempotencyKey: context.idempotencyKey, signal: context.signal, markAccepted: context.markAccepted }) || { status: 'unknown' };
  }

  async respond(invitation, attendee, response, via) {
    const partstat = String(response || '').toUpperCase();
    if (!['ACCEPTED','TENTATIVE','DECLINED'].includes(partstat)) fail('Choose accepted, tentative or declined');
    if (invitation.method === 'CANCEL') fail('This event was cancelled', 410);
    if (attendee.sequence !== invitation.sequence) fail('This invitation has been replaced', 410);
    if (attendee.responded_at) { if (attendee.partstat !== partstat) fail('This invitation already has a recorded response', 409); return { ok: true, response: partstat, duplicate: true }; }
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE invitation_attendees SET partstat=?,responded_at=? WHERE invitation_id=? AND email=? AND sequence=? AND responded_at IS NULL').run(partstat, now, invitation.id, attendee.email, invitation.sequence);
      if (!result.changes) fail('A response has already been recorded', 409);
      const row = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(invitation.event_id);
      if (row) { const data = JSON.parse(row.data); data.attendeeStatuses = Object.fromEntries(this.db.prepare('SELECT email,partstat FROM invitation_attendees WHERE invitation_id=?').all(invitation.id).map(a => [a.email, a.partstat])); this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=? AND version=?').run(JSON.stringify(data), now, row.id, row.version); }
      this.scheduler.enqueue({ id: `rsvp:${invitation.id}:${invitation.sequence}:${hash(attendee.email).slice(0, 24)}`, type: 'invitation-reply', payload: { invitationId: invitation.id, sequence: invitation.sequence, email: attendee.email, partstat, via }, runAt: now, owner: invitation.owner, scope: invitation.scope });
      this.db.prepare('INSERT OR IGNORE INTO notifications(id,owner,scope,record_id,type,title,data,created) VALUES(?,?,?,?,?,?,?,?)').run(`rsvp:${invitation.id}:${invitation.sequence}:${hash(attendee.email)}`, invitation.owner, invitation.scope, invitation.event_id, 'rsvp', `${attendee.email}: ${partstat.toLowerCase()}`, JSON.stringify({ invitationId: invitation.id, email: attendee.email, response: partstat }), now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.emit(invitation.scope, { type: 'record-change', recordId: invitation.event_id });
    this.emit(invitation.scope, { type: 'invitation-change', eventId: invitation.event_id, invitationId: invitation.id });
    return { ok: true, response: partstat };
  }

  tokenRecord(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail('Invitation link not found', 404);
    const attendee = this.db.prepare('SELECT * FROM invitation_attendees WHERE token_hash=?').get(hash(token));
    if (!attendee) fail('Invitation link not found', 404);
    if (attendee.expires <= this.now()) fail('This invitation link expired', 410);
    const invitation = this.db.prepare('SELECT * FROM invitations WHERE id=?').get(attendee.invitation_id);
    if (!invitation || invitation.sequence !== attendee.sequence || invitation.method === 'CANCEL') fail('This invitation is no longer active', 410);
    return { invitation, attendee };
  }

  page(invitation, attendee, token, message) {
    const event = JSON.parse(invitation.snapshot);
    const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Respond to invitation · Avenor</title><body><main><h1>${html(event.title)}</h1><p>Organizer: ${html(invitation.organizer)}</p><p>${html(event.start)} – ${html(event.end)}</p><p>${html(event.location)}</p>${message ? `<p>${html(message)}</p>` : attendee.responded_at ? `<p>Your response is ${html(attendee.partstat.toLowerCase())}.</p>` : `<p>Choose your response for ${html(attendee.email)}. A response is sent only when you press a button.</p><form method="post" action="/api/invitations/respond/${token}"><button type="submit" name="response" value="accepted">Accept</button> <button type="submit" name="response" value="tentative">Tentative</button> <button type="submit" name="response" value="declined">Decline</button></form>`}</main></body></html>`;
    return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
  }

  async handle(request, user) {
    try {
      const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
      if (!/^\/(?:api\/)?invitations(\/|$)/.test(path)) return null;
      const tokenMatch = path.match(/^\/(?:api\/)?invitations\/respond\/([A-Za-z0-9_-]+)$/);
      const allowedOrigins = [this.env.PUBLIC_URL, this.env.FRONTEND_URL, ...String(this.env.ALLOWED_ORIGINS || '').split(',')].filter(Boolean).map(value => { try { return new URL(value).origin; } catch { return null; } });
      if (!['GET','HEAD'].includes(request.method) && request.headers.get('origin') && request.headers.get('origin') !== url.origin && !allowedOrigins.includes(request.headers.get('origin'))) fail('This request must come from Avenor', 403);
      if (tokenMatch) {
        const { invitation, attendee } = this.tokenRecord(tokenMatch[1]);
        if (request.method === 'GET') return this.page(invitation, attendee, tokenMatch[1]);
        if (request.method === 'POST') {
          if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) fail('Use the invitation confirmation form', 415);
          const length = Number(request.headers.get('content-length') || 0); if (length > 1000) fail('Response is too large', 413);
          const reader = request.body?.getReader(); if (!reader) fail('Choose a response'); let encoded = '', size = 0;
          while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1000) { await reader.cancel(); fail('Response is too large', 413); } encoded += Buffer.from(value).toString(); }
          const form = new URLSearchParams(encoded); await this.respond(invitation, attendee, form.get('response'), 'token');
          return this.page(invitation, attendee, tokenMatch[1], `Your response is ${String(form.get('response')).toLowerCase()}. Thank you.`);
        }
        return json({ error: 'Method not allowed' }, 405);
      }
      if (!identity(user)) fail('Sign in to open your workspace', 401);
      if (path === '/api/invitations' && request.method === 'POST') return json(await this.create(await readJobBody(request), user, request), 202);
      if (path === '/api/invitations' && request.method === 'GET') {
        const invitation = this.db.prepare('SELECT * FROM invitations WHERE event_id=?').get(url.searchParams.get('eventId')); if (!invitation) fail('Invitation not found', 404);
        await this.allowed(user, invitation.scope, invitation.event_id, 'read-invitation'); return json(this.summary(invitation));
      }
      const match = path.match(/^\/api\/invitations\/([^/]+)\/respond$/);
      if (match && request.method === 'POST') {
        const invitation = this.db.prepare('SELECT * FROM invitations WHERE id=?').get(decodeURIComponent(match[1])); if (!invitation) fail('Invitation not found', 404);
        await this.allowed(user, invitation.scope, invitation.event_id, 'respond-invitation');
        const attendee = this.db.prepare('SELECT * FROM invitation_attendees WHERE invitation_id=? AND email=?').get(invitation.id, normalizeEmail(user.email)); if (!attendee) fail('Only an invited attendee can respond', 403);
        return json(await this.respond(invitation, attendee, (await readJobBody(request)).response, 'workspace'));
      }
      return json({ error: 'Endpoint not found' }, 404);
    } catch (error) { return json({ error: error.status ? error.message : 'Calendar invitation request failed' }, error.status || 500); }
  }
}
