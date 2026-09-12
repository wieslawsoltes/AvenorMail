# External mail providers

Avenor's native Node 24 backend connects real Microsoft, Google, and SMTP/IMAP mailboxes. A connected account can submit outgoing MIME mail and import received content and attachment bytes. Provider acceptance is reported as `accepted`; it is not a delivery receipt or a guarantee that recipients received the message.

The subsystem uses native `node:sqlite` `DatabaseSync`, `nodemailer`, `imapflow`, and `mailparser`. It has no dependency on the former Site runtime.

## Server environment

| Variable | Required for | Value |
| --- | --- | --- |
| `DATA_KEY` | All connected mail | A cryptographically random 32-byte key, encoded as standard base64. Keep it stable and back it up separately from the database. |
| `PUBLIC_URL` | OAuth | The backend's public HTTPS origin, for example `https://mail.example.com`. HTTP is accepted only for localhost development. |
| `FRONTEND_URL` | OAuth callback destination | The trusted application URL, for example `https://app.example.com`. Defaults to `PUBLIC_URL`. |
| `MICROSOFT_CLIENT_ID` | Microsoft | Application/client ID from Microsoft Entra app registration. |
| `MICROSOFT_CLIENT_SECRET` | Microsoft | A server-side confidential web application secret. |
| `MICROSOFT_TENANT` | Microsoft, optional | `common` by default; an organization tenant ID/domain, `organizations`, or `consumers` may restrict account selection. |
| `GOOGLE_CLIENT_ID` | Google | OAuth client ID for a Web application. |
| `GOOGLE_CLIENT_SECRET` | Google | The Web application's client secret. |
| `PROVIDER_SYNC_LIMIT` | Optional | Default `100`. Cloud sync bounds the requested page size to 6–500, distributing the Microsoft page budget over six standard folders. IMAP uses this as its maximum messages per batch. |
| `PROVIDER_MESSAGE_MAX_BYTES` | Optional, IMAP | Default `26214400` (25 MiB) per raw message. Cloud and outgoing MIME limits are fixed at 25 MiB. |
| `PROVIDER_SYNC_MAX_BYTES` | Optional, IMAP | Default `52428800` (50 MiB) per import batch. |
| `ALLOW_PRIVATE_MAIL_HOSTS` | Development/private mail systems only | Defaults to disabled. Only the exact string `true` permits private, loopback, internal, or reserved SMTP/IMAP destinations. It never disables TLS certificate verification. |

Generate `DATA_KEY` once with a trusted local command and place it in the server's secret configuration:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

Do not commit actual values. Losing or changing this key without migration makes previously stored connected accounts unreadable. There is no automatic encryption-key rotation command; restore the original key or reconnect accounts after deliberate rotation. Back up the SQLite database and key together, keeping separate access controls. Credential ciphertext uses AES-256-GCM with fresh random nonces and authenticated account/owner context. OAuth PKCE verifiers and pending synchronization content are also encrypted. Public account routes never expose credentials or tokens.

If configuration is missing, `GET /api/accounts` remains available and returns per-provider `configured: false` and a safe setup reason. Starting an unconfigured OAuth flow returns a `503` setup error.

## Microsoft setup

1. Register a Microsoft Entra application. Choose supported account types appropriate to your deployment and set `MICROSOFT_TENANT` consistently.
2. Add a **Web** redirect URI exactly matching `PUBLIC_URL` plus `/api/oauth/microsoft/callback`. For example: `https://mail.example.com/api/oauth/microsoft/callback`.
3. Add Microsoft Graph **delegated** permissions `User.Read`, `Mail.ReadWrite`, and `Mail.Send`. The request also asks for `offline_access`, allowing refresh tokens. Apply tenant/admin consent where your organization's policy requires it. Previously connected accounts granted only `Mail.Read` must reconnect before writeback is available.
4. Create a client secret and configure `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the server. Restart it, sign in to Avenor, and select Microsoft when adding an account.

The server uses authorization code flow with an S256 PKCE challenge, retrieves the actual mailbox identity from Graph `/me`, and sends MIME through Graph `/me/sendMail`. A `202` response means Graph accepted the request, not that delivery finished. Implementation references: [authorization code and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), and [message delta query](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0).

## Google setup

1. Create a Google Cloud project and enable the Gmail API.
2. Configure the OAuth consent screen/audience and add the required testing users while the application is in testing.
3. Create an OAuth client of type **Web application** and register exactly `PUBLIC_URL` plus `/api/oauth/google/callback`, for example `https://mail.example.com/api/oauth/google/callback`.
4. Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server and restart it.
5. Grant `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send` when connecting. Previously connected accounts granted only `gmail.readonly` must reconnect before writeback is available. The application requests offline access with consent and an S256 PKCE challenge. Use Google's applicable production verification process before making a public application available to a broad audience; Gmail scopes can require additional review.

The mailbox address comes from Gmail `users.getProfile`, not an email supplied by the browser. The callback requires an offline refresh token; if a previous consent prevents issuance, revoke the app grant in Google account settings and reconnect. Send requests use base64url-encoded MIME. Implementation references: [server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync), [Gmail profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), and [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).

## SMTP and IMAP setup

Supply both outgoing and incoming server settings. Passwords may be ordinary provider-supported passwords or provider-issued app passwords. Providers that disable password-based IMAP/SMTP must use their OAuth connection above, or a separately supported authenticated relay.

```json
{
  "provider": "smtp",
  "email": "person@example.com",
  "displayName": "Person",
  "smtp": {
    "host": "smtp.example.com",
    "port": 465,
    "secure": true,
    "user": "person@example.com",
    "password": "app-password-from-your-provider"
  },
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "user": "person@example.com",
    "password": "app-password-from-your-provider"
  }
}
```

The defaults are SMTP port 465 and IMAP port 993 using implicit TLS; usernames default to the mailbox email. Port 587 for SMTP and port 143 for IMAP normally use `secure: false`, which in this implementation means **mandatory STARTTLS**. Plaintext authentication is never allowed. Implicit TLS default ports reject `secure: false`. Certificate verification is always enabled.

Configuration storage validates syntax but does not authenticate the server immediately. First sync/send validates the connection and credentials. SMTP server address authorization is independent of Avenor: the SMTP server decides whether the authenticated user can send from the supplied mailbox address.

The connection resolver rejects private and reserved destinations by default, then pins a validated IP while preserving the original hostname for certificate checks. User-provided proxy, TLS override, transport, and certificate bypass options are discarded. SMTP errors are sanitized so remote error bodies cannot leak passwords. Protocol references: [Nodemailer SMTP](https://nodemailer.com/smtp), [ImapFlow](https://imapflow.com/docs/api/imapflow-client/), and [MailParser](https://nodemailer.com/extras/mailparser).

## HTTP routes

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /api/accounts` | Signed-in session | `{accounts, providers}` with public metadata and configuration status. |
| `POST /api/accounts` | Signed-in session and SMTP/IMAP JSON shown above | `201 {account}`. Reconnecting the same owner/provider/email replaces encrypted credentials. |
| `DELETE /api/accounts/:id` | Signed-in owner | `{ok:true}`. Removes the local connection and pending sync data; imported mail and provider-side consent are not automatically deleted. |
| `POST /api/accounts/:id/sync` | Signed-in owner | The backend should intercept this route to ingest the `syncAccount` batch, acknowledge it, and return its own safe record response. The raw subsystem handler returns `{messages,count,batchId,requiresAcknowledgement:true}` with attachment `bytesBase64`. |
| `GET` or `POST /api/oauth/microsoft/start` | Signed-in session | `{url}`; navigate the browser to it. |
| `GET` or `POST /api/oauth/google/start` | Signed-in session | `{url}`; navigate the browser to it. |
| `GET /api/oauth/:provider/callback` | Provider authorization response | `303` to trusted `FRONTEND_URL` with `mailConnected=google` or `microsoft`. |

OAuth callback state expires after ten minutes and is consumed once, before any token exchange. The state is tied to the user that started authorization; the callback may run without a current session. If a current session belongs to another user, it is rejected. The callback cannot accept a client-supplied owner or account identity. State and codes must not appear in request access logs.

Unrecognized routes return `null` to the main backend router. Known-route failures throw an `Error` with a safe message and `.status`; provider details use sanitized `.code`, and API errors may retain numeric `.providerStatus` for retry decisions. The main backend remains responsible for authentication, CSRF policy, HTTP error handling, request throttling, and limiting the number of connected accounts per user.

## Backend integration and durability

```js
import { ProviderService } from './providers/index.js';

const providers = new ProviderService({ db, env, emit: (owner, event) => notifyUser(owner, event) });
providers.migrate(); // Synchronous and idempotent; tables use the provider_ prefix.

const accounts = providers.listAccounts(user);
const messages = await providers.syncAccount(user, accountId);
// Persist/upsert each stable message id and its attachment bytes transactionally.
// A deleted:true item is a provider tombstone and has no body/attachments.
await persistImportedMessages(user, messages);
providers.acknowledgeSync(user, accountId, messages.batchId);

const result = await providers.sendMail({
  user, accountId, message, mime: resolvedMimeBytes,
  idempotencyKey: 'stable-draft-id-and-reviewed-version'
});
// result.status === 'accepted'; never present it as confirmed recipient delivery.
```

`user` is `{userId,email,displayName}`. Normalized incoming messages contain `id`, `providerId`, `accountId`, `provider`, `from`, `name`, `to`, `cc`, `bcc`, `subject`, `body`, `date`, `folder`, `read`, and `attachments: [{name,type,bytes: Uint8Array}]`. Attachments must be persisted with the message. `messages.batchId` is a non-enumerable array property. Repeated sync calls return the same encrypted pending batch until `acknowledgeSync` commits its cursor. A crash during ingestion therefore replays stable IDs instead of losing mail. Pass the exact batch ID to protect against acknowledging a different batch. Notifications are best effort; import acknowledgement does not depend on an active client connection.

## Provider message writeback

```js
const result = await providers.updateMessage(
  user, accountId, originalProviderId,
  { read: true, flagged: false, folder: 'archive' },
  { idempotencyKey: 'mutation-record-id-reviewed-version' }
);
// {status:'applied', providerId, ...appliedPatch}
// Keep the local record.id. Update its providerId only after confirmed success.
```

Only the explicit fields `read`, `flagged`, and `folder` are accepted. Unknown fields, custom folders, and invalid values are rejected. Supported destination names are `inbox`, `archive`, `deleted`, `junk`, `drafts`, and `sent`, subject to provider restrictions below. Deletion must be expressed as `folder: 'deleted'`; no permanent deletion endpoint or IMAP expunge is used. Imports include `flagged` state as well as `read`.

| Provider | Flag/read changes | Folder changes |
| --- | --- | --- |
| Microsoft Graph | `PATCH` sets `isRead` and `flag.flagStatus`. | `POST .../move` uses the corresponding standard folder and immutable-ID preference. All six destinations are supported when the mailbox exposes them. |
| Gmail | Adds/removes `UNREAD` and `STARRED`. | A single `messages.modify` request adds/removes `INBOX`, `SPAM`, and `TRASH`; archive removes these location labels. Gmail permits these labels to be manually changed. `DRAFT` and `SENT` cannot be assigned manually, so moves into Drafts/Sent are rejected. Draft messages cannot be mutated through this API. Archiving a message retaining Gmail's `SENT` label is explicitly rejected because Avenor would still classify it as Sent. |
| IMAP | UID-scoped additive/removal operations change only `\\Seen` and `\\Flagged`, preserving unrelated flags. | Selects one destination carrying the server's real special-use flag (`\\Archive`, `\\Trash`, `\\Junk`, `\\Drafts`, `\\Sent`) or INBOX. Ambiguous/missing destinations are rejected. MOVE requires both `MOVE` and `UIDPLUS`; the library's COPY-plus-EXPUNGE fallback is deliberately prohibited. |

The API has its own durable `provider_mutations` ledger. An applied key replays its stored result; reusing it for a different patch is rejected. A pending/unknown outcome is never retried automatically and blocks later mutations for the same resolved message. Errors carry `unknown`, `uncertain`, and `retryable: false` for the scheduler. Flags-plus-move operations can partially succeed; if a later step fails, the whole attempt is marked uncertain and requires reconciliation. A failure confirmed before any mutation is recorded as failed. OAuth scope checks happen before writes and prompt reconnect for older read-only consent.

The root backend must enqueue a durable mutation job as part of committing each imported-record change, including soft deletion, and preserve user operation order per message. Keep the original provider identifier and idempotency key in that job payload for exact replay. Apply returned provider ID changes to the live record without changing its local ID. The subsystem resolves old IDs through `provider_message_aliases` after successful moves, so already queued mutations can safely retain their original reference. It also maps subsequently imported destinations to the original local record and filters known source-folder move tombstones. Do not let an import snapshot overwrite local desired fields while a mutation is pending/running.

IMAP incoming identifiers remain `imap:INBOX:<UIDVALIDITY>:<UID>`. After moving to another mailbox, the returned identifier is `imap:v2:<base64url-UTF8-mailbox-path>:<UIDVALIDITY>:<UID>`. Moving back to INBOX restores the legacy form. UIDVALIDITY changes or missing source messages cause explicit stale-reference errors. A server that moves the message but omits its target UID mapping creates an uncertain outcome; the application must reconcile before further writes.

References: [Graph message update](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [Graph message move](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0), [Gmail message labels](https://developers.google.com/workspace/gmail/api/guides/labels), [Gmail modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), and [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/).

Outgoing mail is rebuilt with the connected account's From identity. `message.to`, `.cc`, and `.bcc` are the recipients; `.subject` and `.body` provide content. If raw `mime` is supplied, its HTML/plain text content and resolved attachment bytes are parsed and retained while trusted message headers are rebuilt. Without raw MIME, `.body` is plain text and attachments must contain real `bytes` or `content`; stored IDs alone are rejected. Google and Microsoft obtain Bcc recipients from their submission MIME and process those headers. SMTP sends hidden recipients through the explicit envelope and removes Bcc from the transmitted message headers.

Calendar MIME preserves one `text/calendar` part through Nodemailer's `icalEvent` support, retaining its inline multipart alternative and downloadable calendar copy. `REQUEST`, `CANCEL`, `REPLY`, and `PUBLISH` methods must match the calendar's `METHOD` property; conflicting methods are rejected. Calendar content participates in the idempotency fingerprint, including UID and SEQUENCE changes. The invitation service should select the connected mailbox email as organizer before building its calendar. See [Nodemailer calendar events](https://nodemailer.com/message/calendar-events).

Every send requires an 8–200 character stable idempotency key. Its normalized content fingerprint is stored before the provider operation. Repeating an accepted attempt returns its cached receipt. Reusing that key for different content is rejected. A timeout or uncertain provider result is never automatically retried: inspect the provider's Sent folder before explicitly creating another attempt. Unknown errors carry `.unknown: true` and `.uncertain: true` for scheduler/UI classification; a known accepted submission whose local receipt could not be saved also carries `.accepted: true`. A crash after provider acceptance but before storing the receipt intentionally has an unknown outcome. SMTP partial acceptance returns `accepted` and `rejected` recipient arrays; show those results and do not blindly retry all recipients. The app should retain the draft and present the uncertainty clearly.

## Current operational limits

- Microsoft imports six standard folders: Inbox, Sent Items, Drafts, Deleted Items, Junk Email, and Archive. It keeps an independent paginated delta cursor per folder and uses immutable message IDs. Custom folders and shared/delegated mailboxes are not enumerated. Folder moves may be reflected over multiple batches when the destination page has not yet been fetched.
- Google imports the mailbox using paginated message listing, then consumes history changes, including labels and removals. Labels are mapped to Avenor's primary folders; arbitrary labels are not represented as separate folders. Expired history triggers a full import. Full-import recovery does not reconcile previously cached messages that disappeared before the new history boundary.
- IMAP imports INBOX only, in ascending UID order, resetting its cursor on a UIDVALIDITY change. It imports new messages incrementally but does not propagate later flag changes, expunges, or moves for already imported UIDs. A changed UIDVALIDITY can leave old imported local records until an application-level reconciliation is performed. SMTP sends are not appended to IMAP Sent automatically; providers that do not save submitted mail rely on Avenor's own sent record.
- Sync is pulled by the backend/UI; there are no Microsoft subscriptions, Gmail Pub/Sub watches, IMAP IDLE daemon, or automatic scheduled polling in this subsystem. Continue syncing until provider pagination finishes when importing a large mailbox.
- Imported read/flag/folder changes can be written back through `updateMessage` when the root backend has durably queued them. Body edits, new provider draft creation, arbitrary custom-folder moves, provider folder creation, and permanent deletion are outside this mutation API. IMAP changes made outside Avenor to already imported UIDs are not automatically discovered by its new-message-only importer.
- Incoming HTML is converted to plain text and attachment bytes are retained. The subsystem does not implement an HTML renderer, remote-image loading, S/MIME decryption/signing, PGP, delivery-status processing, or spam filtering. Oversized messages cause explicit failures and are not silently skipped.
- Run one backend process against the database. In-process locks coordinate sync/refresh operations; the implementation is not a distributed refresh scheduler. SQLite unique constraints and durable send attempts prevent ordinary duplicate submissions. External providers do not provide an atomic transaction with the local database, so exactly-once delivery cannot be guaranteed.
- Disconnecting removes locally stored account credentials, but does not revoke provider-side OAuth consent. Revoke the app in the provider's account/admin settings when that is required.

## Tests

```sh
node --test tests/providers*.test.mjs
npx eslint backend/providers tests/providers*.test.mjs
```

Tests use mocked OAuth/HTTP services, native in-memory SQLite, protocol stubs, and loopback fake servers. They verify PKCE/state replay prevention, owner isolation, authenticated encryption, token refresh, MIME attachment fidelity, send deduplication and uncertain outcomes, durable sync acknowledgement, Gmail history/pagination, Microsoft deltas, private-host rejection, DNS pinning, and refusal to transmit plaintext credentials when STARTTLS is absent. No test sends external mail. Real credential/consent/provider-policy validation still requires connecting an account in a configured deployment.
