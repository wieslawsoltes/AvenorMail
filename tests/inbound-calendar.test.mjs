import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { InboundCalendarService, parseCalendar, extractCalendarParts } from '../backend/inbound-calendar.js';
import { InvitationService, calendarMime } from '../backend/invitations.js';
import { expandImportedCalendar } from '../public/calendar-recurrence.js';
import { DurableScheduler } from '../backend/jobs.js';

const user = { userId: 'alice', email: 'alice@example.com' };
const mailbox = 'alice@example.com';
const organizer = 'organizer@example.com';
const START = Date.parse('2026-09-12T09:00:00Z');
function ics({ method = 'REQUEST', uid = 'meeting@example.com', sequence = 0, stamp = '20260912T090000Z', from = organizer, attendee = mailbox, partstat = 'NEEDS-ACTION', start = '20260915T140000Z', end = '20260915T150000Z', extra = '', properties = '', timezone = '' } = {}) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, timezone, 'BEGIN:VEVENT', `UID:${uid}`, `SEQUENCE:${sequence}`, `DTSTAMP:${stamp}`, `ORGANIZER:mailto:${from}`, `ATTENDEE;PARTSTAT=${partstat}:mailto:${attendee}`, ...(start ? [`DTSTART:${start}`] : []), ...(end ? [`DTEND:${end}`] : []), 'SUMMARY:Design review', properties, extra, 'END:VEVENT', 'END:VCALENDAR', ''].filter(x => x !== '').join('\r\n') + '\r\n';
}
function fixture(t, { connected = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_warm_stick.sql', import.meta.url), 'utf8'));
  new InvitationService({ db }).migrate();
  const emitted = [], deliveries = [];
  const scheduler = connected ? new DurableScheduler({ db, now: () => START }).migrate() : null;
  const service = new InboundCalendarService({ db, now: () => START, emit: (...args) => emitted.push(args), scheduler, resolveAccount: async () => ({ id: 'account-1', email: mailbox }), deliver: async payload => { deliveries.push(payload); return { status: 'accepted' }; } }).migrate();
  t.after(() => db.close());
  let next = 0;
  return { db, service, emitted, scheduler, deliveries,
    async ingest(content, patch = {}) {
      return service.ingest({ user, accountId: 'account-1', mailboxEmail: mailbox, messageId: `message-${++next}`, calendarParts: [{ content }], trust: { source: 'provider', verified: true, authenticatedSender: organizer, method: 'provider', accountId: 'account-1' }, ...patch });
    },
    event(id) { const row = id ? db.prepare('SELECT * FROM records WHERE id=?').get(id) : db.prepare("SELECT * FROM records WHERE kind='event' ORDER BY updated DESC LIMIT 1").get(); return row && { ...JSON.parse(row.data), id: row.id, version: row.version }; },
    invitation({ repeat = 'none', sequence = 0 } = {}) {
      db.prepare("INSERT INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES('local-event','alice','user:alice','event',?,1,?,0)").run(JSON.stringify({ title: 'Local invitation', repeat, start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T15:00:00.000Z', attendeeStatuses: { [organizer]: 'NEEDS-ACTION' } }), START);
      db.prepare("INSERT INTO invitations(id,event_id,owner,scope,organizer,organizer_name,uid,sequence,method,event_version,snapshot,created,updated) VALUES('invitation-1','local-event','alice','user:alice',?,'Alice','meeting@example.com',?,'REQUEST',1,'{}',?,?)").run(mailbox, sequence, START, START);
      db.prepare("INSERT INTO invitation_attendees(invitation_id,email,partstat,sequence) VALUES('invitation-1',?,'NEEDS-ACTION',?)").run(organizer, sequence);
    },
  };
}

test('calendar parser unfolds Unicode text and escaped comma, semicolon and newline', () => {
  const source = ics().replace('SUMMARY:Design review', 'SUMMARY:Design 😀 review with a long\r\n  folded title').replace('END:VEVENT', 'DESCRIPTION:First\\, item\\; next\\nSecond line\r\nEND:VEVENT');
  const event = parseCalendar(source).events[0];
  assert.equal(event.title, 'Design 😀 review with a long folded title');
  assert.equal(event.notes, 'First, item; next\nSecond line');
  assert.equal(event.start, '2026-09-15T14:00:00.000Z');
});

test('calendar parser honors IANA timezone transitions and message-scoped VTIMEZONE', () => {
  const iana = ics().replace('DTSTART:20260915T140000Z', 'DTSTART;TZID=Europe/Warsaw:20260915T140000').replace('DTEND:20260915T150000Z', 'DTEND;TZID=Europe/Warsaw:20260915T150000');
  assert.equal(parseCalendar(iana).events[0].start, '2026-09-15T12:00:00.000Z');
  const zone = 'BEGIN:VTIMEZONE\r\nTZID:Custom/Studio\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE';
  const custom = ics({ timezone: zone }).replace('DTSTART:20260915T140000Z', 'DTSTART;TZID=Custom/Studio:20260915T140000').replace('DTEND:20260915T150000Z', 'DTEND;TZID=Custom/Studio:20260915T150000');
  assert.equal(parseCalendar(custom).events[0].start, '2026-09-15T08:30:00.000Z');
  assert.throws(() => parseCalendar(custom.replace(zone, '')), /Unknown calendar timezone/);
});

test('calendar parser keeps date-only exclusive end and recurrence identity', () => {
  const source = ics({ start: null, end: null, extra: 'DTSTART;VALUE=DATE:20260915\r\nDTEND;VALUE=DATE:20260917\r\nRECURRENCE-ID;VALUE=DATE:20260914\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;VALUE=DATE:20260921' });
  const event = parseCalendar(source).events[0];
  assert.equal(event.allDay, true);
  assert.equal(event.end, '2026-09-17T00:00:00.000Z');
  assert.equal(event.recurrenceId, '2026-09-14');
  assert.deepEqual(event.rrules, ['FREQ=WEEKLY;COUNT=4']);
  assert.deepEqual(event.exdates, ['2026-09-21']);
});

test('malformed, oversized, duplicate and contradictory calendar inputs are rejected', () => {
  for (const [content, options] of [
    ['garbage'], [ics().replace('END:VEVENT', '')], [ics({ sequence: -1 })],
    [ics().replace('UID:meeting@example.com', 'UID:meeting@example.com\r\nUID:other')],
    [ics(), { mimeMethod: 'REPLY' }], [ics(), { maxBytes: 10 }],
    [ics({ stamp: '20260912T090000' })], [ics({ start: null })],
    [ics({ start: '20260231T140000Z' })], [ics({ start: '20261315T140000Z' })],
    [ics({ properties: 'DURATION:PT1H' })], [ics({ extra: 'RECURRENCE-ID;RANGE=THISANDPRIOR:20260915T140000Z' })],
  ]) assert.throws(() => parseCalendar(content, options));
});

test('native MIME extraction decodes calendar attachment and deduplicates normalized parts', async () => {
  const calendar = ics();
  const rawMime = calendarMime({ from: organizer, to: mailbox, subject: 'Invitation', calendar });
  const parts = await extractCalendarParts({ rawMime, calendarParts: [{ content: calendar }] });
  assert.equal(parts.length, 1);
  assert.equal(parseCalendar(parts[0].content).method, 'REQUEST');
  await assert.rejects(extractCalendarParts({ rawMime }, 2), /too large/);
});

test('verified requests import once, preserve matching version, and notify after persistence', async t => {
  const f = fixture(t), source = ics();
  const a = (await f.ingest(source, { messageId: 'one' })).results[0];
  assert.equal(a.status, 'applied');
  assert.equal(f.event().title, 'Design review');
  const b = (await f.ingest(source, { messageId: 'one' })).results[0];
  assert.equal(b.duplicate, true);
  const c = (await f.ingest(source)).results[0];
  assert.equal(c.status, 'duplicate');
  assert.equal(f.event().version, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1);
});

test('new sequence and DTSTAMP win while stale and replayed changes cannot overwrite', async t => {
  const f = fixture(t);
  await f.ingest(ics({ sequence: 2 }));
  assert.equal((await f.ingest(ics({ sequence: 1, stamp: '20260913T090000Z' }))).results[0].status, 'stale');
  await f.ingest(ics({ sequence: 2, stamp: '20260912T100000Z' }).replace('Design review', 'Updated title'));
  assert.equal(f.event().title, 'Updated title');
  assert.equal((await f.ingest(ics({ sequence: 2 }))).results[0].status, 'stale');
});

test('unverified calendar messages require explicit owner review and remain isolated by account', async t => {
  const f = fixture(t);
  const result = (await f.ingest(ics(), { trust: undefined })).results[0];
  assert.equal(result.status, 'review');
  assert.equal(f.event(), undefined);
  await assert.rejects(f.service.review(result.id, { userId: 'eve' }, 'accept'), /not found/);
  assert.equal((await f.service.review(result.id, user, 'accept')).status, 'applied');
  await assert.rejects(f.service.review(result.id, user, 'accept'), /already been resolved/);
  const other = (await f.ingest(ics(), { accountId: 'account-2' })).results[0];
  assert.equal(other.status, 'review', 'trusted account identity cannot cross mailboxes');
});

test('raw Authentication-Results headers never authorize a spoofed meeting change', async t => {
  const f = fixture(t);
  const rawMime = 'Authentication-Results: mx.example; dkim=pass header.d=example.com\r\n' + calendarMime({ from: organizer, to: mailbox, subject: 'Spoof', calendar: ics() });
  const result = (await f.ingest('', { calendarParts: [], rawMime, trust: undefined })).results[0];
  assert.equal(result.status, 'review');
  assert.equal(f.event(), undefined);
});

test('organizer replacement and unrelated mailbox targets are rejected even after review', async t => {
  const f = fixture(t);
  await f.ingest(ics());
  const replacement = (await f.ingest(ics({ from: 'attacker@example.com', sequence: 1 }), { trust: undefined })).results[0];
  assert.equal((await f.service.review(replacement.id, user, 'accept')).status, 'rejected');
  const wrongTarget = (await f.ingest(ics({ uid: 'another', attendee: 'someone@example.com' }))).results[0];
  assert.equal(wrongTarget.status, 'rejected');
  assert.equal(f.event().organizer, organizer);
});

test('cancellation tombstones prevent old requests from recreating cancelled events', async t => {
  const f = fixture(t);
  await f.ingest(ics({ method: 'CANCEL', sequence: 3, start: null, end: null }));
  assert.equal(f.event().cancelled, true);
  assert.equal((await f.ingest(ics({ sequence: 2 }))).results[0].status, 'stale');
  assert.equal((await f.ingest(ics({ sequence: 3, stamp: '20260913T000000Z' }))).results[0].status, 'stale');
  await f.ingest(ics({ sequence: 4, stamp: '20260914T000000Z' }));
  assert.equal(f.event().cancelled, false);
});

test('recurring instance updates and THISANDFUTURE cancellation retain the master event', async t => {
  const f = fixture(t);
  await f.ingest(ics({ extra: 'RRULE:FREQ=WEEKLY;COUNT=4' }));
  await f.ingest(ics({ sequence: 1, start: '20260922T160000Z', end: '20260922T170000Z', extra: 'RECURRENCE-ID:20260922T140000Z' }));
  await f.ingest(ics({ method: 'CANCEL', sequence: 2, start: null, end: null, extra: 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260929T140000Z' }));
  const record = f.event();
  assert.equal(record.start, '2026-09-15T14:00:00.000Z');
  assert.equal(record.recurrenceOverrides['2026-09-22T14:00:00.000Z'].start, '2026-09-22T16:00:00.000Z');
  assert.equal(record.recurrenceOverrides['2026-09-29T14:00:00.000Z'].cancelled, true);
  assert.equal(record.recurrenceOverrides['2026-09-29T14:00:00.000Z'].range, 'THISANDFUTURE');
});

test('verified native attendee replies update organizer status without creating outbound reply loops', async t => {
  const f = fixture(t); f.invitation();
  const result = (await f.ingest(ics({ method: 'REPLY', from: mailbox, attendee: organizer, partstat: 'ACCEPTED' }))).results[0];
  assert.equal(result.status, 'applied');
  assert.equal(f.event('local-event').attendeeStatuses[organizer], 'ACCEPTED');
  assert.equal(f.db.prepare("SELECT partstat FROM invitation_attendees WHERE invitation_id='invitation-1'").get().partstat, 'ACCEPTED');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='jobs'").get().n, 0);
});

test('attendee sender mismatch, unauthorized guests and stale replies cannot change authoritative RSVP', async t => {
  const f = fixture(t); f.invitation({ sequence: 2 });
  const source = ics({ method: 'REPLY', from: mailbox, attendee: organizer, partstat: 'ACCEPTED', sequence: 2 });
  const mismatch = (await f.ingest(source, { trust: { source: 'provider', verified: true, authenticatedSender: 'attacker@example.com', method: 'dkim', accountId: 'account-1' } })).results[0];
  assert.equal(mismatch.status, 'review');
  const stale = (await f.ingest(source.replace('SEQUENCE:2', 'SEQUENCE:1'))).results[0];
  assert.equal(stale.status, 'stale');
  const unauthorized = (await f.ingest(source.replace(`mailto:${organizer}`, 'mailto:attacker@example.com'), { trust: { source: 'provider', verified: true, authenticatedSender: 'attacker@example.com', method: 'provider', accountId: 'account-1' } })).results[0];
  assert.equal(unauthorized.status, 'rejected');
  assert.equal(f.event('local-event').attendeeStatuses[organizer], 'NEEDS-ACTION');
});

test('a newer attendee DTSTAMP changes response; replay does not regress it', async t => {
  const f = fixture(t); f.invitation();
  const reply = ics({ method: 'REPLY', from: mailbox, attendee: organizer, partstat: 'ACCEPTED' });
  await f.ingest(reply);
  await f.ingest(reply.replace('PARTSTAT=ACCEPTED', 'PARTSTAT=DECLINED').replace('DTSTAMP:20260912T090000Z', 'DTSTAMP:20260912T100000Z'));
  assert.equal((await f.ingest(reply)).results[0].status, 'stale');
  assert.equal(f.event('local-event').attendeeStatuses[organizer], 'DECLINED');
});

test('instance RSVP remains separate from the master attendee status', async t => {
  const f = fixture(t); f.invitation({ repeat: 'weekly' });
  await f.ingest(ics({ method: 'REPLY', from: mailbox, attendee: organizer, partstat: 'DECLINED', extra: 'RECURRENCE-ID:20260922T140000Z' }));
  assert.equal(f.event('local-event').attendeeStatuses[organizer], 'NEEDS-ACTION');
  assert.equal(f.event('local-event').instanceAttendeeStatuses['2026-09-22T14:00:00.000Z'][organizer], 'DECLINED');
});

test('malformed calendar mail is durably classified without aborting mail synchronization', async t => {
  const f = fixture(t);
  const result = await f.ingest('bad calendar');
  assert.equal(result.results[0].status, 'invalid');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM calendar_inbound').get().n, 1);
});

test('review API enforces mailbox ownership and unrelated routes fall through', async t => {
  const f = fixture(t);
  await f.ingest(ics(), { trust: undefined });
  const response = await f.service.handle(new Request('https://app.example/api/calendar/inbound'), user);
  assert.equal((await response.json()).messages.length, 1);
  const other = await f.service.handle(new Request('https://app.example/api/calendar/inbound'), { userId: 'other' });
  assert.equal((await other.json()).messages.length, 0);
  assert.equal((await f.service.handle(new Request('https://app.example/api/calendar/inbound'), null)).status, 401);
  assert.equal(await f.service.handle(new Request('https://app.example/api/unrelated'), user), null);
});

test('imported recurrence renders COUNT, EXDATE, detached updates and cancelled future range', async t => {
  const f = fixture(t);
  await f.ingest(ics({ extra: 'RRULE:FREQ=WEEKLY;COUNT=5\r\nEXDATE:20260922T140000Z' }));
  await f.ingest(ics({ sequence: 1, start: '20260929T160000Z', end: '20260929T170000Z', extra: 'RECURRENCE-ID:20260929T140000Z' }));
  await f.ingest(ics({ method: 'CANCEL', sequence: 2, start: null, end: null, extra: 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261006T140000Z' }));
  const occurrences = expandImportedCalendar(f.event(), '2026-09-01', '2026-11-01');
  assert.deepEqual(occurrences.map(event => event.start), ['2026-09-15T14:00:00.000Z', '2026-09-29T16:00:00.000Z']);
});

test('imported timezone recurrence preserves wall time across daylight-saving changes', async t => {
  const f = fixture(t);
  const source = ics({ extra: 'RRULE:FREQ=WEEKLY;COUNT=3' }).replace('DTSTART:20260915T140000Z', 'DTSTART;TZID=Europe/Warsaw:20261018T140000').replace('DTEND:20260915T150000Z', 'DTEND;TZID=Europe/Warsaw:20261018T150000');
  await f.ingest(source);
  const occurrences = expandImportedCalendar(f.event(), '2026-10-01', '2026-11-15');
  assert.deepEqual(occurrences.map(event => event.start), ['2026-10-18T12:00:00.000Z', '2026-10-25T13:00:00.000Z', '2026-11-01T13:00:00.000Z']);
});

test('recurrence expansion reports bounded truncation and includes exceptions moved into a window', async t => {
  const f = fixture(t);
  await f.ingest(ics({ extra: 'RRULE:FREQ=DAILY' }));
  const bounded = expandImportedCalendar(f.event(), '2026-09-01', '2028-01-01', { max: 2 });
  assert.equal(bounded.length, 2); assert.equal(bounded.truncated, true);
  await f.ingest(ics({ sequence: 1, start: '20260916T160000Z', end: '20260916T170000Z', extra: 'RECURRENCE-ID:20261201T140000Z' }));
  const occurrences = expandImportedCalendar(f.event(), '2026-09-16', '2026-09-17');
  assert.deepEqual(occurrences.map(event => event.start), ['2026-09-16T14:00:00.000Z', '2026-09-16T16:00:00.000Z']);
});

test('a mailbox attendee can send durable native REPLY and duplicate clicks do not resubmit', async t => {
  const f = fixture(t, { connected: true });
  const inbound = (await f.ingest(ics())).results[0];
  const response = await f.service.respond(inbound.id, user, 'accepted');
  assert.equal(response.status, 'queued');
  assert.equal((await f.service.respond(inbound.id, user, 'accepted')).duplicate, true);
  assert.equal(f.event().myResponse, 'ACCEPTED');
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].to, organizer);
  const native = parseCalendar(f.deliveries[0].calendar).events[0];
  assert.equal(native.method, 'REPLY');
  assert.equal(native.attendees.length, 1);
  assert.equal(native.attendees[0].email, mailbox);
  assert.equal(native.attendees[0].partstat, 'ACCEPTED');
  assert.equal(f.event().rsvpDelivery, 'accepted');
});

test('cancelled and superseded imports cannot enqueue or deliver old attendee replies', async t => {
  const f = fixture(t, { connected: true });
  const original = (await f.ingest(ics())).results[0];
  await f.service.respond(original.id, user, 'accepted');
  await f.ingest(ics({ method: 'CANCEL', sequence: 1 }));
  await assert.rejects(f.service.respond(original.id, user, 'declined'), /changed/);
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.db.prepare('SELECT status FROM inbound_calendar_outgoing').get().status, 'superseded');
});

test('response API rejects unreviewed requests and a mismatching sending account', async t => {
  const f = fixture(t, { connected: true });
  const unverified = (await f.ingest(ics(), { trust: undefined })).results[0];
  await assert.rejects(f.service.respond(unverified.id, user, 'accepted'), /Review and accept/);
  await f.service.review(unverified.id, user, 'accept');
  f.service.resolveAccount = async () => ({ email: 'other@example.com' });
  await assert.rejects(f.service.respond(unverified.id, user, 'accepted'), /original attendee mailbox/);
});
