# Provider calendars and contacts

Avenor's connected backend synchronizes Microsoft Graph calendars/contacts and Google Calendar/People contacts into the same durable records used by its calendar and contacts views. SMTP/IMAP accounts do not expose a calendar or contact API.

## Authorization

Reconnect an existing cloud account after upgrading to grant the additional scopes. Microsoft requires `Calendars.ReadWrite` and `Contacts.ReadWrite`. Shared Microsoft mailboxes additionally require the corresponding `Calendars.ReadWrite.Shared` and `Contacts.ReadWrite.Shared` delegated scopes and actual Exchange permissions. Google requires `calendar.events`, `calendar.calendarlist.readonly`, and `contacts` (full `https://www.googleapis.com/auth/` prefixes). Enable the Google Calendar and People APIs in the OAuth application's cloud project.

An OAuth grant is not proof that a particular shared mailbox or calendar is writable. Provider permissions remain authoritative; Avenor also disables writes to calendar collections the provider reports as read-only. No live account credentials or externally delivered messages are used by the automated test suite.

## Synchronization semantics

The `PimService` has an explicit persistence contract:

```js
const pim = new PimService({ db, providers, env, emit });
pim.migrate();
const records = await pim.syncAccount(user, accountId);
await persistRecordsInTransaction(records);
pim.acknowledgeSync(user, accountId, records.batchId);
```

Every result has non-enumerable `batchId` and `collections` properties. The backend must apply all records/tombstones durably before acknowledging the batch. Records have `kind`, `id`, `accountId`, `provider`, `providerId`, `collectionId`, provider `etag`, normalized application fields, and their `providerRaw` data. A tombstone has `deleted: true`. Acknowledgment commits the next cursor and removes the pending batch in one SQLite savepoint.

Cursors, inventories, pending changes, and batches are encrypted with the configured `DATA_KEY`. A crash between fetch and acknowledgment replays the same batch, even after a new process opens the database. Account-level database leases prevent two workers from independently advancing synchronization or submitting a change concurrently. A failed or incomplete page never advances a cursor or treats unseen items as deleted. `PIM_MAX_PAGES` defaults to 10,000 pages; exceeding it fails the round explicitly rather than truncating results.

| Provider surface | Implementation |
| --- | --- |
| Microsoft calendars | Enumerates every accessible calendar. The primary calendar's Graph delta view detects changes; a complete, paginated series-master inventory is fetched on changes and periodically. Other calendars use complete paginated inventories each round. |
| Microsoft event coverage | Complete event/master enumeration has no date filter. Primary delta change detection covers a moving five-calendar-year window; `PIM_FULL_RECONCILE_MS` defaults to one day so changes outside that detection window are eventually reconciled too. The window rolls over each year. |
| Microsoft recurrence exceptions | Retrieves each series master's `cancelledOccurrences` and expanded `exceptionOccurrences`, follows expanded collection pagination, and retrieves complete exception records. Original occurrence IDs, exclusion dates, recurrence patterns/ranges, and exception original starts are retained. |
| Microsoft contacts | Reconciles the default Contacts collection completely; recursively enumerates contact folders and synchronizes each child folder using its own delta link. Missing folders and records produce tombstones. |
| Google calendars | Enumerates the subscribed calendar list, including hidden calendars. Each calendar keeps its own incremental sync token. Events are enumerated with `singleEvents=false`, preserving recurring masters and exceptions without an artificial date cutoff. |
| Google contacts | Uses the People connections API restricted to contact sources, with a persistent sync token, source etags, and complete page traversal. |
| Expired cursors | Microsoft 404/410 delta expiration and Google 410 token expiration trigger a fresh full round. The previous inventory remains intact until a complete replacement batch is acknowledged. |

Microsoft Graph v1.0's documented event delta endpoint is a primary-calendar **date-range view**, so it is paired with complete inventory sweeps rather than treated as an unbounded all-calendar delta API. This follows the [Graph event delta contract](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0). Contact folder tokens follow the [Graph contact delta contract](https://learn.microsoft.com/en-us/graph/api/contact-delta?view=graph-rest-1.0). Google incremental requests preserve the original pagination parameters and reset expired tokens as specified in the [Calendar synchronization guide](https://developers.google.com/workspace/calendar/api/guides/sync) and [People connections API](https://developers.google.com/people/api/rest/v1/people.connections/list).

## Writes and conflicts

```js
const saved = await pim.writeRecord({
  user, accountId, kind: 'event', method: 'update',
  record: { ...currentProviderRecord, title: 'Revised planning meeting' },
  idempotencyKey: operationId
});
```

`method` is `create`, `update`, or `delete`. Existing records require a provider etag; Google contacts also require `sourceEtags`, because People contact update concurrency uses `metadata.sources[].etag`. Conditional writes use `If-Match` and provider source versions. A precondition failure becomes an HTTP 409 conflict; it never overwrites the remote version automatically. Google contact writes follow the required field-mask/source-etag and sequential mutation semantics in [people.updateContact](https://developers.google.com/people/api/rest/v1/people/updateContact).

The same operation key with the same payload replays its accepted result without resubmission. Reusing the key with another payload is rejected. Graph event creates include a stable `transactionId`; Google event creates include a stable client-generated event ID. Non-idempotent contact creation or another operation whose response is uncertain is recorded as uncertain and is not blindly repeated.

Avenor preserves the original local record ID when publishing an existing event/contact. Its encrypted provider-ID alias map prevents the next provider sync from creating a duplicate local record. Names, multivalue email/phone fields, organizations, notes, addresses, birthdays, favorites, event time zones, all-day dates, recurrence definitions, attendee details, and original provider data are retained. Unchanged HTML descriptions and recurrence definitions survive ordinary title edits. Calendar changes can cause the provider to send invitations or updates; Google requests explicitly use `sendUpdates=all`.

People synchronization can lag behind an accepted mutation. Avenor keeps the accepted version until synchronization observes that version. A conflicting version still present after two minutes appears in `status().conflicts` instead of silently replacing the accepted edit. `resolveConflict({ user, accountId, recordId, resolution: 'remote', idempotencyKey, expectedRemoteEtag: conflict.remoteVersion })` accepts the reviewed provider version; `resolution: 'local'` conditionally reapplies the local record using the reviewed remote etag and a new stable operation key. The caller supplies the `remoteVersion` reviewed in the conflict dialog and durably ingests the returned record. If that reviewed version changed meanwhile, resolution is rejected for a fresh review; records without a provider etag use a content fingerprint. This also gives users a review path for concurrent edits from a provider's native client.

## Verification and operational limits

`tests/pim.test.mjs` covers actual SQLite restart/replay, account leases, full page traversal, cursor expiration, tombstones, folder removal, record aliases, conditional writes, ambiguous delivery, propagation conflicts, recurrence metadata/exceptions, and all-day dates across daylight-saving transitions. Provider requests use deterministic mocks; deployment must still be exercised against the organization's authorized accounts and provider quotas.

The complete master/contact inventories do not imply an Exchange server replacement. Provider-side calendar sharing administration, resource booking policy, every provider extension/attachment type, and enterprise directory policy remain provider services. The application retains complete provider recurrence definitions; the view layer must use them when expanding display occurrences. Provider-specific Windows timezone identifiers are retained, and unchanged Graph all-day events preserve their original provider date representation. An edited time should be supplied with an IANA timezone by the client.
