# Native calendar mail

Avenor imports scheduling messages carried by MIME `text/calendar` parts. The Microsoft, Gmail and IMAP adapters preserve those parts during normal mail synchronization. The backend decodes MIME with MailParser, parses iCalendar with `ical.js`, and stores scheduling decisions separately from the original mail. Import does not send a response: an attendee explicitly chooses **Accept**, **Tentative**, or **Decline** before a durable reply job is created.

## Supported operations

| Operation | Behavior |
| --- | --- |
| `REQUEST` | Creates or revises an attendee's event using the same organizer and UID; this method also carries meeting updates. |
| `CANCEL` | Cancels the series or a particular recurrence instance; tombstones stop older requests from recreating the cancelled revision. |
| `REPLY` | Updates an organizer-owned invitation's matching attendee, including instance-specific responses; it does not create a mail reply loop. |
| Recurrence | Retains RRULE, RDATE, EXDATE and detached RECURRENCE-ID revisions. Calendar rendering expands rules with COUNT/INTERVAL/BY* conditions, applies detached moves and cancellations, and handles `RANGE=THISANDFUTURE`. |
| MIME and dates | Decodes base64/quoted-printable MIME, folded Unicode and escaped iCalendar text, date-only events, UTC, IANA timezones and message-local VTIMEZONE definitions. Unknown timezones, invalid dates, ambiguous duplicate properties and conflicting MIME/calendar methods are rejected. |

The revision key includes mailbox account, UID and RECURRENCE-ID. A newer SEQUENCE wins; DTSTAMP breaks ties within the same sequence. An attendee reply must refer to the current outgoing invitation sequence. Replaying either a provider message or an identical calendar revision does not increment the event version or generate another notification. Responses with a newer DTSTAMP can revise an attendee's previous status. These rules follow the sequencing model in [RFC 5546, §2.1.5](https://www.rfc-editor.org/rfc/rfc5546.html#section-2.1.5).

## Sender verification and review

**Logging into a mailbox authenticates mailbox access; it does not authenticate the sender of every message in that mailbox.** Normal Microsoft, Google and IMAP imports therefore enter the calendar review queue unless a server-side delivery integration supplies independent sender authentication. A MIME `From`, `Authentication-Results` or `Received` header never grants authority by itself. A forged reply cannot silently change the organizer's attendee status.

The trusted delivery contract requires an exact authenticated sender, authentication method, provider source and the account ID receiving the message. `dkim` means that the configured verifier has established the exact sender identity and verified the covered message; a passing domain signature alone is insufficient. A trusted REQUEST/CANCEL sender must match ORGANIZER; a REPLY sender must match its single ATTENDEE. A `SENT-BY` parameter alone grants no delegation authority. Explicit owner review can accept an unverified sender, but cannot replace the organizer of an existing UID or give an unrelated attendee permission to modify an invitation. Authentication and authorization are separate considerations in [RFC 6047, §2.2](https://www.rfc-editor.org/rfc/rfc6047.html#section-2.2).

Avenor does not ship a full S/MIME certificate trust and signature-validation service. The delivery contract can receive verified S/MIME results from one. These import and review controls are not a claim of complete RFC 6047 conformance or Exchange meeting-processing parity.

## Backend API

```js
import { InboundCalendarService } from './backend/inbound-calendar.js';

const inbound = new InboundCalendarService({
  db, emit, authorize, scheduler, deliver, resolveAccount,
}).migrate();

await inbound.ingest({
  user,
  accountId: account.id,
  mailboxEmail: account.email,
  messageId: message.providerMessageId,
  recordId: importedMailRecordId,
  calendarParts: message.calendarParts, // [{ content, method? }]
  // rawMime may alternatively contain a Buffer/string of the full MIME message.
  // Omit trust unless the server independently verified the sender.
});
```

`ingest` returns `{ results: [{ id, status, reason?, eventId?, duplicate? }] }`. Outcomes are `applied`, `review`, `duplicate`, `stale`, `rejected`, or `invalid`. Per-part parser failures are durably recorded as invalid; the underlying message remains available. Transport-level MIME/aggregate limits can reject the ingestion call and must be reported by its caller. The caller invokes ingestion after storing the mail and before acknowledging the provider synchronization cursor, so a restart can safely replay work.

The optional trusted object is `{ source: 'provider', verified: true, authenticatedSender, method: 'dkim' | 'smime' | 'provider', provider, accountId }`. This is an internal backend contract and cannot be supplied through the review API.

| Route | Purpose |
| --- | --- |
| `GET /api/calendar/inbound` | List up to 200 pending reviews belonging to the signed-in owner. `?status=all` includes processed messages. |
| `POST /api/calendar/inbound/:id/review` | `{ "decision": "accept" }` applies a reviewed message; `reject` dismisses it. All identity and revision checks still run. |
| `POST /api/calendar/inbound/:id/respond` | `{ "response": "accepted" }`, `tentative`, or `declined` queues a native attendee REPLY for the current accepted REQUEST. |

`deliver` and `resolveAccount` use the same callback contracts as `InvitationService`. A reply must leave through the original attendee account. Its job reloads the event before sending and discards replies superseded by a newer sequence or cancellation. Stable job/provider idempotency keys prevent a double click or retry from silently sending twice. The event distinguishes a queued response from provider acceptance; provider acceptance does not assert delivery into the organizer's inbox.

## Recurrence rendering and limits

`public/calendar-recurrence.js` exports `expandImportedCalendar(event, from, to, options)`. It uses the stored iCalendar component and returns the same occurrence objects as Avenor's native calendar. Detached instances keep their original recurrence identity after being moved. Wall-clock recurrence remains stable through daylight-saving changes. VTIMEZONE definitions are scoped to each event, never registered globally across users.

The module also exports `providerCalendar(event)` and `calendarOccurrences(events, from, to, options)`. The latter combines a calendar's master records with Graph/Google exception records before expansion, so a moved exception replaces its original instance rather than appearing alongside it. Series identity includes account, provider and calendar collection. Cancelled exceptions may omit their actual start/end; their original occurrence identity still suppresses the base instance. A missing master does not hide an independently dated exception.

Microsoft recurrence conversion supports all six Graph pattern types, interval, selected weekdays, week start, ordinal position, numbered/end-date ranges and cancelled-occurrence dates. Absolute monthly/yearly patterns substitute the last valid day of a short month. Google recurrence preserves RRULE, RDATE and EXDATE, including UTC exclusions against a zoned series. Windows timezone IDs map through the bundled Unicode CLDR global mappings in `public/windows-timezones.js`; the Unicode license is retained in `docs/UNICODE-LICENSE.txt`. The provider formats are documented in [Microsoft Graph recurrence patterns](https://learn.microsoft.com/en-us/graph/api/resources/recurrencepattern?view=graph-rest-1.0), [recurrence ranges](https://learn.microsoft.com/en-us/graph/api/resources/recurrencerange?view=graph-rest-1.0), and [Google recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents).

Work is bounded to 10,000 expansion steps and 1,000 returned occurrences by default. The result array has `truncated === true` when the requested work or output limit is reached. Callers must report that condition rather than treat a partial series as exhaustive. Extremely dense or very old unlimited series may need a narrower range or an explicitly raised bounded limit. Browser-visible floating times use the mailbox import timezone, which defaults to UTC. Invalid daylight-saving wall times are rejected rather than assigned an invented instant.

`calendarOccurrences` also exposes `errors: [{ eventId, message }]` for malformed or unsupported individual records while allowing valid events to remain visible. UI callers should display those errors. The optional `createInboundUI` factory in `public/inbound-ui.js` supplies escaped invitation detail views, pending/all filters, explicit apply/reject controls and a separate response form. Loading or opening a message only reads data; response delivery requires form submission.

## Verification and scope

The focused tests exercise MIME decoding, Unicode unfolding, timezone isolation, invalid dates, replay, sequence ordering, fake authentication headers, organizer replacement, account isolation, owner review, native attendee responses, stale queued response suppression, detached recurrence changes and bounded expansion. They run against real SQLite and the production scheduler with a mocked delivery transport. No external mailbox or physical mail-server deliverability was exercised by those tests.

This release processes VEVENT `REQUEST`, `CANCEL` and `REPLY`. Other iTIP methods (`PUBLISH`, `ADD`, `REFRESH`, `COUNTER`, `DECLINECOUNTER`), scheduling VTODO/VJOURNAL, delegated sender approval, S/MIME validation, resource-booking policies, and arbitrary proprietary Exchange meeting extensions remain separate capabilities. Incoming unsupported methods are recorded as invalid with an explicit reason; their content is not silently applied. Calendar value and recurrence interpretation uses [ical.js](https://kewisch.github.io/ical.js/api/) and the [iCalendar specification](https://www.rfc-editor.org/rfc/rfc5545.html).
