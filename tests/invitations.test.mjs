import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DurableScheduler} from '../backend/jobs.js';
import {InvitationService, calendarIcs, calendarMime} from '../backend/invitations.js';

const START = Date.parse('2026-09-12T09:00:00.000Z');
const alice = {userId: 'alice', email: 'alice@example.com', displayName: 'Alice'};
const bob = {userId: 'bob', email: 'bob@example.com', displayName: 'Bob'};
const eve = {userId: 'eve', email: 'eve@example.com', displayName: 'Eve'};
const eventData = patch => ({
  title: 'Design review', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T15:00:00.000Z',
  attendees: bob.email, location: 'Studio, room 2', notes: 'Review the proposal', timezone: 'UTC', repeat: 'none', ...patch,
});
const unfold = value => value.replace(/\r\n[ \t]/g, '');

function calendarPart(raw) {
  const match = raw.match(/Content-Type: text\/calendar;[^\r\n]+\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition:[^\r\n]+\r\n\r\n([\s\S]*?)\r\n--/);
  assert.ok(match, 'MIME includes a base64 calendar part');
  return Buffer.from(match[1].replace(/\s/g, ''), 'base64').toString('utf8');
}

function fixture(t, {authorize, deliver} = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_warm_stick.sql', import.meta.url), 'utf8'));
  let clock = START;
  const deliveries = [], events = [];
  const now = () => clock;
  const scheduler = new DurableScheduler({db, now}).migrate();
  const service = new InvitationService({
    db, scheduler, now, env: {PUBLIC_URL: 'https://avenor.example'}, authorize,
    emit: (...args) => events.push(args),
    deliver: async message => {
      deliveries.push(message);
      return deliver ? deliver(message) : {status: 'completed'};
    },
  }).migrate();
  t.after(() => { scheduler.stop(); db.close(); });
  return {
    db, scheduler, service, deliveries, events,
    advance(ms) { clock += ms; },
    record(id = 'event-1', data = {}, {owner = alice.userId, scope = 'user:alice'} = {}) {
      db.prepare("INSERT INTO records(id,owner,scope,kind,data,version,updated,deleted) VALUES(?,?,?,'event',?,1,?,0)").run(id, owner, scope, JSON.stringify(eventData(data)), clock);
    },
    update(id, patch) {
      const row = db.prepare('SELECT * FROM records WHERE id=?').get(id);
      db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data), ...patch}), clock, id);
      return row.version + 1;
    },
    async request(path, method = 'GET', body, user = alice) {
      const response = await service.handle(new Request('https://avenor.example/api/' + path, {
        method, headers: {'content-type': 'application/json', origin: 'https://avenor.example'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      }), user);
      return {status: response.status, data: await response.json()};
    },
    async invite(patch = {}, user = alice) {
      return this.request('invitations', 'POST', {eventId: 'event-1', version: 1, ...patch}, user);
    },
    token(email = bob.email) {
      const delivery = [...deliveries].reverse().find(message => message.to === email && /Review and respond:/.test(message.text));
      assert.ok(delivery, 'attendee received an invitation response link');
      const match = delivery.text.match(/https:\/\/avenor\.example\/api\/invitations\/respond\/([A-Za-z0-9_-]{43})/);
      assert.ok(match);
      return match[1];
    },
    async tokenRequest(token, {method = 'GET', response = 'accepted', headers = {}, body, query = ''} = {}) {
      return service.handle(new Request(`https://avenor.example/api/invitations/respond/${token}${query}`, {
        method,
        headers: {origin: 'https://avenor.example', ...(method === 'POST' ? {'content-type': 'application/x-www-form-urlencoded'} : {}), ...headers},
        ...(method === 'POST' ? {body: body ?? new URLSearchParams({response}).toString()} : {}),
      }), null);
    },
    state() {
      return Object.fromEntries(['records', 'invitations', 'invitation_attendees', 'jobs', 'notifications'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    },
  };
}

for (const method of ['REQUEST', 'CANCEL', 'REPLY']) {
  test(`${method} calendar MIME preserves its method, UID, sequence and attendee response`, () => {
    const calendar = calendarIcs({
      event: eventData(), uid: 'stable-meeting@avenor', sequence: 4, organizer: alice.email,
      attendees: [{email: bob.email, partstat: method === 'REPLY' ? 'ACCEPTED' : 'NEEDS-ACTION'}], method, now: START,
    });
    const raw = calendarMime({from: alice.email, to: bob.email, subject: 'Design review ✨', text: 'Meeting details', calendar, method, id: 'stable-message-id', now: START});
    assert.match(raw, /MIME-Version: 1\.0\r\n/);
    assert.ok(raw.includes(`Content-Type: text/calendar; charset=UTF-8; method=${method};`));
    assert.equal(calendarPart(raw), calendar);
    const content = unfold(calendar);
    assert.ok(content.includes(`METHOD:${method}\r\n`));
    assert.ok(content.includes('UID:stable-meeting@avenor\r\n'));
    assert.ok(content.includes('SEQUENCE:4\r\n'));
    assert.ok(content.includes('ORGANIZER:mailto:alice@example.com\r\n'));
    assert.ok(content.includes(`PARTSTAT=${method === 'REPLY' ? 'ACCEPTED' : 'NEEDS-ACTION'}`));
    assert.ok(content.includes(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}\r\n`));
    assert.equal(content.includes(';RSVP=TRUE'), method === 'REQUEST');
    const repeated = calendarMime({from: alice.email, to: bob.email, subject: 'Design review ✨', text: 'Meeting details', calendar, method, id: 'stable-message-id', now: START});
    assert.equal(repeated, raw, 'the same delivery identity produces the same MIME message');
  });
}

test('calendar serialization escapes structured text, folds UTF-8 safely and preserves all-day dates', () => {
  const title = 'Planning, review; next\\step\n' + '✨'.repeat(40);
  const calendar = calendarIcs({
    event: eventData({title, allDay: true, timezone: 'America/Los_Angeles', start: '2026-09-15T07:00:00Z', end: '2026-09-16T07:00:00Z', repeat: 'weekly', until: '2026-10-15'}),
    uid: 'all-day@avenor', organizer: alice.email, attendees: [bob.email], now: START,
  });
  for (const line of calendar.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'folded iCalendar lines fit 75 octets');
  const content = unfold(calendar);
  assert.ok(content.includes('SUMMARY:Planning\\, review\\; next\\\\step\\n' + '✨'.repeat(40)));
  assert.ok(content.includes('DTSTART;VALUE=DATE:20260915\r\n'));
  assert.ok(content.includes('DTEND;VALUE=DATE:20260916\r\n'));
  assert.ok(content.includes('RRULE:FREQ=WEEKLY;UNTIL=20261015\r\n'));
  assert.equal(content.includes('�'), false);
});

test('calendar and MIME serialization reject address, UID and attendee parameter injection', () => {
  const valid = {event: eventData(), uid: 'safe@avenor', organizer: alice.email, attendees: [bob.email]};
  assert.throws(() => calendarIcs({...valid, uid: 'uid\r\nMETHOD:CANCEL'}), {status: 400});
  assert.throws(() => calendarIcs({...valid, organizer: 'alice@example.com\r\nATTENDEE:evil@example.com'}), {status: 400});
  assert.throws(() => calendarIcs({...valid, attendees: [{email: bob.email, partstat: 'ACCEPTED;ROLE=CHAIR'}]}), {status: 400});
  assert.throws(() => calendarIcs({...valid, event: eventData({end: '2026-09-15T13:00:00Z'})}), {status: 400});
  assert.throws(() => calendarMime({from: alice.email, to: 'bob@example.com\r\nBcc: hidden@example.com', subject: 'Hello', calendar: 'calendar'}), {status: 400});
});

test('long Unicode MIME subjects use RFC 2047 encoded words of at most 75 characters without splitting UTF-8', () => {
  const subject = 'Révision ✨ 你好 🌍 '.repeat(20);
  const calendar = calendarIcs({event: eventData(), uid: 'subject-test@avenor', organizer: alice.email, now: START});
  const raw = calendarMime({from: alice.email, to: bob.email, subject, calendar, id: 'long-subject', now: START});
  const header = raw.match(/(?:^|\r\n)Subject: ([\s\S]*?)(?=\r\n[^ \t])/)[1];
  const encodedWords = [...header.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
  assert.ok(encodedWords.length > 1, 'a long subject must be divided into multiple encoded words');
  const decoded = encodedWords.map(match => {
    assert.ok(match[0].length <= 75, 'each complete encoded word fits the RFC 2047 limit');
    const word = Buffer.from(match[1], 'base64').toString('utf8');
    assert.equal(word.includes('�'), false, 'an encoded word must not cut a UTF-8 character');
    return word;
  }).join('');
  assert.equal(decoded, subject);
  for (const line of ('Subject: ' + header).split('\r\n')) assert.ok(line.length <= 78, 'subject header lines are folded for interoperable mail transport');
});

test('invitation revisions keep a stable UID, increment sequence, and suppress duplicate requests', async t => {
  const f = fixture(t);
  f.record();
  const first = await f.invite();
  assert.equal(first.status, 202);
  assert.equal(first.data.sequence, 0);
  assert.equal(first.data.method, 'REQUEST');
  const duplicate = await f.invite();
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.uid, first.data.uid);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 1);
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 1);
  const version = f.update('event-1', {title: 'Design review — revised', start: '2026-09-15T16:00:00Z', end: '2026-09-15T17:00:00Z'});
  const updated = await f.invite({version});
  assert.equal(updated.status, 202);
  assert.equal(updated.data.id, first.data.id);
  assert.equal(updated.data.uid, first.data.uid);
  assert.equal(updated.data.sequence, 1);
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 2);
  const calendar = unfold(calendarPart(f.deliveries[1].raw));
  assert.ok(calendar.includes(`UID:${first.data.uid}\r\n`));
  assert.ok(calendar.includes('SEQUENCE:1\r\n'));
  assert.ok(calendar.includes('DTSTART:20260915T160000Z\r\n'));
});

test('superseded queued invitation revisions do not send obsolete meeting details', async t => {
  const f = fixture(t);
  f.record();
  const first = await f.invite();
  const version = f.update('event-1', {title: 'Latest title'});
  const second = await f.invite({version});
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 1);
  assert.ok(f.deliveries[0].subject.includes('Latest title'));
  assert.ok(unfold(f.deliveries[0].calendar).includes('SEQUENCE:1\r\n'));
});

test('only the event organizer may create or revise invitations even in a shared workspace', async t => {
  const f = fixture(t, {authorize: ({user, scope}) => scope === 'team:studio' && ['alice', 'bob'].includes(user.userId)});
  f.record('event-1', {}, {scope: 'team:studio'});
  assert.equal((await f.invite({}, null)).status, 401);
  assert.equal((await f.invite({}, bob)).status, 403);
  assert.equal((await f.invite({}, eve)).status, 403);
  assert.equal((await f.invite({version: 0})).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 0);
  assert.equal((await f.invite()).status, 202);
  assert.equal((await f.invite({method: 'CANCEL'}, bob)).status, 403);
});

test('signed-in RSVP requires an invited attendee and records the authenticated email', async t => {
  const f = fixture(t, {authorize: ({user, scope}) => scope === 'team:studio' && ['alice', 'bob', 'eve'].includes(user.userId)});
  f.record('event-1', {}, {scope: 'team:studio'});
  const created = await f.invite();
  const path = 'invitations/' + created.data.id + '/respond';
  assert.equal((await f.request(path, 'POST', {response: 'accepted', email: bob.email}, eve)).status, 403);
  assert.equal((await f.request(path, 'POST', {response: 'accepted'}, alice)).status, 403);
  const result = await f.request(path, 'POST', {response: 'tentative', email: eve.email}, bob);
  assert.equal(result.status, 200);
  const attendees = f.db.prepare('SELECT email,partstat FROM invitation_attendees').all();
  assert.deepEqual(attendees.map(a => ({...a})), [{email: bob.email, partstat: 'TENTATIVE'}]);
  const record = f.db.prepare('SELECT data FROM records WHERE id=?').get('event-1');
  assert.deepEqual(JSON.parse(record.data).attendeeStatuses, {[bob.email]: 'TENTATIVE'});
});

test('RSVP links persist only their hashes and a GET, including response query parameters, changes no state', async t => {
  const f = fixture(t);
  f.record('event-1', {title: '<script>alert(1)</script> & review'});
  await f.invite();
  await f.scheduler.runDue();
  const token = f.token();
  const row = f.db.prepare('SELECT * FROM invitation_attendees').get();
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(row.token_hash.length, 64);
  assert.equal(JSON.stringify(f.state()).includes(token), false, 'bearer token never appears in persisted invitation, job or record data');
  const before = f.state();
  const response = await f.tokenRequest(token, {query: '?response=accepted'});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const page = await response.text();
  assert.ok(page.includes('<form method="post"'));
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; review'));
  assert.equal(page.includes('<script>alert(1)</script>'), false);
  assert.deepEqual(f.state(), before);
  const summary = await f.request('invitations?eventId=event-1');
  assert.equal(JSON.stringify(summary.data).includes('token_hash'), false);
  assert.equal(JSON.stringify(summary.data).includes(token), false);
});

test('RSVP form POST is idempotent, updates the event once and sends one standards-formatted reply', async t => {
  const f = fixture(t);
  f.record();
  const invitation = await f.invite();
  await f.scheduler.runDue();
  const token = f.token();
  const first = await f.tokenRequest(token, {method: 'POST', response: 'accepted'});
  assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('Your response is accepted.'));
  const state = f.state();
  const duplicate = await f.tokenRequest(token, {method: 'POST', response: 'accepted'});
  assert.equal(duplicate.status, 200);
  assert.deepEqual(f.state(), state);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='invitation-reply'").get().count, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='rsvp'").get().count, 1);
  const record = f.db.prepare('SELECT version,data FROM records WHERE id=?').get('event-1');
  assert.equal(record.version, 2);
  assert.equal(JSON.parse(record.data).attendeeStatuses[bob.email], 'ACCEPTED');
  assert.equal((await f.tokenRequest(token, {method: 'POST', response: 'declined'})).status, 409);
  await f.scheduler.runDue();
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 2, 'one invitation and one reply are delivered');
  const reply = f.deliveries[1];
  assert.equal(reply.to, alice.email);
  const calendar = unfold(calendarPart(reply.raw));
  assert.ok(calendar.includes('METHOD:REPLY\r\n'));
  assert.ok(calendar.includes(`UID:${invitation.data.uid}\r\n`));
  assert.ok(calendar.includes('SEQUENCE:0\r\n'));
  assert.ok(calendar.includes('PARTSTAT=ACCEPTED:mailto:bob@example.com\r\n'));
});

test('cancellation increments sequence, sends CANCEL with the original UID and invalidates old response links', async t => {
  const f = fixture(t);
  f.record();
  const invitation = await f.invite();
  await f.scheduler.runDue();
  const token = f.token();
  const cancelled = await f.invite({method: 'CANCEL'});
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.data.uid, invitation.data.uid);
  assert.equal(cancelled.data.sequence, 1);
  assert.equal(cancelled.data.method, 'CANCEL');
  assert.ok([404, 410].includes((await f.tokenRequest(token)).status));
  assert.ok([404, 410].includes((await f.tokenRequest(token, {method: 'POST'})).status));
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 2);
  const cancellation = f.deliveries[1];
  const calendar = unfold(calendarPart(cancellation.raw));
  assert.ok(calendar.includes('METHOD:CANCEL\r\n'));
  assert.ok(calendar.includes(`UID:${invitation.data.uid}\r\n`));
  assert.ok(calendar.includes('SEQUENCE:1\r\n'));
  assert.ok(calendar.includes('STATUS:CANCELLED\r\n'));
  assert.equal(cancellation.text.includes('/invitations/respond/'), false);
  assert.equal(f.db.prepare('SELECT token_hash FROM invitation_attendees').get().token_hash, null);
});

test('revised invitations invalidate old attendee links and deliver fresh links', async t => {
  const f = fixture(t);
  f.record();
  await f.invite();
  await f.scheduler.runDue();
  const previous = f.token();
  const version = f.update('event-1', {location: 'A different room'});
  await f.invite({version});
  assert.ok([404, 410].includes((await f.tokenRequest(previous)).status));
  await f.scheduler.runDue();
  const current = f.token();
  assert.notEqual(current, previous);
  assert.equal((await f.tokenRequest(current)).status, 200);
});

test('removing an attendee sends that guest a cancellation and sends the revised request only to remaining guests', async t => {
  const f = fixture(t);
  f.record('event-1', {attendees: `${bob.email}, ${eve.email}`});
  const first = await f.invite();
  assert.equal(first.status, 202);
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 2);
  const removedToken = f.token(bob.email);
  const version = f.update('event-1', {attendees: eve.email, title: 'Smaller design review'});
  const updated = await f.invite({version});
  assert.equal(updated.status, 202);
  assert.equal(updated.data.sequence, 1);
  assert.deepEqual(updated.data.attendees.map(a => a.email), [eve.email]);
  assert.ok([404, 410].includes((await f.tokenRequest(removedToken, {method: 'POST'})).status));
  await f.scheduler.runDue();
  const revisions = f.deliveries.slice(2);
  assert.equal(revisions.length, 2, 'the removed guest receives a cancellation and the remaining guest receives the update');
  const cancellation = revisions.find(message => message.to === bob.email);
  const request = revisions.find(message => message.to === eve.email);
  assert.ok(cancellation);
  assert.ok(request);
  const cancelledCalendar = unfold(calendarPart(cancellation.raw));
  assert.ok(cancelledCalendar.includes('METHOD:CANCEL\r\n'));
  assert.ok(cancelledCalendar.includes('STATUS:CANCELLED\r\n'));
  assert.ok(cancelledCalendar.includes(`UID:${first.data.uid}\r\n`));
  assert.ok(cancelledCalendar.includes('SEQUENCE:1\r\n'));
  assert.equal(cancellation.text.includes('/invitations/respond/'), false);
  const updatedCalendar = unfold(calendarPart(request.raw));
  assert.ok(updatedCalendar.includes('METHOD:REQUEST\r\n'));
  assert.ok(updatedCalendar.includes(`UID:${first.data.uid}\r\n`));
  assert.ok(updatedCalendar.includes('SEQUENCE:1\r\n'));
  assert.equal((await f.invite({version})).data.duplicate, true);
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 4, 'a repeated revision must not resend the removed attendee cancellation');
});

for (const readdRemovedGuest of [false, true]) {
  test(`queued attendee cancellation survives a later revision${readdRemovedGuest ? ' that re-adds the guest' : ''}`, async t => {
    const f = fixture(t);
    f.record('event-1', {attendees: `${bob.email}, ${eve.email}`});
    const initial = await f.invite();
    assert.equal(initial.status, 202);
    await f.scheduler.runDue();
    assert.equal(f.deliveries.length, 2);

    const removalVersion = f.update('event-1', {attendees: eve.email, title: 'Smaller review'});
    const removal = await f.invite({version: removalVersion});
    assert.equal(removal.status, 202);
    assert.equal(removal.data.sequence, 1);

    const newestVersion = f.update('event-1', {
      title: 'Newest meeting details',
      ...(readdRemovedGuest ? {attendees: `${bob.email}, ${eve.email}`} : {}),
    });
    const newest = await f.invite({version: newestVersion});
    assert.equal(newest.status, 202);
    assert.equal(newest.data.sequence, 2);
    assert.equal(f.deliveries.length, 2, 'both revisions are still queued');
    await f.scheduler.runDue();

    const revisions = f.deliveries.slice(2).map(message => ({message, calendar: unfold(calendarPart(message.raw))}));
    const cancellations = revisions.filter(item => item.calendar.includes('METHOD:CANCEL\r\n'));
    assert.equal(cancellations.length, 1, 'the removed guest cancellation survives superseding revisions');
    assert.equal(cancellations[0].message.to, bob.email);
    assert.ok(cancellations[0].calendar.includes(`UID:${initial.data.uid}\r\n`));
    assert.ok(cancellations[0].calendar.includes('SEQUENCE:1\r\n'));
    assert.ok(cancellations[0].calendar.includes('SUMMARY:Smaller review\r\n'), 'cancellation retains the snapshot captured when the guest was removed');
    assert.equal(cancellations[0].message.text.includes('/invitations/respond/'), false);

    const requests = revisions.filter(item => item.calendar.includes('METHOD:REQUEST\r\n'));
    assert.deepEqual(requests.map(item => item.message.to).sort(), readdRemovedGuest ? [bob.email, eve.email].sort() : [eve.email]);
    for (const {calendar} of requests) {
      assert.ok(calendar.includes(`UID:${initial.data.uid}\r\n`));
      assert.ok(calendar.includes('SEQUENCE:2\r\n'), 'superseded sequence-one requests are not delivered');
      assert.ok(calendar.includes('SUMMARY:Newest meeting details\r\n'));
    }
    assert.equal(revisions.length, readdRemovedGuest ? 3 : 2);
    await f.scheduler.runDue();
    assert.equal(f.deliveries.length, readdRemovedGuest ? 5 : 4, 'later scheduler runs do not repeat the cancellation or requests');
  });
}

test('expired and malformed RSVP links reject responses without writing attendee state', async t => {
  const f = fixture(t);
  f.record();
  await f.invite();
  await f.scheduler.runDue();
  const token = f.token();
  f.advance(90 * 86_400_000 + 1);
  const before = f.state();
  assert.equal((await f.tokenRequest(token)).status, 410);
  assert.equal((await f.tokenRequest(token, {method: 'POST'})).status, 410);
  assert.equal((await f.tokenRequest('not-a-valid-token')).status, 404);
  assert.deepEqual(f.state(), before);
});

test('RSVP requires an explicit form submission and rejects foreign origins and oversized bodies', async t => {
  const f = fixture(t);
  f.record();
  await f.invite();
  await f.scheduler.runDue();
  const token = f.token(), before = f.state();
  assert.equal((await f.tokenRequest(token, {method: 'POST', headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await f.tokenRequest(token, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({response: 'accepted'})})).status, 415);
  assert.equal((await f.tokenRequest(token, {method: 'POST', body: 'response=accepted&padding=' + 'x'.repeat(1001)})).status, 413);
  assert.equal((await f.tokenRequest(token, {method: 'POST', response: 'unknown'})).status, 400);
  assert.deepEqual(f.state(), before);
});

test('invitation permissions are checked again when deferred delivery runs', async t => {
  let allowed = true;
  const f = fixture(t, {authorize: () => allowed});
  f.record();
  assert.equal((await f.invite()).status, 202);
  allowed = false;
  await f.scheduler.runDue();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.db.prepare('SELECT status FROM jobs').get().status, 'failed');
  assert.equal(f.db.prepare('SELECT token_hash FROM invitation_attendees').get().token_hash, null);
});

test('calendar router leaves unrelated endpoints to the main application', async t => {
  const f = fixture(t);
  assert.equal(await f.service.handle(new Request('https://avenor.example/api/jobs'), null), null);
});

test('owned sending account supplies the organizer address and cannot change the original organizer', async t => {
  const f = fixture(t); f.record();
  f.service.resolveAccount = async ({user, accountId}) => {
    assert.equal(user.userId, alice.userId);
    if (accountId === 'forbidden') throw Object.assign(new Error('Account access denied'), {status: 403});
    return {id: accountId, email: accountId === 'work' ? 'alice@work.example' : 'other@work.example'};
  };
  const rejected = await f.invite({accountId: 'forbidden'});
  assert.equal(rejected.status, 403);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  const first = await f.invite({accountId: 'work'});
  assert.equal(first.status, 202); assert.equal(first.data.organizer, 'alice@work.example');
  await f.scheduler.runDue();
  assert.match(unfold(f.deliveries[0].calendar), /ORGANIZER:mailto:alice@work\.example/);
  assert.match(f.deliveries[0].raw, /From: alice@work\.example/);
  const version = f.update('event-1', {title: 'Updated'});
  assert.equal((await f.invite({version, accountId: 'other'})).status, 403);
  assert.equal((await f.invite({version, accountId: 'work'})).status, 202);
});

test('configured separate frontend origin can send invitations while unconfigured origins cannot', async t => {
  const f = fixture(t); f.record(); f.service.env.FRONTEND_URL = 'https://workspace.example/calendar';
  const request = origin => new Request('https://avenor.example/api/invitations', {method: 'POST', headers: {'content-type':'application/json', origin}, body: JSON.stringify({eventId:'event-1',version:1})});
  assert.equal((await f.service.handle(request('https://evil.example'), alice)).status, 403);
  assert.equal((await f.service.handle(request('https://workspace.example'), alice)).status, 202);
});
