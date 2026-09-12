# Avenor Mail

Avenor is an Outlook-inspired mail, calendar, contacts, and task workspace built with **plain HTML, CSS, and JavaScript**. It has a portable frontend for GitHub Pages and an independent Node.js backend for connected mail and collaboration. There is no React runtime in the frontend.

[Open Avenor](https://wieslawsoltes.github.io/AvenorMail/) · [Deployment workflow](https://github.com/wieslawsoltes/AvenorMail/actions/workflows/pages.yml)

## Use it

The Pages app starts with a clearly labeled **on-device workspace**. Mail, drafts, contacts, events, tasks, and attachment bytes persist in IndexedDB. Sample content can be hidden in **Settings → General**. In this mode, sending delivers only to your local identity; it cannot deliver internet mail or collaborate with another person's browser.

To enable connected features, start the included backend and choose **Settings → Connections → Connect a server**. Enter its HTTPS origin and sign in. The frontend can remain on GitHub Pages. An account's connected email addresses are separate from its Avenor sign-in identity.

## Implemented features

| Area | Implementation |
| --- | --- |
| Mail interface | Three-pane reader, focused/other views, virtualized message list, search worker, folders, categories, flags, pinning, snooze, rules, bulk actions, rich drafts, attachments, reply/forward, printing and EML export |
| Provider mail | Microsoft Graph and Gmail OAuth with PKCE and refresh; encrypted SMTP/IMAP credentials; MIME sending; incremental import and attachment storage; provider read/flag/standard-folder writeback |
| Delivery durability | Draft version checks, a submission lock, latest shared-text snapshot, stable idempotency records, partial SMTP acceptance reporting, explicit unresolved outcomes after ambiguous acceptance |
| Calendar | Month/week/agenda views, time zones, recurrence, conflict checks, ICS export; server-delivered invitation revisions/cancellations and confirmation-based RSVP links |
| Tasks and contacts | Task lists, due dates, reminders, steps, recurrence, My Day, assignments; contact editing, favorites and CSV import/export |
| Background service | Persisted scheduled sends, rules, snooze returns, recurrence, reminders and provider sync; executes while browsers are closed, provided the backend is running |
| Collaboration | Shared workspaces and notes; authenticated WebSockets; ProseMirror/Yjs character and formatting coauthoring; remote selections, presence and durable acknowledgments |
| Offline work | Scoped shell cache, IndexedDB snapshots and attachment caching, persisted JSON mutation queue, ordered replay, idempotency and explicit conflict review |
| Access controls | Invite-only password accounts, optional OIDC, authenticator MFA and recovery codes, session revocation, administrators, team viewer/editor roles, delegated mailbox read/write/send permissions |
| Data controls | SQLite WAL, encrypted provider secrets and file bytes, audit hash chain, retention policies and deletion protection under legal hold |
| Rendering | GPU calendar renderer; optional experimental workspace display layer with rectangle, glyph and image atlases; Canvas fallback; reproducible browser benchmark page |

## Run locally

Use **Node.js 24+** and the pinned pnpm version in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

Set `DATA_KEY` to a persistent random 32-byte base64 value, and set `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` in `.env`. The initial password must have at least 12 characters. Generate the key locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
pnpm start
```

Open `http://localhost:3000`, choose **Settings → Connections**, and connect to `http://localhost:3000`. The first startup creates the administrator. Invite other Avenor accounts from **Settings → Security**, then share a workspace invitation from Collaboration. Existing databases do not reset the administrator password on restart.

```sh
pnpm test          # Protocol, SQLite, offline, rendering and real UI integration tests
pnpm lint
pnpm build:pages   # Emits pages/; all browser paths work beneath /AvenorMail/
```

Tests run actual local HTTP/WebSocket and SQLite code with fake external providers. SMTP/IMAP transport tests use loopback servers. No test sends external email.

## Deploy

GitHub Actions tests and builds each push to `main`, uploads the static artifact, and publishes it through GitHub Pages. **Settings → Pages → Source** must be **GitHub Actions**. The frontend contains no provider credentials or database.

For connected mode, deploy the included Dockerfile to an always-on host with a persistent volume, HTTPS reverse proxy, and WebSocket support:

```sh
docker compose up --build -d
```

`compose.yaml` binds the service to loopback port 3000. Point your HTTPS proxy at that port. Set:

```dotenv
PUBLIC_URL=https://mail.example.com
FRONTEND_URL=https://wieslawsoltes.github.io/AvenorMail/
```

Set OAuth client IDs/secrets on the backend and register its exact callback URLs. Then connect accounts through the app. See [provider setup](docs/PROVIDERS.md), [deployment and security](docs/OPERATIONS.md), [background/calendar details](docs/BACKGROUND.md), [collaboration](docs/COLLABORATION.md), and [offline/rendering measurement](docs/PERFORMANCE.md).

## Boundaries that remain

This is a working application with substantial service implementations, **not full Outlook/Exchange parity or a certified enterprise mail service**. Deployment of a backend and provider consent are necessary to activate connected features; source code on GitHub Pages alone cannot run those services.

- Graph uses standard folders, Gmail maps labels to primary folders, and IMAP imports new INBOX UIDs. Custom folder enumeration, full bidirectional IMAP change/expunge reconciliation, shared Exchange mailbox discovery, provider contact/calendar sync, S/MIME/PGP and inbound native-email RSVP parsing are not complete. Calendar responses are processed through Avenor links and authenticated workspace responses.
- The backend runs as one active process per SQLite database. Multi-region clustering, enterprise federation/provisioning, eDiscovery, DLP, tamper-proof external audit storage and compliance certification are outside this implementation. Browser-closed reminders are stored by the server for the next visit; Web Push is not implemented.
- Offline JSON record edits survive reload. Unacknowledged character edits survive a dropped socket while that editor remains open, but do not survive a full reload until acknowledged. Attachments must finish upload before they can be referenced in connected records. Conflicting JSON edits require review instead of automatic overwriting.
- The optional full-workspace GPU layer remains experimental. DOM supplies layout, accessibility, native input, IME and selection. GPU display does not promise arbitrary CSS fidelity or faster performance. The benchmark measures the browser/device where it is run; no hardware throughput claim is embedded. Shader and visual output need validation on target GPUs.

Avenor is independently built and is not affiliated with Microsoft. It uses its own name and visual assets.
