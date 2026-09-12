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
| Provider mail | Microsoft Graph and Gmail OAuth with PKCE and refresh; encrypted SMTP/IMAP credentials; MIME sending; durable import and attachment storage; complete IMAP membership/flag/expunge reconciliation, custom folders, and verified shared Microsoft mailbox attachment |
| Delivery durability | Draft version checks, a submission lock, latest shared-text snapshot, stable idempotency records, partial SMTP acceptance reporting, explicit unresolved outcomes after ambiguous acceptance |
| Calendar | Month/week/agenda views, time zones, recurrence, conflict checks, ICS export; Microsoft/Google calendar synchronization and conditional editing; complete stored recurrence/exception expansion; native inbound REQUEST/CANCEL/REPLY processing, review, and queued attendee responses |
| Tasks and contacts | Task lists, due dates, reminders, steps, recurrence, My Day, assignments; contact editing, favorites and CSV import/export; Microsoft contact folders and Google People synchronization with conditional writeback |
| Background service | Persisted scheduled sends, rules, snooze returns, recurrence, reminders and provider sync; executes while browsers are closed, provided the backend is running |
| Collaboration | Shared workspaces and notes; authenticated WebSockets; ProseMirror/Yjs character and formatting coauthoring; remote selections, presence, durable acknowledgments and IndexedDB journals that survive page reloads |
| Offline work | Scoped shell cache, IndexedDB snapshots and attachment caching, persisted JSON mutation queue, ordered replay, idempotency and explicit conflict review |
| Access controls | Invite-only password accounts, optional OIDC, authenticator MFA and recovery codes, session revocation, administrators, team viewer/editor roles, delegated mailbox read/write/send permissions |
| Data controls | Immutable revision snapshots and hash evidence, legal holds, retention/attachment cleanup, scoped eDiscovery cases, encrypted exports, outbound DLP and signed external audit archive delivery |
| Server clustering | Shared libSQL transactions or same-host SQLite, encrypted S3 attachments, durable database event fan-out, fenced worker/provider leases, atomic cross-node CRDT merge, node status and a process supervisor |
| Rendering | GPU calendar renderer; optional experimental workspace display layer with shaped multilingual text and image atlases, dirty GPU uploads and rounded clipping; standalone flex/grid scene layout with native semantic/IME controls; Canvas fallback and reproducible benchmark page |

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

Set OAuth client IDs/secrets on the backend and register its exact callback URLs. Then connect accounts through the app. See [provider setup](docs/PROVIDERS.md), [mail reconciliation](docs/MAILBOX-SYNC.md), [calendar/contact sync](docs/PIM.md), [native calendar mail](docs/INBOUND-CALENDAR.md), [clustering](docs/CLUSTERING.md), [compliance controls](docs/COMPLIANCE.md), [deployment](docs/OPERATIONS.md), [collaboration](docs/COLLABORATION.md), and [rendering measurement](docs/PERFORMANCE.md).

For multiple API processes on one host, set `WEB_CONCURRENCY=2` (or `auto`). For multiple hosts, point every node at the same `DATABASE_URL`/`DATABASE_AUTH_TOKEN` and encrypted S3 bucket. Give each node a distinct `CLUSTER_NODE_ID`. The database service and object store must provide their own availability, backups, access policies and recovery configuration. Do not place SQLite WAL on a network filesystem. Cluster status is available to administrators at `/api/cluster`.

## Boundaries that remain

This is a working application with substantial service implementations, **not full Outlook/Exchange parity or a certified enterprise mail service**. Deployment of a backend and provider consent are necessary to activate connected features; source code on GitHub Pages alone cannot run those services.

- Provider adapters are implemented and tested with protocol fixtures, local SMTP/IMAP servers and fake cloud providers. A deployed backend, registered OAuth applications and real account consent are still required. Provider throttling, tenant-specific permissions and a live production soak test are deployment work. Existing narrow OAuth grants must be reauthorized for the new calendar/contact/shared-mailbox scopes. Graph directory search plus verified access probes cannot enumerate every Exchange mailbox permission; explicit known-address attachment is supported.
- Native inbound scheduling handles VEVENT REQUEST/CANCEL/REPLY. Unverified sender claims are held for explicit review; mailbox OAuth alone does not authenticate the original email sender. S/MIME/PGP, additional iTIP methods, proprietary Exchange booking/delegation and SCIM federation are not implemented. Browser-closed reminders persist on the server; Web Push delivery is not implemented.
- Multi-process coordination, retained evidence, DLP rules and encrypted exports are implemented. Hosting availability, multi-region database failover, WORM archive configuration, organizational retention policies and regulatory certification require operational infrastructure and validation. Binary/PDF/archive content inspection is represented by an explicit unscannable-attachment detector; this is not an antivirus or general document-analysis system. Normal record/snapshot database encryption is provided by the database/storage host.
- Offline JSON edits and character/format journals survive reload; all saved-state indicators wait for the corresponding local commit or server acknowledgement. Provider conflicts and uncertain delivery results require review. Attachment upload must complete before connected records can reference it; IndexedDB remains subject to browser storage eviction unless the browser grants persistence.
- The optional workspace GPU adapter measures the existing DOM. The separate retained scene engine owns its flex/grid/stack/text-flow geometry. Both use native browser text shaping, accessibility, input and IME services. Neither claims arbitrary CSS equivalence, a complete browser rendering replacement, or verified hardware throughput. The benchmark exports actual measurements from the browser/device where it runs; target GPU validation remains necessary.

Avenor is independently built and is not affiliated with Microsoft. It uses its own name and visual assets.
