import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableScheduler} from '../backend/jobs.js';

const START = Date.parse('2026-09-12T09:00:00.000Z');
const alice = {userId: 'alice', email: 'alice@example.com', displayName: 'Alice'};
const bob = {userId: 'bob', email: 'bob@example.com', displayName: 'Bob'};
const baseSchema = readFileSync(new URL('../drizzle/0000_warm_stick.sql', import.meta.url), 'utf8');

test('scheduler router leaves unrelated endpoints to the main application', async () => {
  const db = new DatabaseSync(':memory:');
  try { const scheduler = new DurableScheduler({db}).migrate(); assert.equal(await scheduler.handle(new Request('https://avenor.example/api/data'), null), null); }
  finally { db.close(); }
});

function fixture(t, {handlers = {}, persistent = false, authorize} = {}) {
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'avenor-jobs-')) : null;
  const path = dir ? join(dir, 'jobs.sqlite') : ':memory:';
  const connections = [];
  let time = START;
  const now = () => time;
  const events = [];
  const db = open();
  db.exec(baseSchema);
  const scheduler = makeScheduler(db);
  t.after(() => {
    for (const connection of connections) {
      try { connection.close(); } catch {}
    }
    if (dir) rmSync(dir, {recursive: true, force: true});
  });
  function open() {
    const connection = new DatabaseSync(path);
    connections.push(connection);
    return connection;
  }
  function makeScheduler(connection = db) {
    const instance = new DurableScheduler({db: connection, handlers, now, emit: (...args) => events.push(args), ...(authorize ? {authorize} : {})});
    instance.migrate();
    return instance;
  }
  return {
    db, scheduler, events, open, makeScheduler, now,
    advance(ms) { time += ms; },
    setTime(ms) { time = ms; },
    job(id) { return db.prepare('SELECT * FROM jobs WHERE id=?').get(id); },
    enqueue(patch = {}) {
      return scheduler.enqueue({id: 'job-1', type: 'send', payload: {messageId: 'draft-1'}, runAt: time, owner: alice.userId, scope: 'user:alice', ...patch});
    },
    record(id, kind, data, {owner = alice.userId, scope = 'user:alice'} = {}) {
      db.prepare('INSERT INTO records (id,owner,scope,kind,data,version,updated,deleted) VALUES (?,?,?,?,?,1,?,0)').run(id, owner, scope, kind, JSON.stringify(data), time);
      return this.readRecord(id);
    },
    readRecord(id) {
      const row = db.prepare('SELECT * FROM records WHERE id=?').get(id);
      return row ? {...JSON.parse(row.data), id: row.id, owner: row.owner, scope: row.scope, kind: row.kind, version: row.version, deleted: row.deleted} : null;
    },
    async request(path, method = 'GET', body, user = alice, target = scheduler) {
      const response = await target.handle(new Request('https://avenor.example/api/' + path, {
        method,
        headers: {'content-type': 'application/json', origin: 'https://avenor.example'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      }), user);
      return {status: response.status, data: await response.json()};
    },
  };
}

test('pending jobs survive database close and scheduler restart', async t => {
  const deliveries = [];
  const f = fixture(t, {persistent: true, handlers: {send: async (payload, context) => {
    deliveries.push({payload, key: context.idempotencyKey});
    return {status: 'completed'};
  }}});
  await f.enqueue({runAt: START + 60_000});
  await f.scheduler.runDue();
  assert.equal(deliveries.length, 0, 'a future job must not run early');
  f.db.close();
  f.advance(60_000);
  const connection = f.open();
  const restarted = f.makeScheduler(connection);
  await restarted.runDue();
  await restarted.runDue();
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].payload, {messageId: 'draft-1'});
  assert.ok(deliveries[0].key, 'delivery handlers receive a stable idempotency key');
  assert.equal(connection.prepare('SELECT status FROM jobs WHERE id=?').get('job-1').status, 'completed');
});

test('independent scheduler connections claim a due delivery only once', async t => {
  let deliveries = 0;
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture(t, {persistent: true, handlers: {send: async () => {
    deliveries++;
    started();
    await barrier;
    return {status: 'completed'};
  }}});
  await f.enqueue();
  const competing = f.makeScheduler(f.open());
  const first = f.scheduler.runDue();
  await entered;
  try {
    await competing.runDue();
    assert.equal(deliveries, 1, 'the competing worker must not deliver an already claimed job');
  } finally {
    release();
  }
  await first;
  await Promise.all([f.scheduler.runDue(), competing.runDue()]);
  assert.equal(deliveries, 1);
  assert.equal(f.job('job-1').status, 'completed');
});

test('unknown provider outcomes remain terminal across later runs and restart', async t => {
  let deliveries = 0;
  const f = fixture(t, {persistent: true, handlers: {send: async () => {
    deliveries++;
    return {status: 'unknown'};
  }}});
  await f.enqueue();
  await f.scheduler.runDue();
  assert.equal(f.job('job-1').status, 'unknown');
  f.advance(7 * 86_400_000);
  await f.scheduler.runDue();
  const restarted = f.makeScheduler(f.open());
  await restarted.runDue();
  assert.equal(deliveries, 1, 'an ambiguous outcome must never trigger automatic redelivery');
  assert.equal(f.job('job-1').status, 'unknown');
});

test('only explicitly retryable failures retry with increasing delays and the same idempotency key', async t => {
  const attempts = [];
  const f = fixture(t, {handlers: {send: async (_payload, context) => {
    attempts.push({at: f.now(), key: context.idempotencyKey});
    if (attempts.length < 3) throw Object.assign(new Error('Provider unavailable before acceptance'), {retryable: true});
    return {status: 'completed'};
  }}});
  await f.enqueue();
  await f.scheduler.runDue();
  assert.equal(f.job('job-1').status, 'pending');
  await f.scheduler.runDue();
  assert.equal(attempts.length, 1, 'a retry must be delayed');
  for (let elapsed = 0; attempts.length < 2 && elapsed < 3_600_000; elapsed += 1_000) {
    f.advance(1_000);
    await f.scheduler.runDue();
  }
  assert.equal(attempts.length, 2, 'retryable failure should eventually retry');
  await f.scheduler.runDue();
  assert.equal(attempts.length, 2);
  for (let elapsed = 0; attempts.length < 3 && elapsed < 3_600_000; elapsed += 1_000) {
    f.advance(1_000);
    await f.scheduler.runDue();
  }
  assert.equal(attempts.length, 3);
  assert.ok(attempts[2].at - attempts[1].at > attempts[1].at - attempts[0].at, 'successive retries must back off');
  assert.equal(new Set(attempts.map(a => a.key)).size, 1);
  assert.ok(attempts[0].key);
  assert.equal(f.job('job-1').status, 'completed');
});

test('ordinary handler errors fail without automatic retry', async t => {
  let deliveries = 0;
  const f = fixture(t, {handlers: {send: async () => {
    deliveries++;
    throw new Error('Invalid recipient');
  }}});
  await f.enqueue();
  await f.scheduler.runDue();
  assert.equal(f.job('job-1').status, 'failed');
  f.advance(86_400_000);
  await f.scheduler.runDue();
  assert.equal(deliveries, 1);
});

test('a persisted acceptance marker prevents retry after a later retryable error', async t => {
  let deliveries = 0;
  const f = fixture(t, {handlers: {send: async (_payload, context) => {
    deliveries++;
    await context.markAccepted({providerId: 'delivery-123'});
    throw Object.assign(new Error('Connection closed after provider acceptance'), {retryable: true});
  }}});
  await f.enqueue();
  await f.scheduler.runDue();
  assert.ok(['accepted', 'unknown'].includes(f.job('job-1').status));
  f.advance(86_400_000);
  await f.scheduler.runDue();
  assert.equal(deliveries, 1, 'accepted mail must not be retried after a later transport error');
});

test('a crashed delivery lease becomes unknown and is never delivered by a new worker', async t => {
  let deliveries = 0;
  const f = fixture(t, {persistent: true, handlers: {send: async () => {
    deliveries++;
    return {status: 'completed'};
  }}});
  await f.enqueue();
  const claimed = f.scheduler.claim();
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  f.advance(60_001);
  const restarted = f.makeScheduler(f.open());
  await restarted.runDue();
  f.advance(86_400_000);
  await restarted.runDue();
  assert.equal(deliveries, 0, 'delivery may already have escaped the crashed process');
  assert.equal(f.job('job-1').status, 'unknown');
});

test('enqueue is idempotent and rejects reusing an identifier for another owner or payload', async t => {
  const f = fixture(t);
  const first = await f.enqueue();
  const second = await f.enqueue();
  assert.equal(first.id, second.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 1);
  assert.throws(() => f.enqueue({owner: bob.userId, scope: 'user:bob'}), {status: 409});
  assert.throws(() => f.enqueue({payload: {messageId: 'different-draft'}}), {status: 409});
  assert.equal(f.job('job-1').owner, alice.userId);
  assert.deepEqual(JSON.parse(f.job('job-1').payload), {messageId: 'draft-1'});
});

test('job endpoints require authentication and enforce private workspace access', async t => {
  const f = fixture(t);
  await f.enqueue();
  assert.equal((await f.request('jobs', 'GET', undefined, null)).status, 401);
  assert.equal((await f.request('jobs?scope=user:alice', 'GET', undefined, bob)).status, 403);
  const own = await f.request('jobs');
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.jobs.map(job => job.id), ['job-1']);
  const other = await f.request('jobs', 'GET', undefined, bob);
  assert.equal(other.status, 200);
  assert.deepEqual(other.data.jobs, []);
  assert.equal((await f.request('jobs/job-1', 'DELETE', undefined, bob)).status, 404);
  assert.equal(f.job('job-1').status, 'pending');
});

test('shared workspace access does not expose or cancel another member’s jobs', async t => {
  const f = fixture(t, {authorize: ({user, scope}) => scope === `user:${user.userId}` || scope === 'team:studio' && ['alice', 'bob'].includes(user.userId)});
  await f.enqueue({id: 'alice-shared', scope: 'team:studio'});
  await f.enqueue({id: 'bob-shared', owner: bob.userId, scope: 'team:studio'});
  const result = await f.request('jobs?scope=team:studio');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.jobs.map(job => job.id), ['alice-shared']);
  assert.equal((await f.request('jobs/bob-shared', 'DELETE')).status, 404);
  assert.equal((await f.request('jobs/alice-shared', 'DELETE', undefined, bob)).status, 404);
  assert.equal((await f.request('jobs?scope=team:other')).status, 403);
  assert.equal(f.job('bob-shared').status, 'pending');
});

test('scheduled send atomically moves the draft into outbox, captures its version and supports cancellation', async t => {
  let deliveries = 0;
  const f = fixture(t, {handlers: {send: async () => { deliveries++; return {status: 'completed'}; }}});
  f.record('draft-1', 'message', {folder: 'drafts', subject: 'Later', to: bob.email, body: 'A message'});
  const runAt = START + 60_000;
  const created = await f.request('jobs', 'POST', {type: 'send', recordId: 'draft-1', version: 1, runAt, owner: bob.userId, scope: 'user:bob'});
  assert.equal(created.status, 201);
  assert.equal(created.data.job.owner, alice.userId, 'job ownership comes from the authenticated user');
  assert.equal(created.data.job.scope, 'user:alice', 'the canonical draft determines the workspace');
  assert.equal(created.data.job.payload.version, 2);
  const scheduled = f.readRecord('draft-1');
  assert.equal(scheduled.folder, 'outbox');
  assert.equal(scheduled.version, 2);
  assert.equal(scheduled.scheduledJobId, created.data.job.id);
  assert.equal(scheduled.scheduledAt, new Date(runAt).toISOString());
  assert.equal((await f.request('jobs', 'POST', {recordId: 'draft-1', version: 2, runAt})).status, 409);
  const cancelled = await f.request('jobs/' + created.data.job.id, 'DELETE');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.job.status, 'cancelled');
  const draft = f.readRecord('draft-1');
  assert.equal(draft.folder, 'drafts');
  assert.equal(draft.scheduledJobId, undefined);
  assert.equal(draft.scheduledAt, undefined);
  f.advance(60_000);
  await f.scheduler.runDue();
  assert.equal(deliveries, 0);
  assert.equal((await f.request('jobs/' + created.data.job.id, 'DELETE')).status, 200, 'cancellation is idempotent');
});

test('scheduling rejects stale versions, inaccessible drafts, invalid dates and forged automation types', async t => {
  const f = fixture(t);
  f.record('draft-1', 'message', {folder: 'drafts', subject: 'Still a draft'});
  const valid = {recordId: 'draft-1', version: 1, runAt: START + 60_000};
  assert.equal((await f.request('jobs', 'POST', {...valid, version: 0})).status, 409);
  assert.equal((await f.request('jobs', 'POST', valid, bob)).status, 403);
  assert.equal((await f.request('jobs', 'POST', {...valid, runAt: START - 1})).status, 400);
  assert.equal((await f.request('jobs', 'POST', {...valid, runAt: 'not a date'})).status, 400);
  assert.equal((await f.request('jobs', 'POST', {...valid, type: 'provider_sync'})).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  assert.equal(f.readRecord('draft-1').folder, 'drafts');
  assert.equal(f.readRecord('draft-1').version, 1);
});

test('provider authorization failures cannot mutate a draft or create a scheduled job', async t => {
  const checks = [];
  const f = fixture(t, {authorize: args => { checks.push(args); return args.action !== 'schedule-send'; }});
  f.record('draft-1', 'message', {folder: 'drafts', subject: 'Unauthorized provider'});
  const response = await f.request('jobs', 'POST', {recordId: 'draft-1', version: 1, accountId: 'someone-elses-account', runAt: START + 60_000});
  assert.equal(response.status, 403);
  assert.equal(checks[0].action, 'schedule-send');
  assert.equal(checks[0].recordId, 'draft-1');
  assert.equal(checks[0].accountId, 'someone-elses-account');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  assert.equal(f.readRecord('draft-1').version, 1);
});

test('configured authorization requires explicit success before exposing a workspace', async t => {
  const f = fixture(t, {authorize: async () => undefined});
  await f.enqueue({scope: 'team:studio'});
  const response = await f.request('jobs?scope=team:studio');
  assert.equal(response.status, 403, 'a missing authorization result must fail closed');
  assert.equal(response.data.jobs, undefined);
});

test('job writes reject foreign origins and enforce body limits without Content-Length', async t => {
  const f = fixture(t);
  f.record('draft-1', 'message', {folder: 'drafts', subject: 'Protected draft'});
  const valid = {recordId: 'draft-1', version: 1, runAt: START + 60_000};
  const foreign = await f.scheduler.handle(new Request('https://avenor.example/api/jobs', {
    method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.example'}, body: JSON.stringify(valid),
  }), alice);
  assert.equal(foreign.status, 403);
  const tooLarge = await f.request('jobs', 'POST', {...valid, unexpected: 'x'.repeat(32_001)});
  assert.equal(tooLarge.status, 413);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  assert.equal(f.readRecord('draft-1').version, 1);
});

test('retryable failures stop permanently when the retry budget is exhausted', async t => {
  let attempts = 0;
  const f = fixture(t, {handlers: {send: async () => {
    attempts++;
    throw Object.assign(new Error('Provider remains unavailable'), {retryable: true});
  }}});
  await f.enqueue();
  for (let run = 0; run < 10; run++) {
    await f.scheduler.runDue();
    f.advance(3_600_001);
  }
  assert.equal(attempts, 5);
  assert.equal(f.job('job-1').status, 'failed');
  assert.equal(f.job('job-1').attempts, 5);
});

test('running jobs cannot be cancelled after a worker has claimed delivery', async t => {
  const f = fixture(t);
  await f.enqueue();
  f.scheduler.claim();
  assert.equal((await f.request('jobs/job-1', 'DELETE')).status, 409);
  assert.equal(f.job('job-1').status, 'running');
});

test('inbox rules run without a client, stay within their workspace, and avoid repeated record churn', async t => {
  const f = fixture(t);
  f.record('rule-archive', 'rule', {title: 'Newsletters', field: 'subject', contains: 'NEWSLETTER', target: 'archive'});
  f.record('rule-disabled', 'rule', {title: 'Disabled', field: 'from', contains: 'friend', target: 'deleted', enabled: false});
  f.record('rule-flag', 'rule', {title: 'Flag friend', field: 'from', contains: 'FRIEND', target: 'flag'});
  f.record('mail-newsletter', 'message', {folder: 'inbox', subject: 'Monthly newsletter', from: 'news@example.com', read: false});
  f.record('mail-friend', 'message', {folder: 'inbox', subject: 'Hello', from: 'friend@example.com', read: false});
  f.record('mail-bob', 'message', {folder: 'inbox', subject: 'Monthly newsletter', from: 'news@example.com'}, {owner: bob.userId, scope: 'user:bob'});
  await f.scheduler.runDue();
  assert.equal(f.readRecord('mail-newsletter').folder, 'archive');
  assert.equal(f.readRecord('mail-friend').folder, 'inbox');
  assert.equal(f.readRecord('mail-friend').flagged, true);
  assert.equal(f.readRecord('mail-bob').folder, 'inbox');
  const version = f.readRecord('mail-friend').version;
  await f.scheduler.runDue();
  assert.equal(f.readRecord('mail-friend').version, version);
  f.record('mail-new', 'message', {folder: 'inbox', subject: 'A new newsletter', from: 'news@example.com'});
  await f.scheduler.runDue();
  assert.equal(f.readRecord('mail-new').folder, 'archive', 'messages arriving later receive existing rules');
});

test('snoozed messages return on time across restart, while future and deleted messages remain untouched', async t => {
  const f = fixture(t, {persistent: true});
  const until = new Date(START + 60_000).toISOString();
  f.record('snoozed', 'message', {folder: 'archive', subject: 'Wake me', snoozedUntil: until});
  f.record('future', 'message', {folder: 'archive', subject: 'Much later', snoozedUntil: new Date(START + 120_000).toISOString()});
  f.record('deleted-mail', 'message', {folder: 'deleted', subject: 'Do not resurrect', snoozedUntil: until});
  await f.scheduler.runDue();
  assert.equal(f.readRecord('snoozed').folder, 'archive');
  f.advance(60_000);
  const restarted = f.makeScheduler(f.open());
  await restarted.runDue();
  const restored = f.readRecord('snoozed');
  assert.equal(restored.folder, 'inbox');
  assert.equal(restored.snoozedUntil, null);
  assert.equal(f.readRecord('future').folder, 'archive');
  assert.equal(f.readRecord('deleted-mail').folder, 'deleted');
  await restarted.runDue();
  assert.equal(f.readRecord('snoozed').version, restored.version);
});

test('task and event reminders persist once and notifications remain owner scoped', async t => {
  const f = fixture(t, {persistent: true});
  const reminder = new Date(START).toISOString();
  f.record('alice-task', 'task', {title: 'Review the brief', done: false, reminder});
  f.record('alice-event', 'event', {title: 'Design meeting', reminder});
  f.record('completed-task', 'task', {title: 'Already done', done: true, reminder});
  f.record('future-task', 'task', {title: 'Later', done: false, reminder: new Date(START + 60_000).toISOString()});
  f.record('bob-task', 'task', {title: 'Bob private reminder', done: false, reminder}, {owner: bob.userId, scope: 'user:bob'});
  await f.scheduler.runDue();
  await f.scheduler.runDue();
  const restarted = f.makeScheduler(f.open());
  await restarted.runDue();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 3);
  const result = await f.request('notifications');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.notifications.map(n => n.recordId).sort(), ['alice-event', 'alice-task']);
  const notification = result.data.notifications.find(n => n.recordId === 'alice-task');
  assert.equal(notification.read, false);
  assert.equal((await f.request('notifications/' + notification.id, 'PATCH', {read: true}, bob)).status, 404);
  assert.equal((await f.request('notifications?scope=user:alice', 'GET', undefined, bob)).status, 403);
  assert.equal((await f.request('notifications/' + notification.id, 'PATCH', {read: true})).status, 200);
  assert.equal((await f.request('notifications')).data.notifications.find(n => n.id === notification.id).read, true);
});

test('My Day resets on each task owner’s local date and preserves the task itself', async t => {
  const f = fixture(t);
  f.record('alice-settings', 'settings', {timezone: 'America/Los_Angeles'});
  f.record('local-task', 'task', {title: 'Local day', myDay: true, myDayDate: '2026-09-12', important: true, done: false});
  f.record('utc-task', 'task', {title: 'UTC day', myDay: true, myDayDate: '2026-09-12', timezone: 'UTC', done: false});
  f.setTime(Date.parse('2026-09-13T00:30:00Z'));
  await f.scheduler.runDue();
  assert.equal(f.readRecord('utc-task').myDay, false);
  assert.equal(f.readRecord('local-task').myDay, true, 'Los Angeles is still on September 12');
  f.setTime(Date.parse('2026-09-13T07:01:00Z'));
  await f.scheduler.runDue();
  const local = f.readRecord('local-task');
  assert.equal(local.myDay, false);
  assert.equal(local.myDayDate, null);
  assert.equal(local.important, true);
  assert.equal(local.done, false);
  assert.equal(local.deleted, 0);
});

test('completed recurring tasks create exactly one next occurrence with reset steps and shifted reminder', async t => {
  const f = fixture(t, {persistent: true});
  f.record('weekly-task', 'task', {
    title: 'Weekly review', due: '2026-09-12', repeat: 'weekly', done: true,
    myDay: true, myDayDate: '2026-09-12', reminder: '2026-09-12T08:00:00.000Z',
    steps: [{title: 'Read the updates', done: true}, {title: 'Write notes', done: true}],
  });
  await f.scheduler.runDue();
  await f.scheduler.runDue();
  await f.makeScheduler(f.open()).runDue();
  const successors = f.db.prepare("SELECT * FROM records WHERE kind='task' AND json_extract(data,'$.recurrenceParent')=?").all('weekly-task');
  assert.equal(successors.length, 1);
  const next = f.readRecord(successors[0].id);
  assert.equal(next.owner, alice.userId);
  assert.equal(next.scope, 'user:alice');
  assert.equal(next.due, '2026-09-19');
  assert.equal(next.reminder, '2026-09-19T08:00:00.000Z');
  assert.equal(next.done, false);
  assert.equal(next.myDay, false);
  assert.deepEqual(next.steps, [{title: 'Read the updates', done: false}, {title: 'Write notes', done: false}]);
  assert.equal(f.readRecord('weekly-task').done, true, 'the completed occurrence remains in history');
});

test('monthly task recurrence handles a short month and obeys its end date', async t => {
  const f = fixture(t);
  f.record('monthly-task', 'task', {title: 'Month end', due: '2026-01-31', repeat: 'monthly', done: true, until: '2026-02-28'});
  f.record('ended-task', 'task', {title: 'Finished series', due: '2026-01-31', repeat: 'monthly', done: true, until: '2026-02-27'});
  await f.scheduler.runDue();
  const next = f.db.prepare("SELECT * FROM records WHERE json_extract(data,'$.recurrenceParent')='monthly-task'").all();
  assert.equal(next.length, 1);
  assert.equal(JSON.parse(next[0].data).due, '2026-02-28');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM records WHERE json_extract(data,'$.recurrenceParent')='ended-task'").get().count, 0);
});
