# Mailbox reconciliation and delegated Exchange mail

Avenor reconciles IMAP mail across every selectable folder, retains a crash-durable synchronization batch until the application acknowledges durable ingestion, and connects explicitly verified Microsoft delegated mailboxes. The implementation is plain JavaScript in `backend/providers` and is used by the connected backend; GitHub Pages does not run mail-server connections.

## IMAP reconciliation

Each complete pass lists selectable mailboxes, obtains a UID membership snapshot under a read-only mailbox lock, and scans bounded pages. Membership comes from UID SEARCH ALL, not message sequence numbers or an inferred last-UID count. `\\Noselect` and `\\NonExistent` folders are excluded. A failed list/select/search aborts the batch and cannot be mistaken for a deletion.

INBOX and the actual server-advertised special-use flags map to the standard Avenor folders. Other folders use `imap:<base64url UTF-8 path>` and retain the original path as `providerMailbox`. Localized names are never guessed for a move or deletion.

The version-three cursor contains known message identities, content fingerprints, flags, mailbox membership, and the current page position. New messages fetch MIME and attachments; known messages fetch flags only. Changed read, flag, and marked-for-deletion values emit metadata updates. Expunges and removed folders emit tombstones after completing the membership pass. UIDVALIDITY changes replace stale UID identities and reconcile their old records. A folder rename/deletion or UIDVALIDITY change during pagination restarts the membership pass safely.

An exact SHA-256 MIME match can preserve the local record ID when exactly one earlier location is known absent from the complete membership snapshot. Identical live copies remain separate records. Multiple matching removed messages are ambiguous and are not merged. This is a conservative reconciliation rule: standard IMAP does not supply a universal move identity across folders. Application-initiated moves additionally retain their exact UIDPLUS source/destination mapping and aliases. Server changes that rewrite MIME may appear as a removal plus a new local record, while the final mailbox contents remain reconciled.

The defaults are 100 examined UIDs per page, 25 MiB per MIME item, 50 MiB per batch, 250,000 UID memberships per complete pass, 25 mailbox membership queries per snapshot-building page, and 1,000 selectable folders. `PROVIDER_SYNC_LIMIT`, `PROVIDER_MESSAGE_MAX_BYTES`, `PROVIDER_SYNC_MAX_BYTES`, `PROVIDER_IMAP_MAX_UIDS`, and `PROVIDER_IMAP_FOLDER_BATCH_LIMIT` adjust the respective limits. Exceeding a bound fails explicitly; it does not silently skip mail or advance a checkpoint. Membership snapshots and the encrypted cursor consume memory and storage proportional to mailbox size. This is a bounded polling reconciler, not an assertion of unlimited mailbox capacity or constant-memory QRESYNC.

`syncAccount(user, accountId)` returns normalized messages carrying a non-enumerable `batchId`. Repeating synchronization, including after a service restart, returns the existing encrypted pending batch. Only `acknowledgeSync(user, accountId, batchId)` advances the stored cursor. The caller must first durably apply the records and attachments. Metadata-only messages require merging existing data and retaining attachment references. Move aliases and batch staging share one database savepoint.

### Writeback

Read and flagged changes use UID-scoped flag add/remove commands, preserving unrelated flags. Standard folder moves require one exact advertised destination; custom moves require the exact path to be present in LIST. MOVE and UIDPLUS are both required. Avenor does not fall back to COPY plus global EXPUNGE. If the server cannot confirm destination UID mapping, the operation is recorded as uncertain and is not automatically retried. A stale UIDVALIDITY or vanished source is rejected until reconciliation runs.

## Microsoft delegated/shared mailboxes

Microsoft Graph does not provide an API that enumerates every mailbox for which a signed-in user has mailbox permissions. Avenor therefore provides two explicit, functional entry points:

- `GET /api/accounts/:primaryAccountId/shared-mailboxes?q=te` searches up to ten directory candidates and probes actual inbox access before returning a candidate as accessible. This is directory search followed by access verification, not a complete mailbox-permission inventory. If more matches exist, narrow the query.
- `POST /api/accounts/:primaryAccountId/shared-mailboxes` with `{ "email": "team@example.com" }` attaches a known address after verifying accessible mail folders. With directory scope, `{ "mailboxId": "directory-object-id" }` is also accepted and the mailbox's canonical mail address is obtained from Microsoft.

Microsoft connections need delegated `Mail.Read.Shared` or `Mail.ReadWrite.Shared`; changing shared messages requires `Mail.ReadWrite.Shared`, and submitting as another mailbox requires `Mail.Send.Shared`. Optional `User.ReadBasic.All` (or an appropriate broader granted directory scope) enables directory search. Without it, known-address attachment continues to work and the application does not query the directory.

Attached mailboxes have their own account IDs, cursors, batches, local record identities, and pending-operation keys. Their token comes from the selected primary account, and a continuation URL cannot leave the attached mailbox path. The parent token is refreshed through the usual encrypted-token flow. Disconnecting the primary account atomically disconnects its attached children.

Read access does not establish Send As or Send on Behalf permission. Microsoft enforces those Exchange permissions on submission. Avenor reports provider acceptance only after Microsoft accepts the actual request; discovery never sends a test email. Sending through `/users/{mailbox}/sendMail` additionally requires the Exchange Full Access grant documented by Microsoft. The UI and API identify send authorization as checked at submission.

The attached mailbox initially syncs the standard folders verified at attachment. Attach the mailbox again to refresh its folder grants after an administrator changes access. Directory candidate access probes and provider HTTP responses are the authority; arbitrary addresses are never silently treated as connected shared mailboxes.

## Multiple backend nodes

Provider operations acquire database-backed, renewing leases. Mailbox state operations are serialized by account ID, and credential refresh has a separate parent-account lease. A suspended or expired owner cannot renew or release its successor's lease and cannot commit a provider result after discovering that it lost ownership. Remote requests are bounded by the provider HTTP timeout. Contention produces an explicit retryable busy result; uncertain external writes preserve their persistent unknown outcome and are never retried automatically.

Account disconnect waits for active operations on the parent and attached children. Calendar/contact `cloudRequest` uses the same mailbox lease as mail operations. All instances must use the same authoritative database. These locks coordinate account operations; they do not establish external-provider exactly-once delivery, since SMTP and HTTP submission services do not universally support distributed fencing.

`tests/providers-leases.test.mjs` exercises separate SQLite connections and provider instances for refresh rotation, write order, send deduplication, expired-owner fencing, contention, and disconnect during an active send.

## Scheduling MIME

IMAP and cloud MIME parsers preserve `internetMessageId` and `calendarParts: [{ content, method }]`. The inbound scheduling service independently parses and validates these parts. The mail adapters do not infer an authenticated sender from a supplied `Authentication-Results` header or claim that an invitation is trusted merely because it arrived in a mailbox.

## Verification and provider setup

`tests/providers-reconciliation.test.mjs` checks custom/standard folder imports, flag updates without body downloads, expunges, external moves versus copies, ambiguous identity, UIDVALIDITY resets, restartable pagination, oversized-item refusal, failed-membership preservation, persistent batches/aliases, and custom-folder writeback. `tests/providers-shared.test.mjs` checks granted-scope discovery, denied-candidate filtering, explicit attachment, account isolation, inherited tokens, sender canonicalization and mailbox routing, sync/writeback, parent disconnection, and service URL allowlists. These are deterministic protocol and HTTP fixture tests; they do not stand in for validation against a production Exchange tenant or an arbitrary IMAP server.

Provider credentials, consent, TLS-valid IMAP/SMTP infrastructure, and actual mailbox permissions must be configured as described in [PROVIDERS.md](PROVIDERS.md).

## Primary references

- [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/): UID search/fetch, mailbox locks, LIST, MOVE, UIDVALIDITY, and TLS configuration.
- [Microsoft: shared and delegated folders](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders): shared-read/write permissions and user-targeted mailbox paths.
- [Microsoft: send from another user](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user): Send As, Send on Behalf, Full Access, and the absence of a complete mailbox-permission discovery API.
