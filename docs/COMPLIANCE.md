# Avenor evidence, retention, and data protection

Avenor includes executable data-governance controls for its connected backend. They operate on the same SQLite or libSQL database as mail and collaboration. These controls do not confer a regulatory certification. Database operators remain capable of changing the database schema; externally retained audit checkpoints are needed to detect an operator replacing a complete local history.

## Record history and integrity

`ComplianceService.migrate()` installs standard SQLite triggers on `records`. Every committed insert, update, soft deletion, and hard deletion records the new state (or the final state before hard deletion). Existing records receive a baseline snapshot. A transaction rollback also rolls back its snapshots. The trigger does not call JavaScript or require a SQLite extension, so it works through the shared libSQL backend.

Revision metadata is append-only. Payload updates are rejected. The service seals snapshots into a SHA-256 chain under an immediate transaction using canonical JSON, with both a payload digest and the preceding revision digest. Deleting a retained payload requires a temporary explicit purge permit and leaves an immutable purge ledger entry; the revision metadata and digest remain. `GET /api/compliance/verify` verifies the complete revision and application-audit chains. No application-facing endpoint can rewrite revision metadata, hashes, or audit entries.

Snapshots use the same database storage protection as ordinary records. **The whole SQLite/libSQL database is not encrypted by `DATA_KEY`**: enable encrypted disks, protected backups, and your hosted database's encryption and access controls. Evidence export packages are separately encrypted with AES-256-GCM using `DATA_KEY`; the attachment storage implementation also encrypts attachment objects before persistence.

## Authorization

Application administrators can administer compliance controls across explicit scopes. Everyone else needs an administrator-issued grant for each scope; mailbox ownership, team membership, and mailbox delegation do not grant evidence-search access.

| Right | Allows |
| --- | --- |
| `read` | List permitted cases and search their revision history |
| `hold` | Create cases, place/release holds, and open/close cases |
| `export` | Create, list, and download evidence exports |
| `policy` | Read and change outbound data-protection policies |

`POST /api/compliance/grants` accepts `{ "userId": "account-id", "scope": "user:account-id", "rights": ["read", "hold", "export"] }`. Scopes can also be `team:team-id`. `DELETE` at the same endpoint revokes that grant. Grant changes, case actions, searches, export operations, policy decisions, and retention are audited. Search audit entries retain a query digest rather than the query text.

Every case operation requires permission for **all** scopes included in the case. Export permission is checked again after attachment reads, and on every download. An ordinary user cannot enumerate unrelated cases or retrieve an old export after their grant is revoked. Account authentication remains the outer server's responsibility, so disabled accounts cannot continue using these routes.

## Cases, holds, and literal search

1. `POST /api/compliance/cases` with `{ "name": "Incident 2026-09", "reason": "Preserve correspondence for the incident review", "scopes": ["user:account-id"] }`.
2. `POST /api/compliance/holds` with `{ "caseId": "case-id", "scope": "user:account-id", "recordId": "optional-record-id", "reason": "Preserve evidence" }`.
3. `POST /api/compliance/search` with `{ "caseId": "case-id", "query": "literal terms", "kind": "message", "limit": 100 }`.

Omitting `recordId` places a scope hold, including future records. A hold preserves previous snapshots, permits normal content edits, and blocks moving, deleting, or purging protected records. Legacy workspace legal holds are enforced by the same database triggers. Closing a case does not release its holds. Release requires `DELETE /api/compliance/holds/:id` with a documented `reason` and the corresponding hold permission.

Search accepts `recordId`, `kind`, `from`, `to`, `after`, `limit`, and `includePurged`. `from`/`to` are Unix millisecond **capture timestamps**, not the email's original sent date. `after` is the revision sequence cursor. Pages are ordered by sequence and capped at 500 entries. Query text is matched literally and case-insensitively against the stored JSON payload; SQL parameters and LIKE escaping prevent wildcard or SQL injection. Purged records expose only revision metadata and integrity evidence when `includePurged` is true.

## Evidence exports

`POST /api/compliance/exports` uses the same case/search filters and optional `includeAttachments` (default true). It returns an export identifier, item counts, and a manifest hash. `GET /api/compliance/exports?caseId=...` lists case exports, and `GET /api/compliance/exports/:id` downloads a JSON package.

The package includes every selected record revision, SHA-256 revision evidence, original attachment bytes as base64, attachment digests, explicit search criteria, a sequence cutoff, and a canonical manifest. A missing or mismatched-scope attachment fails the export; it is not silently omitted. A scope lease blocks retention during export assembly. An interrupted build expires after 15 minutes and can then be cleaned up by retention. The default export limit is 10,000 revisions and 50 MiB; set `COMPLIANCE_EXPORT_MAX_BYTES` to change the byte limit. Narrow large searches into multiple exports.

Identical selected revisions, attachment bytes, case details, and criteria produce identical manifest hashes. Generated export IDs and creation times are stored outside the manifest. `verifyComplianceExport(bundle, expectedManifestHash)` in `backend/compliance.js` verifies payloads, attachment bytes, revision hashes, and manifest membership independently. Store the expected manifest hash through a separate trusted channel: an attacker who replaces both an unsigned package and its claimed digest cannot be detected using that package alone.

Exports are encrypted in the database with `DATA_KEY`. Downloaded JSON is intentionally plaintext for evidence review. Keep downloaded exports under your organization's evidence-access and retention controls. Existing encrypted exports are retained until administratively removed through database backup/lifecycle operations; normal mailbox retention does not discard evidence packages.

## Retention and attachment cleanup

The existing workspace policy (`/api/policies`, `retentionDays`) controls the expiration age. Zero disables expiration. Age is measured from the record's latest update time, so editing an item renews its retention period. `GET /api/compliance/retention` previews eligible, held, and export-protected record counts by scope. `POST` runs a batch; the connected backend also invokes the same worker periodically.

Eligible expired records are removed from ordinary storage. Their retained payloads are purged only after expiration, with immutable metadata, digests, and a purge ledger retained. Active record/scope holds and export leases prevent purging. A hold applies to retained snapshots even if the original record was already removed before the hold was placed. A hold cannot recover a payload that had already been purged.

Expired attachment objects are removed only when no current record or retained snapshot references them. Whole-scope holds and export leases also protect unreferenced attachments. The database records a durable cleanup obligation before deleting the object; storage failures retry on a later retention run. Expired attachment IDs cannot be reused, preventing an old cleanup request from deleting newly created content under the same key. `wasPurged(recordId)` lets provider reconciliation avoid reintroducing records erased by retention.

## Classification and outbound data protection

Messages support `public`, `internal` (default), `confidential`, and `restricted` classification. A classification alone does not block delivery: administrators configure explicit rules through `/api/compliance/dlp`. No DLP rules are enabled by default.

Read the current policy/version using `GET /api/compliance/dlp?scope=user:account-id`. Save with `POST` using the current version for compare-and-swap:

```json
{
  "scope": "user:account-id",
  "version": 0,
  "policy": {
    "internalDomains": ["example.com"],
    "rules": [
      {
        "id": "restricted-external",
        "name": "Keep restricted information inside the organization",
        "action": "block",
        "match": {"classifications": ["restricted"], "externalOnly": true}
      },
      {
        "id": "financial-data",
        "name": "Review financial information",
        "action": "warn",
        "match": {"detectors": ["credit-card", "iban"], "externalOnly": true}
      },
      {
        "id": "opaque-attachments",
        "name": "Block attachments that cannot be inspected",
        "action": "block",
        "match": {"detectors": ["unscannable-attachment"], "externalOnly": true}
      }
    ]
  }
}
```

Supported conditions are `classifications`, `detectors`, literal `terms`, `externalOnly`, exact `recipientDomains`, `attachmentExtensions`, and total `maxAttachmentBytes`. Conditions in one rule use AND; values within each condition use OR. Recipient checks include To, Cc, and Bcc. Domain comparisons are exact; declaring `example.com` does not implicitly trust `other.example.com`.

Detectors include Luhn-valid 13–19 digit credit-card candidates, supported-country IBAN length/mod-97 checks, formatted U.S. SSN patterns, recognized private-key/cloud-token markers, and `unscannable-attachment`. The inspected body has HTML tags and numeric entities decoded, zero-width text removed, and Unicode normalized. Text attachments up to 1 MiB are read from authenticated stored bytes; binary, larger, missing-text, and unsupported attachment formats are explicitly marked unscannable. Rules do not perform PDF/Office extraction, OCR, archive decryption, malware inspection, or arbitrary regular-expression execution. Add the `unscannable-attachment` rule when delivery must fail closed for those files. Pattern matches are candidates rather than proof of a person's identity or ownership of a financial account.

`evaluateOutbound` runs before submitting mail and throws:

- HTTP 422, `code: "dlp_blocked"`, `violations`: delivery is prohibited.
- HTTP 409, `code: "dlp_warning"`, `warnings`, `acknowledgment`: show the exact warnings, then retry with `acknowledged: [acknowledgment]` if the sender accepts them.

The acknowledgment is bound to scope, record, policy, recipients, classification, inspected content, and attachments. Changing any of those requires a new acknowledgment. Blocks cannot be acknowledged away. Audit decisions include policy and content digests plus rule IDs, without copying matched financial numbers or body text. Background scheduled delivery must reevaluate policy at execution time; a new warning or block stops that delivery rather than bypassing policy.

## External audit checkpoint sink

Configure these **backend-only** environment variables to archive application audit batches:

```dotenv
AUDIT_SINK_URL=https://your-audit-archive.example/append
AUDIT_SINK_TOKEN=<secret-bearer-token>
AUDIT_SINK_HMAC_KEY=<independent-high-entropy-signing-secret>
```

`flushAuditSink()` posts canonical `avenor.audit.v1` JSON with sequence range, preceding/head hashes, and audit entries. HTTPS, bearer authorization, `X-Avenor-Signature: sha256=<HMAC>`, a deterministic `Idempotency-Key`, a timeout, and rejected redirects are enforced. The receiver must validate the signature and previous head, append durably without replacement, deduplicate the idempotency key, and return `{ "acceptedThrough": <last sequence>, "head": "<accepted head hash>" }`. Only an exact receipt advances the persisted sender checkpoint. A lease prevents overlapping workers from claiming the same batch; failed or uncertain requests retry with the same key.

The archive's append-only/WORM storage and access policy are the operator's responsibility. Avenor supplies the signed protocol and retrying sender, not a claim about a remote service's storage guarantees. `GET /api/compliance/audit-sink` shows checkpoint/error status. `POST` requests a flush. Tests use a local fake receiver; no external customer data is sent by the test suite.

## Verification

`node --test tests/compliance.test.mjs` exercises real SQLite transactions and trigger rollback; restart migration; record and future-scope holds; grant revocation and cross-scope rejection; literal SQL-injection searches; deterministic encrypted exports; payload/manifest/attachment tamper detection; missing attachments; export/retention races; stale leases; retention and durable object-deletion retries; DLP checks and content-bound acknowledgments; and signed idempotent audit-sink receipts.
