# Deployment and security operations

## Architecture

`public/` is the browser application. `scripts/build-pages.mjs` bundles its dependencies with esbuild into `pages/`, copies the other modules, and stamps the service-worker cache with a content hash. `backend/server.js` exposes HTTP, WebSockets, static hosting, authentication and background services. It reuses `server/engine.js` for the record model and internal delivery. `drizzle/0000_warm_stick.sql` is the initial schema; backend modules add their own tables idempotently. No Drizzle runtime is required.

The Pages interface defaults to a browser-local workspace and only contacts a backend after the user enters its origin. It never stores OAuth/SMTP credentials. The server owns SQLite and attachment files under `DATA_DIR` and requires a persistent `DATA_KEY` before startup. Losing the key loses access to encrypted credentials and file contents. Run **one active Node process per SQLite database**; the WebSocket document cache and provider locks are process-local.

## Hosting

Use Node 24+ or the Dockerfile. Keep the `avenor-data` named volume across restarts. Place an HTTPS proxy in front of the service and support HTTP/1.1 WebSocket upgrades at `/api/live`. Set the proxy's WebSocket idle timeout above its normal heartbeat period. The app uses bearer tokens, exact configured CORS origins, and no cross-site authentication cookies. `PUBLIC_URL` must be the backend's public HTTPS origin; `FRONTEND_URL` may be the Pages URL including `/AvenorMail/`. Additional exact origins can be comma-separated in `ALLOWED_ORIGINS`.

`GET /api/health` is public and reports readiness and whether the scheduler timer is active. It does not reveal account details. A configured provider is not necessarily connected: the user must complete consent or provide mailbox credentials. OAuth redirects must exactly match the backend URLs described in PROVIDERS.md. Credentials belong only in the server environment, never Pages configuration or GitHub source.

The included container runs as the non-root `node` user. It binds to loopback through compose; terminate TLS at your host's reverse proxy. Restrict filesystem access to the service account. Use encrypted disks and backups if mail-body encryption at rest is required: SQLite record text is not encrypted by this application. AES-256-GCM protects provider secrets and file bytes, and scrypt hashes passwords.

## Accounts and enterprise identity

The first boot creates an administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Later boots leave account state intact. Registration consumes an administrator-generated, expiring invitation and uses the invited email as identity. Sessions are random bearer tokens, stored hashed on the server and in sessionStorage in the client. Administrators can change roles and disable other accounts through `/api/auth/users`; disabling an account invalidates its sessions. Deferred delivery rechecks the account and current delegation before submitting.

Password users can enable TOTP in Settings → Security. Enrollment requires their password and a valid authenticator code. Recovery codes are returned once and their hashes are stored. Login consumes TOTP counters and recovery codes atomically. Local OIDC sign-in delegates MFA policy to the configured identity provider; it does not stack local TOTP on top. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, optional `OIDC_CLIENT_SECRET`, and `OIDC_ALLOWED_DOMAINS` for automatic new-account provisioning. Existing accounts are matched only after the provider supplies a verified email identity. Register `PUBLIC_URL/api/auth/oidc/callback`. The flow validates signature, issuer, audience, nonce, two PKCE exchanges and a one-use frontend exchange code. Test your actual provider before rollout; providers that omit `email_verified` are rejected.

Viewer/editor roles apply to team records. Mailbox delegation grants explicit read, write and/or send rights; sending from a delegated mailbox uses its owner's connected provider account. Delegation is an Avenor permission and does not grant Microsoft Graph tenant-wide mailbox rights. Revoking sessions/permissions is enforced on subsequent HTTP requests and WebSocket messages.

## Jobs, provider changes and delivery uncertainty

The SQLite scheduler persists jobs, claims them transactionally and renews leases. It executes rules, snooze returns, scheduled sends, task recurrence and reminder creation without an open client. Notifications appear when the client next connects. Automatic provider polling is scheduled approximately every minute while the server runs.

Imported-message read, flag and folder changes create `provider_mutation` jobs through a database trigger in the same transaction as the record change. Provider import stamps avoid feedback loops; pending local changes are overlaid during import. Changes to one message are ordered, and unresolved earlier operations block later ones. Standard-folder support depends on provider capabilities; failures remain visible in Settings → Sync. This does not imply a full IMAP mirror or arbitrary Gmail-label editor.

Mail submission records distinguish provider acceptance, partial recipient acceptance, explicit failure and unknown outcome. A timeout or crash after possible external acceptance must not automatically send again. Inspect the provider Sent folder and relevant logs before resolving an unknown operation. Avenor does not promise exactly-once delivery across an external SMTP/API boundary. SMTP acceptance also does not mean final recipient delivery.

## Data controls and backups

Retention policies soft-delete records based on their last updated timestamp. A legal hold blocks ordinary record deletion and suspends that retention policy. These are application controls, not certified WORM storage or comprehensive legal discovery. Audit entries form a hash chain; verifying an exported chain detects changes relative to a previously trusted head. A database administrator who can replace both entries and the trusted head can rewrite the chain. Keep exports in independent storage when that threat matters.

Back up the **database, attachment directory and encryption key**. For an uncomplicated coherent snapshot, stop the service, copy `DATA_DIR` (including SQLite WAL/SHM files if present), store the key separately under restricted access, then restart. Do not copy only a live SQLite main file. Test restoration on an isolated host with the same key before relying on a backup. No automatic key rotation, backup retention service or disaster-recovery SLA is included.

The server does not log bearer tokens or passwords. Do not configure reverse-proxy access logs to capture OAuth codes, RSVP tokens, request bodies or authorization headers. Use an external log collector for deployment errors, monitor job failures, and monitor available disk space. App-level rate limits are in-memory and should be supplemented at the edge for an internet deployment.

## Validation and launch status

Run `pnpm test`, `pnpm lint` and `pnpm build`. Tests cover local WebSocket/HTTP integration, actual SQLite and IndexedDB operations, mocked provider APIs, loopback protocol safety and rendered UI interactions under jsdom. They do not validate real provider consent, external delivery, Web Push, actual GPU drivers or pixel equivalence with Microsoft Outlook. Run the benchmark at `benchmark.html` on target browsers and inspect the optional GPU mode before enabling it broadly.
