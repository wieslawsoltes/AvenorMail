import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { simpleParser } from 'mailparser';
import { readJobBody } from './jobs.js';
import { calendarMime } from './invitations.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = user => user?.userId || user?.id;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const email = value => {
  const result = String(value || '').replace(/^mailto:/i, '').trim().toLowerCase();
  if (result.length > 254 || !/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(result)) fail('Invalid calendar email identity');
  return result;
};
const optionalEmail = value => { try { return email(value); } catch { return ''; } };
const partstats = new Set(['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED']);
const methods = new Set(['REQUEST', 'CANCEL', 'REPLY']);
const singular = ['uid', 'organizer', 'sequence', 'dtstamp', 'dtstart', 'dtend', 'duration', 'recurrence-id', 'summary', 'description', 'location', 'status'];

function localToUtc(value, zone) {
  const [year, month, day, hour = 0, minute = 0, second = 0] = value.match(/\d+/g).map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let pass = 0; pass < 4; pass++) {
    const fields = Object.fromEntries(format.formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    const actual = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
    const difference = target - actual;
    if (!difference) return new Date(instant).toISOString();
    instant += difference;
  }
  fail('Calendar time falls in an invalid daylight-saving interval');
}

function calendarTime(property, zones, defaultTimezone = 'UTC') {
  if (!property) return null;
  const rawValue = String(property.jCal[3] || '');
  const time = property.getFirstValue();
  if (!(time instanceof ICAL.Time)) fail('Invalid calendar date');
  if (time.year < 1900 || time.year > 9999) fail('Calendar date is outside the supported range');
  const zone = String(property.getParameter('tzid') || (time.zone?.tzid === 'UTC' ? 'UTC' : time.isDate ? 'date' : 'floating'));
  const value = time.toString();
  if (rawValue !== value) fail('Invalid calendar date fields');
  let iso;
  if (time.isDate) iso = `${value}T00:00:00.000Z`;
  else if (zone === 'UTC') iso = time.toJSDate().toISOString();
  else if (zones.has(zone)) { const copy = time.clone(); copy.zone = zones.get(zone); iso = copy.toJSDate().toISOString(); }
  else { try { iso = localToUtc(value, zone === 'floating' ? defaultTimezone : zone); } catch (error) { if (error.status) throw error; fail(`Unknown calendar timezone: ${zone}`); } }
  return { value, iso, timezone: zone, date: !!time.isDate };
}

/** Parse bounded VEVENT scheduling data. VTIMEZONE objects are scoped to this message. */
export function parseCalendar(text, { mimeMethod, defaultTimezone = 'UTC', maxBytes = 1024 * 1024, maxEvents = 100 } = {}) {
  text = Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '');
  if (!text || Buffer.byteLength(text) > maxBytes || text.includes('\0')) fail('Calendar part is empty, invalid or too large', 413);
  let root;
  try { root = new ICAL.Component(ICAL.parse(text)); } catch { fail('Malformed iCalendar data'); }
  if (root.name !== 'vcalendar' || root.getAllProperties('version').length !== 1 || root.getFirstPropertyValue('version') !== '2.0') fail('Expected one iCalendar 2.0 calendar');
  if (root.getAllProperties('method').length !== 1) fail('Calendar requires exactly one METHOD');
  const method = String(root.getFirstPropertyValue('method') || '').toUpperCase();
  if (!methods.has(method)) fail(`Unsupported scheduling method: ${method || 'missing'}`);
  if (mimeMethod && String(mimeMethod).toUpperCase() !== method) fail('MIME and calendar methods disagree');
  if (root.getAllSubcomponents().some(component => !['vevent', 'vtimezone'].includes(component.name))) fail('Only VEVENT scheduling components are accepted');
  const zones = new Map();
  for (const component of root.getAllSubcomponents('vtimezone')) {
    const tzid = component.getFirstPropertyValue('tzid');
    if (!tzid || zones.has(tzid)) fail('Duplicate or missing timezone identity');
    zones.set(tzid, new ICAL.Timezone({ component, tzid }));
  }
  const components = root.getAllSubcomponents('vevent');
  if (!components.length || components.length > maxEvents) fail('Calendar event count exceeds the permitted range');
  const seen = new Set();
  const events = components.map(component => {
    for (const name of singular) if (component.getAllProperties(name).length > 1) fail(`Duplicate calendar property: ${name}`);
    const get = name => component.getFirstPropertyValue(name);
    const uid = String(get('uid') || '');
    if (!uid || uid.length > 1024 || /[\r\n]/.test(uid)) fail('Invalid calendar UID');
    const sequence = get('sequence') ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 2147483647) fail('Invalid calendar sequence');
    const stamp = calendarTime(component.getFirstProperty('dtstamp'), zones, defaultTimezone);
    if (!stamp || stamp.date || stamp.timezone !== 'UTC') fail('Calendar DTSTAMP must be a UTC date-time');
    const organizer = email(get('organizer'));
    const attendees = component.getAllProperties('attendee').map(property => {
      const partstat = String(property.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase();
      if (!partstats.has(partstat)) fail('Unsupported attendee participation status');
      return { email: email(property.getFirstValue()), name: String(property.getParameter('cn') || ''), partstat, sentBy: optionalEmail(property.getParameter('sent-by')), rsvp: String(property.getParameter('rsvp')).toUpperCase() === 'TRUE' };
    });
    if (attendees.length > 500 || new Set(attendees.map(a => a.email)).size !== attendees.length) fail('Duplicate or excessive attendees');
    if (method === 'REPLY' && attendees.length !== 1) fail('A reply must identify exactly one attendee');
    const recurrence = calendarTime(component.getFirstProperty('recurrence-id'), zones, defaultTimezone);
    const recurrenceId = recurrence ? recurrence.date ? recurrence.value : recurrence.iso : '';
    const range = String(component.getFirstProperty('recurrence-id')?.getParameter('range') || '').toUpperCase();
    if (range && range !== 'THISANDFUTURE') fail('Unsupported recurrence range');
    const key = `${uid}\0${recurrenceId}`;
    if (seen.has(key)) fail('Duplicate event revision in calendar');
    seen.add(key);
    const start = calendarTime(component.getFirstProperty('dtstart'), zones, defaultTimezone);
    let end = calendarTime(component.getFirstProperty('dtend'), zones, defaultTimezone);
    const duration = get('duration');
    if (duration && end) fail('DTEND and DURATION cannot both be present');
    if (method === 'REQUEST' && !start) fail('A meeting request requires DTSTART');
    if (start && !end) {
      const seconds = duration ? duration.toSeconds() : start.date ? 86400 : 0;
      if (seconds < 0 || !Number.isFinite(seconds)) fail('Invalid calendar duration');
      end = { ...start, iso: new Date(Date.parse(start.iso) + seconds * 1000).toISOString() };
    }
    if (start && end && (start.date !== end.date || Date.parse(end.iso) < Date.parse(start.iso))) fail('Invalid calendar event interval');
    const status = String(get('status') || (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED')).toUpperCase();
    if (!['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(status)) fail('Invalid calendar event status');
    const rrules = component.getAllProperties('rrule').map(p => p.getFirstValue().toString());
    if (rrules.length > 1) fail('Multiple recurrence rules are not accepted');
    const exdates = component.getAllProperties('exdate').flatMap(p => p.getValues().map(value => value.toString()));
    const rdates = component.getAllProperties('rdate').flatMap(p => p.getValues().map(value => value.toString()));
    return { uid, method, sequence, stamp: Date.parse(stamp.iso), dtstamp: stamp.iso, organizer, organizerSentBy: optionalEmail(component.getFirstProperty('organizer')?.getParameter('sent-by')), attendees, recurrenceId, recurrenceValue: recurrence, range, title: String(get('summary') || 'Meeting'), notes: String(get('description') || ''), location: String(get('location') || ''), start: start?.iso || null, end: end?.iso || null, allDay: !!start?.date, timezone: start?.timezone || recurrence?.timezone || 'UTC', startValue: start, endValue: end, status, rrules, exdates, rdates, component: component.toString(), timezones: root.getAllSubcomponents('vtimezone').map(z => z.toString()) };
  });
  if (new Set(events.map(event => event.uid)).size > 1) fail('Scheduling components must refer to the same UID');
  return { method, events };
}

export async function extractCalendarParts({ rawMime, calendarParts = [] }, maxBytes = 25 * 1024 * 1024) {
  const result = [];
  if (rawMime) {
    const raw = Buffer.isBuffer(rawMime) ? rawMime : Buffer.from(rawMime);
    if (raw.length > maxBytes) fail('MIME message is too large', 413);
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    for (const attachment of parsed.attachments || []) if (String(attachment.contentType).toLowerCase() === 'text/calendar' || /\.ics$/i.test(attachment.filename || '')) {
      const type = attachment.headers?.get('content-type');
      result.push({ content: attachment.content.toString('utf8'), method: type?.params?.method });
    }
  }
  for (const part of calendarParts) result.push(typeof part === 'string' ? { content: part } : part);
  if (result.length > 16 || result.reduce((n, part) => n + Buffer.byteLength(String(part.content || '')), 0) > 2 * 1024 * 1024) fail('Calendar MIME parts exceed the message limit', 413);
  return [...new Map(result.map(part => [hash(String(part.content || '')), part])).values()];
}

function eventData(event, previous = {}) {
  const frequency = event.rrules[0]?.match(/^FREQ=(DAILY|WEEKLY|MONTHLY)(?:;|$)/)?.[1].toLowerCase();
  return { ...previous, title: event.title, notes: event.notes, location: event.location, start: event.start, end: event.end, allDay: event.allDay, timezone: ['date', 'floating'].includes(event.timezone) ? 'UTC' : event.timezone, organizer: event.organizer, attendees: event.attendees.map(a => a.email).join(', '), attendeeStatuses: Object.fromEntries(event.attendees.map(a => [a.email, a.partstat])), repeat: frequency || 'none', status: event.status.toLowerCase(), cancelled: event.status === 'CANCELLED', externalScheduling: true, calendarUid: event.uid, calendarSequence: event.sequence, recurrenceRule: event.rrules[0] || '', recurrenceDates: event.rdates, excludedDates: event.exdates, calendarComponent: event.component, calendarTimezones: event.timezones };
}

/** The caller supplies authentication results from its trusted delivery boundary, never MIME headers. */
export class InboundCalendarService {
  constructor({ db, emit = () => {}, authorize, scheduler, deliver, resolveAccount, now = Date.now }) {
    Object.assign(this, { db, emit, authorize, scheduler, deliver, resolveAccount, now });
    if (scheduler) scheduler.handlers['inbound-calendar-reply'] = (payload, context) => this.deliverReply(payload, context);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_inbound (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, account_id TEXT NOT NULL, mailbox_email TEXT NOT NULL,
        message_id TEXT NOT NULL, mail_record_id TEXT, uid TEXT, method TEXT, payload TEXT NOT NULL,
        evidence TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, event_id TEXT, created INTEGER NOT NULL,
        reviewed INTEGER, reviewer TEXT
      );
      CREATE INDEX IF NOT EXISTS calendar_inbound_owner ON calendar_inbound(owner,status,created);
      CREATE TABLE IF NOT EXISTS inbound_calendar_state (
        owner TEXT NOT NULL, account_id TEXT NOT NULL, uid TEXT NOT NULL, recurrence_id TEXT NOT NULL,
        organizer TEXT NOT NULL, sequence INTEGER NOT NULL, stamp INTEGER NOT NULL, content_hash TEXT NOT NULL,
        event_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,account_id,uid,recurrence_id)
      );
      CREATE TABLE IF NOT EXISTS inbound_calendar_replies (
        invitation_id TEXT NOT NULL, recurrence_id TEXT NOT NULL, email TEXT NOT NULL, sequence INTEGER NOT NULL,
        stamp INTEGER NOT NULL, partstat TEXT NOT NULL, source_id TEXT NOT NULL,
        PRIMARY KEY(invitation_id,recurrence_id,email)
      );
      CREATE TABLE IF NOT EXISTS inbound_calendar_outgoing (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_id TEXT NOT NULL, event_id TEXT NOT NULL,
        account_id TEXT NOT NULL, mailbox_email TEXT NOT NULL, partstat TEXT NOT NULL,
        sequence INTEGER NOT NULL, stamp INTEGER NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, record_id TEXT,
        type TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, read_at INTEGER
      );
    `);
    return this;
  }

  notify({ id, owner, eventId, title, status, scope = `user:${owner}` }) {
    this.db.prepare('INSERT OR IGNORE INTO notifications(id,owner,scope,record_id,type,title,data,created) VALUES(?,?,?,?,?,?,?,?)').run(`calendar:${id}`, owner, scope, eventId || null, 'calendar-inbound', title, JSON.stringify({ inboundId: id, status }), this.now());
  }

  trusted(event, accountId, trust) {
    if (trust?.source !== 'provider' || trust.verified !== true || trust.accountId !== accountId || !['dkim', 'smime', 'provider'].includes(trust.method)) return false;
    const sender = optionalEmail(trust.authenticatedSender);
    return sender === (event.method === 'REPLY' ? event.attendees[0]?.email : event.organizer);
  }

  async ingest({ user, accountId, mailboxEmail, messageId, recordId = null, rawMime, calendarParts, trust, defaultTimezone = 'UTC' }) {
    const owner = identity(user), mailbox = email(mailboxEmail);
    if (!owner || !accountId || !messageId) fail('Calendar ingestion requires an authenticated mailbox identity');
    const parts = await extractCalendarParts({ rawMime, calendarParts });
    const results = [];
    for (const part of parts) {
      let events;
      try { events = parseCalendar(part.content, { mimeMethod: part.method, defaultTimezone }).events; }
      catch (error) {
        const id = hash(`${owner}\0${accountId}\0${messageId}\0${part.content}`);
        const result = { id, status: 'invalid', reason: error.message };
        this.db.prepare('INSERT OR IGNORE INTO calendar_inbound(id,owner,account_id,mailbox_email,message_id,mail_record_id,payload,evidence,status,reason,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, accountId, mailbox, String(messageId), recordId, JSON.stringify({ raw: String(part.content || '').slice(0, 1024 * 1024) }), '{}', result.status, result.reason, this.now());
        results.push(result); continue;
      }
      for (const event of events) {
        const id = hash(`${owner}\0${accountId}\0${messageId}\0${JSON.stringify(event)}`);
        const existing = this.db.prepare('SELECT status,reason,event_id FROM calendar_inbound WHERE id=?').get(id);
        if (existing) { results.push({ id, status: existing.status, reason: existing.reason, eventId: existing.event_id, duplicate: true }); continue; }
        const trusted = this.trusted(event, accountId, trust);
        const evidence = { authenticated: trusted, source: trust?.source || null, method: trust?.method || null, sender: optionalEmail(trust?.authenticatedSender), provider: trust?.provider || null };
        let result;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('INSERT INTO calendar_inbound(id,owner,account_id,mailbox_email,message_id,mail_record_id,uid,method,payload,evidence,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, accountId, mailbox, String(messageId), recordId, event.uid, event.method, JSON.stringify(event), JSON.stringify(evidence), 'review', this.now());
          result = trusted ? this.apply({ id, owner, accountId, mailbox, event }) : { status: 'review', reason: 'Sender authentication could not be independently verified' };
          this.db.prepare('UPDATE calendar_inbound SET status=?,reason=?,event_id=? WHERE id=?').run(result.status, result.reason || null, result.eventId || null, id);
          if (!['duplicate', 'stale', 'rejected'].includes(result.status)) this.notify({ id, owner, eventId: result.eventId, title: result.status === 'review' ? `Review calendar ${event.method.toLowerCase()}: ${event.title}` : `${event.method === 'REPLY' ? 'RSVP received' : event.method === 'CANCEL' ? 'Meeting cancelled' : 'Meeting updated'}: ${event.title}`, status: result.status, scope: result.scope });
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        results.push({ id, ...result });
        this.emit(result.scope || `user:${owner}`, { type: 'calendar-inbound', inboundId: id, recordId: result.eventId, status: result.status });
      }
    }
    return { results };
  }

  apply({ id, owner, accountId, mailbox, event }) {
    if (event.method === 'REPLY') return this.applyReply({ id, owner, mailbox, event });
    const previous = this.db.prepare('SELECT * FROM inbound_calendar_state WHERE owner=? AND account_id=? AND uid=? AND recurrence_id=?').get(owner, accountId, event.uid, event.recurrenceId);
    const master = this.db.prepare("SELECT * FROM inbound_calendar_state WHERE owner=? AND account_id=? AND uid=? AND recurrence_id='' ").get(owner, accountId, event.uid);
    const series = master || this.db.prepare('SELECT * FROM inbound_calendar_state WHERE owner=? AND account_id=? AND uid=? LIMIT 1').get(owner, accountId, event.uid);
    if (series && series.organizer !== event.organizer) return { status: 'rejected', reason: 'The organizer of an existing UID cannot be replaced' };
    if (!event.attendees.some(attendee => attendee.email === mailbox) && !(event.method === 'CANCEL' && series)) return { status: 'rejected', reason: 'The connected mailbox is not an attendee' };
    const digest = hash(JSON.stringify(event));
    if (previous?.content_hash === digest) return { status: 'duplicate', eventId: previous.event_id };
    if (previous && (event.sequence < previous.sequence || event.sequence === previous.sequence && event.stamp <= previous.stamp)) return { status: 'stale', eventId: previous.event_id, reason: 'An equal or newer revision is already stored' };
    if (event.recurrenceId && master && event.sequence < master.sequence) return { status: 'stale', eventId: master.event_id, reason: 'The series has a newer sequence' };
    if (event.method === 'REQUEST' && previous && JSON.parse(previous.payload).method === 'CANCEL' && event.sequence <= previous.sequence) return { status: 'stale', eventId: previous.event_id, reason: 'A cancellation requires a newer request sequence to supersede it' };
    const eventId = series?.event_id || `calendar:${hash(`${owner}:${accountId}:${event.uid}`).slice(0, 48)}`;
    const row = this.db.prepare('SELECT * FROM records WHERE id=?').get(eventId);
    let data = row ? JSON.parse(row.data) : { title: event.title, calendarUid: event.uid, externalScheduling: true, organizer: event.organizer, accountId, repeat: 'none' };
    if (event.recurrenceId) {
      data.recurrenceOverrides = { ...(data.recurrenceOverrides || {}), [event.recurrenceId]: { ...eventData(event), recurrenceId: event.recurrenceId, recurrenceValue: event.recurrenceValue, startValue: event.startValue, endValue: event.endValue, range: event.range, sequence: event.sequence, stamp: event.stamp, cancelled: event.method === 'CANCEL' || event.status === 'CANCELLED' } };
    } else if (event.method === 'CANCEL') { data.cancelled = true; data.status = 'cancelled'; data.calendarSequence = event.sequence; }
    else data = eventData(event, data);
    data.accountId = accountId;
    data.calendarInboxId = id;
    this.db.prepare('INSERT INTO inbound_calendar_state(owner,account_id,uid,recurrence_id,organizer,sequence,stamp,content_hash,event_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,account_id,uid,recurrence_id) DO UPDATE SET sequence=excluded.sequence,stamp=excluded.stamp,content_hash=excluded.content_hash,payload=excluded.payload').run(owner, accountId, event.uid, event.recurrenceId, event.organizer, event.sequence, event.stamp, digest, eventId, JSON.stringify(event));
    this.db.prepare("INSERT INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES(?,?,?,'event',?,1,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=records.version+1,updated=excluded.updated,deleted=0").run(eventId, owner, `user:${owner}`, JSON.stringify(data), this.now());
    return { status: 'applied', eventId };
  }

  applyReply({ id, owner, mailbox, event }) {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invitations'").get();
    const invitation = exists && this.db.prepare('SELECT * FROM invitations WHERE uid=? AND owner=?').get(event.uid, owner);
    if (!invitation) return { status: 'review', reason: 'No organizer-owned invitation matches this reply' };
    if (invitation.organizer !== event.organizer || invitation.organizer !== mailbox) return { status: 'rejected', reason: 'Reply organizer does not match the connected mailbox invitation' };
    if (invitation.method === 'CANCEL') return { status: 'stale', reason: 'The invitation was cancelled', eventId: invitation.event_id };
    if (event.sequence !== invitation.sequence) return { status: 'stale', reason: 'Reply sequence does not match the current invitation', eventId: invitation.event_id };
    const attendee = event.attendees[0];
    const target = this.db.prepare('SELECT * FROM invitation_attendees WHERE invitation_id=? AND email=?').get(invitation.id, attendee.email);
    if (!target || !['ACCEPTED', 'DECLINED', 'TENTATIVE'].includes(attendee.partstat)) return { status: 'rejected', reason: 'Reply attendee or response is not authorized for this invitation' };
    const prior = this.db.prepare('SELECT * FROM inbound_calendar_replies WHERE invitation_id=? AND recurrence_id=? AND email=?').get(invitation.id, event.recurrenceId, attendee.email);
    if (prior && prior.sequence === event.sequence && prior.stamp >= event.stamp) return { status: prior.partstat === attendee.partstat ? 'duplicate' : 'stale', eventId: invitation.event_id };
    const row = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(invitation.event_id);
    if (!row) return { status: 'stale', reason: 'The original event no longer exists' };
    const data = JSON.parse(row.data);
    if (event.recurrenceId) {
      if (!data.repeat || data.repeat === 'none') return { status: 'rejected', reason: 'A non-recurring invitation cannot receive instance replies' };
      data.instanceAttendeeStatuses = { ...(data.instanceAttendeeStatuses || {}), [event.recurrenceId]: { ...(data.instanceAttendeeStatuses?.[event.recurrenceId] || {}), [attendee.email]: attendee.partstat } };
    } else {
      this.db.prepare('UPDATE invitation_attendees SET partstat=?,responded_at=?,token_hash=NULL WHERE invitation_id=? AND email=? AND sequence=?').run(attendee.partstat, this.now(), invitation.id, attendee.email, event.sequence);
      data.attendeeStatuses = { ...(data.attendeeStatuses || {}), [attendee.email]: attendee.partstat };
    }
    this.db.prepare('INSERT INTO inbound_calendar_replies(invitation_id,recurrence_id,email,sequence,stamp,partstat,source_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(invitation_id,recurrence_id,email) DO UPDATE SET sequence=excluded.sequence,stamp=excluded.stamp,partstat=excluded.partstat,source_id=excluded.source_id').run(invitation.id, event.recurrenceId, attendee.email, event.sequence, event.stamp, attendee.partstat, id);
    this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data), this.now(), row.id);
    return { status: 'applied', eventId: row.id, scope: row.scope, response: attendee.partstat };
  }

  async review(id, user, decision) {
    const owner = identity(user), row = this.db.prepare('SELECT * FROM calendar_inbound WHERE id=? AND owner=?').get(id, owner);
    if (!row) fail('Calendar message not found', 404);
    if (!['accept', 'reject'].includes(decision)) fail('Choose accept or reject');
    if (row.status !== 'review') fail('This calendar message has already been resolved', 409);
    if (this.authorize && await this.authorize({ user, scope: `user:${owner}`, action: 'write' }) !== true) fail('Calendar review is not permitted', 403);
    let result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      result = decision === 'reject' ? { status: 'rejected', reason: 'Rejected by the mailbox owner' } : this.apply({ id, owner, accountId: row.account_id, mailbox: row.mailbox_email, event: JSON.parse(row.payload) });
      this.db.prepare("UPDATE calendar_inbound SET status=?,reason=?,event_id=?,reviewed=?,reviewer=? WHERE id=? AND status='review'").run(result.status, result.reason || null, result.eventId || null, this.now(), owner, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.emit(result.scope || `user:${owner}`, { type: 'calendar-inbound', inboundId: id, recordId: result.eventId, status: result.status });
    return { id, ...result };
  }

  async respond(id, user, response) {
    if (!this.scheduler || !this.deliver || !this.resolveAccount) fail('Calendar reply delivery is not configured', 503);
    const owner = identity(user), source = this.db.prepare('SELECT * FROM calendar_inbound WHERE id=? AND owner=?').get(id, owner);
    if (!source) fail('Calendar message not found', 404);
    if (!['applied', 'duplicate'].includes(source.status) || source.method !== 'REQUEST') fail('Review and accept the current meeting request before responding', 409);
    const event = JSON.parse(source.payload), partstat = String(response || '').toUpperCase();
    if (!['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(partstat)) fail('Choose accepted, tentative or declined');
    if (!event.attendees.some(attendee => attendee.email === source.mailbox_email)) fail('The connected mailbox is not an attendee', 403);
    if (this.authorize && await this.authorize({ user, scope: `user:${owner}`, recordId: source.event_id, action: 'write' }) !== true) fail('Calendar response is not permitted', 403);
    const account = await this.resolveAccount({ user, accountId: source.account_id, scope: `user:${owner}` });
    if (!account || email(account.email) !== source.mailbox_email) fail('The original attendee mailbox must send this response', 403);
    let result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT * FROM inbound_calendar_state WHERE owner=? AND account_id=? AND uid=? AND recurrence_id=?').get(owner, source.account_id, event.uid, event.recurrenceId);
      const record = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(source.event_id);
      if (!current || !record || current.sequence !== event.sequence || current.stamp !== event.stamp || JSON.parse(current.payload).method === 'CANCEL') fail('The meeting changed. Respond to the latest invitation.', 409);
      const data = JSON.parse(record.data);
      if (data.cancelled) fail('The meeting was cancelled', 410);
      const previous = this.db.prepare('SELECT * FROM inbound_calendar_outgoing WHERE owner=? AND source_id=? ORDER BY revision DESC LIMIT 1').get(owner, id);
      if (previous?.partstat === partstat) { this.db.exec('COMMIT'); return { id: previous.id, status: previous.status, response: partstat, duplicate: true }; }
      const revision = (previous?.revision || 0) + 1, stamp = Math.max(this.now(), (previous?.stamp || 0) + 1000);
      const jobId = `calendar-reply:${hash(`${owner}:${id}:${revision}`).slice(0, 48)}`;
      this.db.prepare('INSERT INTO inbound_calendar_outgoing(id,owner,source_id,event_id,account_id,mailbox_email,partstat,sequence,stamp,revision,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(jobId, owner, id, source.event_id, source.account_id, source.mailbox_email, partstat, event.sequence, stamp, revision, this.now());
      this.scheduler.enqueue({ id: jobId, type: 'inbound-calendar-reply', payload: { replyId: jobId }, owner, scope: `user:${owner}`, runAt: this.now() });
      if (event.recurrenceId) data.instanceAttendeeStatuses = { ...(data.instanceAttendeeStatuses || {}), [event.recurrenceId]: { ...(data.instanceAttendeeStatuses?.[event.recurrenceId] || {}), [source.mailbox_email]: partstat } };
      else { data.myResponse = partstat; data.attendeeStatuses = { ...(data.attendeeStatuses || {}), [source.mailbox_email]: partstat }; }
      data.rsvpDelivery = 'queued'; data.rsvpDeliveryFor = jobId;
      this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data), this.now(), record.id);
      this.db.exec('COMMIT');
      result = { id: jobId, status: 'queued', response: partstat };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.emit(`user:${owner}`, { type: 'record-change', recordId: source.event_id });
    return result;
  }

  async deliverReply({ replyId }, context) {
    const reply = this.db.prepare('SELECT * FROM inbound_calendar_outgoing WHERE id=?').get(replyId);
    if (!reply) return { status: 'completed', skipped: true };
    const source = this.db.prepare('SELECT * FROM calendar_inbound WHERE id=?').get(reply.source_id);
    if (!source) return { status: 'completed', skipped: true };
    const event = JSON.parse(source.payload), current = this.db.prepare('SELECT * FROM inbound_calendar_state WHERE owner=? AND account_id=? AND uid=? AND recurrence_id=?').get(reply.owner, reply.account_id, event.uid, event.recurrenceId);
    const record = this.db.prepare('SELECT * FROM records WHERE id=? AND deleted=0').get(reply.event_id);
    if (!current || !record || current.sequence !== reply.sequence || JSON.parse(current.payload).method === 'CANCEL' || JSON.parse(record.data).cancelled) {
      this.db.prepare("UPDATE inbound_calendar_outgoing SET status='superseded' WHERE id=?").run(replyId);
      return { status: 'completed', skipped: true };
    }
    const user = { userId: reply.owner, email: reply.mailbox_email };
    if (this.authorize && await this.authorize({ user, scope: record.scope, recordId: record.id, action: 'write' }) !== true) fail('Calendar response is no longer permitted', 403);
    const account = await this.resolveAccount({ user, accountId: reply.account_id, scope: record.scope });
    if (!account || email(account.email) !== reply.mailbox_email) fail('The attendee mailbox changed', 403);
    const component = new ICAL.Component(ICAL.parse(event.component));
    component.removeAllProperties('attendee');
    const attendee = new ICAL.Property('attendee'); attendee.setValue(`mailto:${reply.mailbox_email}`); attendee.setParameter('partstat', reply.partstat); component.addProperty(attendee);
    component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(reply.stamp), true));
    component.removeAllSubcomponents('valarm');
    const calendar = new ICAL.Component(['vcalendar', [['version', {}, 'text', '2.0'], ['prodid', {}, 'text', '-//Avenor//Calendar//EN'], ['method', {}, 'text', 'REPLY']], []]);
    for (const zone of event.timezones) calendar.addSubcomponent(new ICAL.Component(ICAL.parse(zone)));
    calendar.addSubcomponent(component);
    const subject = `${reply.partstat}: ${event.title}`, text = `${reply.mailbox_email} ${reply.partstat.toLowerCase()} ${event.title}.`;
    const raw = calendarMime({ from: reply.mailbox_email, to: event.organizer, subject, text, calendar: calendar.toString(), method: 'REPLY', id: context.idempotencyKey, now: reply.stamp });
    const result = await this.deliver({ user, accountId: reply.account_id, to: event.organizer, subject, text, calendar: calendar.toString(), raw, idempotencyKey: context.idempotencyKey, signal: context.signal, markAccepted: context.markAccepted });
    if (['accepted', 'completed'].includes(result?.status)) {
      this.db.prepare("UPDATE inbound_calendar_outgoing SET status='accepted' WHERE id=?").run(replyId);
      const latest = this.db.prepare('SELECT * FROM records WHERE id=?').get(record.id);
      if (latest) { const data = JSON.parse(latest.data); if (data.rsvpDeliveryFor === replyId) { data.rsvpDelivery = 'accepted'; this.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data), this.now(), record.id); } }
      this.emit(record.scope, { type: 'record-change', recordId: record.id });
    }
    return result || { status: 'unknown' };
  }

  async handle(request, user) {
    const url = new URL(request.url);
    if (!/^\/api\/calendar\/inbound(?:\/|$)/.test(url.pathname)) return null;
    try {
      const owner = identity(user);
      if (!owner) fail('Sign in to review calendar mail', 401);
      if (url.pathname === '/api/calendar/inbound' && request.method === 'GET') {
        const status = url.searchParams.get('status') || 'review';
        const rows = this.db.prepare('SELECT * FROM calendar_inbound WHERE owner=? AND (?=\'all\' OR status=?) ORDER BY created DESC LIMIT 200').all(owner, status, status);
        return Response.json({ messages: rows.map(row => ({ id: row.id, accountId: row.account_id, mailboxEmail: row.mailbox_email, mailRecordId: row.mail_record_id, method: row.method, event: JSON.parse(row.payload), evidence: JSON.parse(row.evidence), status: row.status, reason: row.reason, eventId: row.event_id, created: row.created })) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const match = url.pathname.match(/^\/api\/calendar\/inbound\/([^/]+)\/review$/);
      if (match && request.method === 'POST') return Response.json(await this.review(decodeURIComponent(match[1]), user, (await readJobBody(request)).decision));
      const responseMatch = url.pathname.match(/^\/api\/calendar\/inbound\/([^/]+)\/respond$/);
      if (responseMatch && request.method === 'POST') return Response.json(await this.respond(decodeURIComponent(responseMatch[1]), user, (await readJobBody(request)).response), { status: 202 });
      return Response.json({ error: 'Endpoint not found' }, { status: 404 });
    } catch (error) { return Response.json({ error: error.status ? error.message : 'Calendar review failed' }, { status: error.status || 500 }); }
  }
}
