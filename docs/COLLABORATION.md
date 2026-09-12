# Live collaboration

Avenor's normal Node server exposes `/api/live` on the same HTTP listener as the API. One authenticated WebSocket carries workspace record events, draft coauthoring, and ephemeral participant/cursor presence. The backend uses `ws`, native SQLite, and Yjs. The browser uses ProseMirror and `y-prosemirror` over a `Y.XmlFragment` named `prosemirror`.

## Behavior and guarantees

- Concurrent character insertions, deletions, and rich text formatting merge through Yjs. Draft bodies are not replaced with whole HTML strings during collaboration.
- The editor supports paragraphs, headings, bold, italic, underline, code, links, blockquotes, lists, hard breaks, and horizontal rules. ProseMirror owns composition/IME handling, document selection, clipboard parsing, and keyboard commands. Remote selections use Yjs relative positions, so they follow concurrent edits. Inline images and arbitrary HTML/styles are excluded from the shared schema; attachments remain separate records.
- Every accepted update is applied to a candidate document, validated, and committed to SQLite before the sender receives an acknowledgment or any peer receives the update. Full snapshots are restored when a room reopens or the process restarts.
- The first authorized writer initializes an empty collaboration document from the existing HTML body. Simultaneous first joins use the single server document, avoiding duplicate initial content. A viewer cannot initialize or modify the stored document.
- Reconnecting editors apply the server snapshot to their existing Yjs document, then upload only missing structures. Edits made during a transient connection loss remain in the open browser document. The client deliberately blocks sending until it has connected and received durable acknowledgments. Unacknowledged edits are not durably stored by this module after closing/reloading the page.
- Presence is ephemeral. The server supplies names and user IDs from authenticated sessions; client-provided names are ignored. Cursor payloads are bounded and checked before forwarding.
- This hub is designed for one active Node process per database. Multiple processes require a shared CRDT/event transport and cross-process document serialization; running independent in-memory rooms against one SQLite file is unsupported.

## Server integration

```js
import { RealtimeHub, collaborationDocumentHTML } from './backend/realtime.js';

const live = new RealtimeHub({
  db, // native node:sqlite DatabaseSync
  authenticate: request => auth.authenticate(request),
  authorize: async ({ user, scope, recordId, action }) => {
    // Check current membership on every invocation.
    // subscribe: scope membership; recordId is undefined.
    // read: record exists in scope and user can read it.
    // write: record is a draft and user may edit it; deny sent/deleted/locked drafts.
    return permissions.check({ user, scope, recordId, action });
  },
  allowedOrigins: [new URL(env.PUBLIC_URL).origin],
  emit: event => telemetry.record(event), // optional non-blocking notification
}).migrate().attach(httpServer);

await live.publish(scope, { type: 'record.updated', recordId });
await live.close();
```

`authenticate` receives an object inheriting from the original Node `IncomingMessage`, with the first frame's token added to `headers.authorization`. It must return `{userId, email?, displayName?}` or null, and must consult session revocation/expiry. `authorize` returns a boolean and must consult current access rather than client claims.

`collaborationDocumentHTML(db, recordId)` returns sanitized HTML from the durable CRDT snapshot, or null if no collaboration document exists. API record reads and send snapshots should use this value as the body when available. An ordinary REST body update must never replace that authoritative document. Non-body fields can continue through the existing versioned record API.

Before sending, the browser must flush pending CRDT writes. The server must atomically lock the draft in its send/outbox transaction; subsequent `authorize(...action: 'write')` calls must reject it. Read the durable body during that transaction to produce a consistent send snapshot. Do not accept a client-supplied body as the final collaborative send body.

The durable table is `collaboration_documents(record_id PRIMARY KEY, scope, state BLOB, revision, updated_at)`. A document's scope cannot change after creation, even if a user belongs to both workspaces. No record body or authentication token appears in collaboration telemetry.

## Browser integration

Bundle `public/collab.js` as an ES module with its npm dependencies. The module exports `LiveClient` and `collaborationSchema`.

```js
const live = new LiveClient({
  getToken: () => sessionToken,
  onChange: (event, scope) => refreshChangedRecord(event, scope),
  onPresence: ({ recordId, participants }) => showParticipants(recordId, participants),
  onStatus: (status, details) => showLiveStatus(status, details),
});
await live.connect();
const unsubscribe = live.subscribe(scope);
const binding = live.attachEditor({
  element: document.querySelector('#compose-editor'),
  recordId: savedDraft.id,
  scope,
  onChange: (html, { remote }) => updateDraftPreview(html, remote),
});
await binding.ready;
binding.format('bold');
binding.format('createLink', 'https://example.com');
const html = await binding.flush(); // all queued updates durably acknowledged
binding(); // detach, restore ordinary sanitized HTML
unsubscribe();
live.close();
```

Save the draft record before attaching its editor. `attachEditor` places a ProseMirror editor inside the supplied element and sets `element.collaboration` to the binding. The outer element's ID remains unchanged. Existing formatting handlers should call `binding.format(command, argument)` and existing body readers should call `binding.getHTML()`. Route formatting/paste inside the ProseMirror child through its own handlers; do not run `document.execCommand` on it. `binding.isReadOnly()` reports current write permission.

The binding is a callable cleanup function with `.ready`, `.flush()`, `.getHTML()`, `.format()`, `.isReadOnly()`, and `.setLocked(boolean)`. Call `.setLocked(true)` before flushing for a send operation to stop local edits to the nested ProseMirror view; changing only the outer element's `contenteditable` attribute is insufficient. Unlock after a recoverable error. Supported format commands match the existing composer: `bold`, `italic`, `underline`, `insertUnorderedList`, `insertOrderedList`, `formatBlock` (blockquote), `justifyLeft` (paragraph), `createLink`, `removeFormat`, `undo`, and `redo`. `.flush()` rejects while disconnected, after access is revoked, for sent/read-only drafts, or if an update was rejected/unacknowledged.

Status values include `connecting`, `connected`, `offline`, `expired`, `document-ready`, `permission`, `revoked`, `saving`, `saved`, and `error`. `onChange` on the client receives scoped record events; `onChange` on an editor receives `(html, {recordId, scope, remote, pending})`.

## Wire protocol and limits

All frames are JSON. The browser sends `{type: 'auth', token}` as its first frame. Tokens are never put in the WebSocket URL. Origins must exactly match the configured allowlist; missing/untrusted origins and any URL query string are rejected before upgrading. Authentication must complete within five seconds.

Client operations are `subscribe`, `unsubscribe`, `join`, `leave`, `update`, `presence`, and `ping`. All scoped operations contain `scope`; document operations also contain `recordId`. Yjs updates and snapshots use base64. A join returns `joined` with authoritative `state`, `vector`, `revision`, `initialized`, and `readOnly`; a write returns `ack` with its `requestId` and durable `revision`. The client can receive `change`, `update`, `presence`, `permission`, `revoked`, or structured `error` frames.

Every message rechecks authentication and applicable scope/record permission. Broadcast recipients are rechecked before they receive data. A two-second sweep removes revoked membership and refreshes draft write locks, including idle connections. Session revocation closes the socket; scope/record revocation detaches the affected room and makes the editor read only.

Limits: 384 KiB wire messages, 256 KiB update payloads, 2 MiB encoded documents, 500,000 characters, 30,000 XML nodes, nesting depth 40, eight open documents per socket, sixteen workspace subscriptions, 120 messages in a burst replenished at 60/second, and a maximum 120 queued messages/2 MiB pending input per connection. Slow consumers are disconnected above 8 MiB pending output. Client and server retain no unbounded update log; SQLite stores the latest validated Yjs state, including the CRDT history needed for merging.

## Verification

Run `node --test tests/collab*.test.mjs`. The transport tests use real WebSockets and a temporary SQLite database, and cover concurrent rich character edits/deletes, convergence, durability across restart, read-only and send locks, membership/session revocation, immutable workspace binding, malformed and oversized CRDT updates, foreign shared roots, scoped record events, authenticated presence, strict origins, rejection of URL tokens, and shutdown/disconnection during pending authorization.

The jsdom client test mounts actual ProseMirror editors against the real hub. It verifies initialization without duplicate content, simultaneous insertion/deletion, rich formatting, relative selections, transient offline editing/reconciliation, lost-acknowledgment recovery, promotion of an uninitialized viewer, reconnecting a viewer after initialization, record-specific revocation, and editor cleanup. jsdom does not simulate native browser IME behavior; native composition handling is provided by ProseMirror and should additionally be exercised in supported browsers during release QA.
