# Durable background work and calendar invitations

The standalone Node server runs `DurableScheduler` independently of browser tabs. Keep that server process running, and persist its SQLite database and attachment/provider storage. Closing a browser does not pause scheduled mail, provider polling, inbox rules, snooze returns, reminders, or task maintenance. Stopping the server pauses work; pending work resumes when it restarts. The scheduler is not an operating-system wake service and cannot run while its host is powered off.

## Scheduler integration

`backend/jobs.js` uses Node 24's `node:sqlite` `DatabaseSync` API directly. The constructor accepts `{db, handlers, now, emit, authorize, allowedOrigins, intervalMs, leaseMs, maxAttempts}`. Defaults are a one-second polling interval, a 60-second lease, and five attempts. `migrate()` is idempotent; `start()` migrates and begins polling; `stop()` stops further polling. An already executing asynchronous handler may finish after `stop()`.

```js
const scheduler = new DurableScheduler({
  db,
  authorize: async ({user, scope, recordId, action, accountId}) => {
    // Check current user, current workspace membership, record and account ownership.
    // Return exactly true to allow; otherwise deny or throw a status-bearing error.
    return true;
  },
  emit: (scope, event) => liveHub.publish(scope, event),
  handlers: {
    send: async (payload, context) => {
      // Reauthorize the stored user against current membership/account access.
      // Claim the exact draft version and use context.idempotencyKey in the
      // outbound operation ledger. Never send an edited/replaced draft silently.
      // Once transport acceptance is known: context.markAccepted().
      return {status: 'accepted'};
    },
    provider_sync: async (payload, context) => {
      // Persist the provider cursor only with successfully imported records.
      // Schedule the next poll with a fresh deterministic occurrence ID.
      return {status: 'completed'};
    }
  }
});
scheduler.start();
```

The example callbacks illustrate contracts; real membership checks and transport work belong to the standalone server and provider service. `authorize` must return `true`, including for read-only access. With no callback, only `user:<signed-in-user-id>` is allowed. User objects use `{userId,email,displayName}`; `id` is also accepted as an identity alias.

`enqueue({id,type,payload,runAt,owner,scope})` persists a job immediately and returns its public representation. Omit `id` for a random identifier. `runAt` accepts epoch milliseconds or a parseable date string. Reusing an identifier for the same payload is idempotent; reusing it for a different owner, workspace, type, or payload fails. Jobs are one-shot; a recurring integration schedules its next occurrence explicitly. `runDue()` scans automation records and claims up to 100 due jobs. `cancel(id,user)` is asynchronous because authorization can be asynchronous.

Handlers receive `(payload, {job,idempotencyKey,markAccepted,signal})`. A handler must return `{status:'completed'}`, `{status:'accepted'}`, or `{status:'unknown'}`. Any other return is treated as unknown. The stable job ID is the idempotency key. Call `markAccepted()` as soon as an external transport has accepted the operation; this synchronously persists the acceptance marker. Honor the abort signal before further side effects if the lease is lost. `emit(scope,event)` carries `record-change`, `job-change`, `notification-change`, and calendar `invitation-change` messages; record changes include `recordId`.

## Delivery guarantees and recovery

Claims use a short `BEGIN IMMEDIATE` SQLite transaction. A claimed job gets a unique worker identity and a lease; a heartbeat extends it during asynchronous work. Another server process sharing the database cannot claim the same pending job. No SQLite transaction stays open while awaiting a transport.

| Status | Meaning and automatic behavior |
| --- | --- |
| `pending` | Waiting for `run_at`; cancellable by the job's owner. |
| `running` | Claimed with a renewable lease; cancellation returns conflict. |
| `completed` | Work finished; terminal. |
| `accepted` | The transport acknowledged acceptance; terminal, not a promise of final recipient delivery. |
| `unknown` | Transport acceptance cannot be established; terminal and never automatically resent. |
| `failed` | A nonretryable error or exhausted retry budget; terminal. |
| `cancelled` | Cancelled before a worker claim; terminal. |

An exception is retried only when it explicitly has `retryable: true`, no acceptance was recorded, and the attempt budget remains. Retry delays are 1, 2, 4, 8 seconds and so on, capped at one hour. Once accepted, a subsequent exception produces `unknown`, even if it is marked retryable. Errors with `accepted`, `unknown`, or `status: 'unknown'` also produce `unknown`.

An expired delivery lease becomes `unknown`: the old process may have reached the mail provider before crashing. This intentionally permits a queued-but-not-delivered operation to need manual review in that crash window, rather than risking duplicate mail. Operators must check the provider's sent folder/operation status before a deliberate new send. Read-oriented `provider_sync` and internal `automation` jobs can recover an expired lease to `pending` when acceptance was not recorded. Other custom job types default to the conservative delivery behavior.

End-to-end exactly-once SMTP delivery cannot be guaranteed after an ambiguous connection failure. The server's outbound operation ledger and provider idempotency support complement, but do not replace, this scheduler policy.

## HTTP endpoints

All authenticated endpoints reject unconfigured foreign `Origin` headers. For a separately hosted frontend, pass the server's configured origin allowlist as scheduler `allowedOrigins`; invitations use `PUBLIC_URL`, `FRONTEND_URL`, and `ALLOWED_ORIGINS`. Access is checked against the current workspace, and job/notification listing is additionally constrained to the signed-in owner. A shared workspace member cannot enumerate or cancel another member's scheduled jobs. Both `handle(request,user)` methods return `null` for paths outside their namespaces so the main router can continue.

| Endpoint | Request and result |
| --- | --- |
| `GET /api/jobs?scope=...` | `{jobs:[...]}`, newest first, up to 200. Defaults to the user's private scope. |
| `POST /api/jobs` | `{type:'send',recordId,version,accountId,runAt}`; `date` and `scheduledAt` are accepted aliases for `runAt`. Returns `{job,record}` with status 201. |
| `DELETE /api/jobs/:id` | Cancels the owner's pending job; returns `{job}`. A running/terminal job returns 409, except already-cancelled requests are idempotent. |
| `GET /api/notifications?scope=...` | `{notifications:[...]}`, newest first, up to 200. |
| `PATCH /api/notifications/:id` | `{read:true}` marks read; `{read:false}` marks unread. `/api/notifications` also accepts `{id,read}`. |

Scheduling requires a current draft/outbox record and an exact record version. The requested date must be in the future and within one year. `authorize` receives action `schedule-send` with `accountId` and `version`, so invalid or unauthorized provider accounts are rejected before changing the draft. The record and job are written in one transaction: the draft moves to outbox with `scheduledAt` and `scheduledJobId`, its version increments, and the job captures that new version. Another pending, running, or unknown send for the same record is rejected.

The send handler receives `{recordId,version,accountId,user}` and must recheck current authority and the exact version before sending. Cancelling a matching, unchanged outbox record atomically restores it to drafts and clears its schedule. A concurrently edited record is preserved.

## Record automations

Each poll scans active `message`, `rule`, `task`, `event`, and `settings` records in a short SQLite transaction. Changes increment record versions and broadcast only after commit. Automation state, generated records, and notifications survive restart.

* Inbox rules use the existing `{field:'from'|'subject',contains,target}` format. Matching is case insensitive. Supported targets are `read`, `flag`, `archive`, `deleted`, `junk`, and `custom:<folder-id>`. Set `enabled:false` to disable a rule. Rules apply in stable rule-ID order only to eligible inbox mail in the same scope. A durable rule-set fingerprint per message prevents repeatedly undoing later user changes; creating or editing rules makes eligible mail reevaluate.
* `snoozedUntil` (or `snoozeUntil`) returns elapsed snoozes to inbox. Deleted, junk, sent, draft, and outbox messages are not resurrected. The snooze value clears after return.
* A due `reminder` on an unfinished task or an event creates one durable owner notification per record/reminder value. Editing the reminder creates a distinct future occurrence. Notifications are available next time the browser opens; this module does not claim browser push or operating-system notifications while the browser is closed.
* My Day uses task `timezone`, then the owner's settings `timezone`, then UTC. Store `myDayDate:'YYYY-MM-DD'` when selecting a task for My Day. Legacy records fall back to the local date of `updated`. On a later local day, `myDay` resets without deleting the task.
* Completing a task with `repeat:'daily'|'weekly'|'monthly'` and a `due` date creates exactly one next task. The old completed task remains in history. The new task clears completion/My Day, resets steps, and shifts its reminder by the due-date change. Monthly dates clamp to the last day of a shorter month; an inclusive `until` stops future creation. This is completion-driven recurrence, not a backlog of every elapsed occurrence.

A large mailbox may warrant moving the full record scan to a indexed incremental queue; the current implementation prioritizes durable correctness for a single workspace server.

## Calendar invitation integration

`backend/invitations.js` exports `InvitationService`, `calendarIcs`, and `calendarMime`. Construct the service with `{db,scheduler,deliver,env,authorize,resolveAccount,emit}` and call `migrate()` before serving requests. The service registers `invitation-delivery` and `invitation-reply` handlers on the supplied scheduler. `env.PUBLIC_URL` should be the canonical HTTPS origin used in email response links; HTTP is allowed only on localhost. If omitted, the current request URL supplies the origin. Optional `resolveAccount({user,accountId,scope})` must validate current provider-account ownership and return `{id,email}`; this makes the selected sending account the ICS organizer. Without it the signed-in user's email is used. Once invitations exist, their organizer address is immutable.

`deliver({user,accountId,to,subject,text,calendar,raw,idempotencyKey,signal,markAccepted})` sends through the organizer's authorized account and returns the same explicit acceptance statuses as any scheduler handler. `raw` is a complete MIME message; `calendar` is its ICS content. The root server must forward this MIME intact to the mail provider, validate current account ownership, and use the idempotency key. No messages are sent by tests; injected delivery fakes inspect the payloads locally.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/invitations` | `{eventId,version,accountId,method:'REQUEST'}` queues one invitation per attendee. `method:'CANCEL'` (or `action:'cancel'`) queues a cancellation for existing invitees. Returns 202 and the invitation summary. |
| `GET /api/invitations?eventId=...` | Returns UID, revision sequence, organizer, and attendee response states after workspace authorization. |
| `POST /api/invitations/:id/respond` | `{response:'accepted'|'tentative'|'declined'}`; requires a signed-in workspace attendee whose account email exactly matches the invitee. |
| `GET /api/invitations/respond/:token` | Renders a confirmation form only. Opening, previewing, or scanning the link does not mutate state or send a reply. `/invitations/respond/:token` is an alias. |
| `POST /api/invitations/respond/:token` | Requires an explicit `application/x-www-form-urlencoded` form submission with `response`. Records the attendee response and queues a reply. JSON is rejected. |

Only the event owner and original organizer can send or cancel invitations, even when other workspace members can edit the event. An exact event version is required and checked again inside the write transaction. Send a cancellation before deleting the event. The server creates the stable UID; later authorized revisions preserve it and increment `SEQUENCE`. Repeating the same version/method request is idempotent. Revising the attendee list sends CANCEL to removed guests and REQUEST to current guests. Superseded queued invitation jobs complete without delivery.

The MIME message is `multipart/alternative` with base64 plain text and inline `text/calendar; method=REQUEST|CANCEL|REPLY`. ICS uses CRLF, UTF-8-safe 75-octet line folding, escaped text, `ORGANIZER`, and attendee `PARTSTAT`; CANCEL uses `STATUS:CANCELLED`. All-day dates are exclusive-end calendar dates in the event timezone. Timed invitations use UTC DTSTART/DTEND, including recurrence rules; thus recurring invitations use fixed UTC times across daylight-saving transitions. The interactive calendar's local-time recurrence model may differ and should be reviewed when inviting guests to a series crossing a DST transition.

RSVP tokens are 32 cryptographically random bytes. They are generated in memory immediately before delivery; only their SHA-256 hashes and a 90-day expiry are persisted. Neither the invitation table nor queued job payload stores a plaintext bearer token. A safe pre-acceptance retry rotates the token; an ambiguous send remains unknown and retains the last token. Updating/cancelling invitations invalidates old tokens.

A token authorizes a response for its associated attendee; it does not authenticate the human holding the link. Confirmation pages state the attendee address, escape event content, set `no-store` and `no-referrer`, prohibit embedding, and permit forms only to their own origin. The first response is authoritative for that invitation revision. Repeating the same response is idempotent; changing a used response returns 409. A new organizer revision creates a fresh response opportunity.

Responses persist both the attendee `PARTSTAT` and the event's `attendeeStatuses`, create an organizer notification, and queue an ICS REPLY. The reply notification is sent from the organizer's authenticated account to the organizer, with the responding attendee identified in ICS and body text; the service does not impersonate a guest's mailbox. Link-based responses are described as link-confirmed, while workspace responses are described as signed-in attendee responses.

## Verification

Run `node --test tests/jobs.test.mjs tests/invitations.test.mjs` with Node 24. Tests use temporary local SQLite databases and injected fake transports. Scheduler coverage includes disk restart, competing connections, acceptance/crash ambiguity, retry budgets, authorization, cancellation/version consistency, rules, snooze, reminder deduplication, timezone midnight, and recurring tasks. Calendar coverage exercises MIME/ICS identity, organizer/attendee access, explicit form confirmation, token hashing/idempotency/expiry, revisions and cancellation.
