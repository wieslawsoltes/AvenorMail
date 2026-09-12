# Cluster operation

Avenor can run multiple Node instances against one transactional SQLite-compatible database. Use the remote libSQL configuration for hosts that do not share a local filesystem and shared object storage for attachments. A database connection must provide `BEGIN IMMEDIATE` write serialization, atomic commit, consistent reads, standard SQLite triggers, JSON functions, and BLOB storage. Independent databases with periodic file synchronization are not a cluster. A local SQLite file is suitable for multiple processes on the same host; it must not be mounted through a filesystem whose SQLite locking semantics are unreliable.

## Events and node liveness

`ClusterCoordinator` maintains `cluster_events`, `cluster_nodes`, `cluster_leases`, and `collaboration_presence`. Its migration installs triggers on existing records, collaboration documents, membership, delegation, account, and session tables. Call `migrate()` after the application's service migrations have created those tables; it is idempotent. `RealtimeHub.migrate()` also invokes it after creating its collaboration table.

Record and CRDT invalidations are inserted into the event log by database triggers in the originating transaction. An instance that crashes immediately after committing a write therefore cannot lose the cross-node invalidation. The event includes identifiers and revision/version information, not message bodies. Explicit application events use `publish(scope, event)`.

Each active node has a unique node ID, a boot-instance identity, a durable event cursor, and an expiry. Two live instances cannot register the same node ID. Event delivery is ordered by the database sequence and at least once: the consumer cursor advances after its callback succeeds; a failed callback is retried. Consumers must remain idempotent. An existing node ID resumes its previous cursor after its earlier instance has stopped or expired. New nodes start at the current log head and populate records/rooms from current database state.

Polling defaults to 500 ms. Nodes refresh a 30-second heartbeat. Maintenance retains at least 24 hours of processed events and only removes entries passed by every currently live node. An offline node returning after retention expiry must read authoritative records and collaboration snapshots, which Avenor does when workspaces and draft rooms reopen. The event log is an invalidation transport; it does not replace the application database or the audit journal.

```js
import { ClusterCoordinator } from '../backend/cluster.js';
import { RealtimeHub } from '../backend/realtime.js';

const coordinator = new ClusterCoordinator({ db, nodeId: instanceName }).migrate();
const hub = new RealtimeHub({
  db,
  coordinator,
  authenticate,
  authorize,
  // Must synchronously revalidate the session and current draft permissions.
  authorizeWrite: ({ request, user, scope, recordId }) =>
    canWriteDraftInCurrentTransaction(request, user, scope, recordId),
  allowedOrigins,
}).migrate().attach(httpServer);

coordinator.migrate(); // ensure all other service tables already exist
coordinator.start(envelope => hub.receiveClusterEvent(envelope));
coordinator.publish(scope, { type: 'notification-change', notificationId });

await hub.close();
await coordinator.stop();
```

The callback receives `{id, nodeId, scope, event, createdAt}`. `hub.receiveClusterEvent` consumes collaboration/presence invalidations, runs fresh authorization after permission or authentication changes, and forwards scoped record events. It does not republish events, avoiding loops. `status()` reports the current node/cursor, recent polling error, active nodes, and lease count. Treat this endpoint as administrative data when exposing it over HTTP.

## Concurrent rich text

The in-memory room is a cache. Every accepted CRDT write begins an immediate transaction, optionally rechecks session/write permission synchronously inside that transaction, reads the latest stored document, merges the incoming Yjs update, validates the merged document, and writes the next revision. The commit precedes acknowledgment and broadcast. Concurrent writes arriving at different nodes therefore merge against the latest state instead of replacing another node's accepted text.

First-writer initialization is transactional. A second writer with an independently generated seed cannot insert a duplicate copy of the original HTML. Existing rooms refresh on joins and collaboration events. If a writer reaches a stale node before its event polling catches up, that node sends the newly discovered remote difference as well as the current update to its local clients. Full Yjs structures and tombstones are idempotent, so delayed or repeated events do not duplicate characters.

`authorizeWrite` is optional for embedders but configured by the Avenor server. It must return a boolean synchronously. Promise-returning implementations are rejected; holding a shared connection's transaction open across asynchronous permission checks would allow unrelated requests to enter that transaction. Both seed creation and normal edits use the guard. Authorization errors roll back without changing the document revision.

## Cross-node presence

Presence records contain the verified session identity, display name, bounded cursor payload, node ID, and a 10-second expiry. Joins, selections, and leaves publish presence invalidations. The hub's two-second sweep refreshes its local participants and reads all unexpired participants in the room. A dead node's participants expire even when it cannot send leave events. Presence is ephemeral and never grants access. Every recipient is authenticated and authorized before receiving a presence or document broadcast.

A membership, delegation, or account/session change triggers a sweep on other nodes. Revoked rooms detach and their presence rows are removed. Sent/read-only draft transitions also cause local permission refresh when their record event arrives. Native per-operation authorization remains in place; polling is not the only access check.

## Work leases and fencing

`acquire(key, {ttl})` atomically acquires an unheld/expired lease. `withLease(key, callback, {ttl})` adds automatic renewal, waits for the callback, verifies ownership again, and releases the lease. Contention returns status `409` with code `LEASE_HELD`. Loss of ownership produces `LEASE_LOST`. Lease timestamps use the database clock, reducing dependence on the clocks of application hosts.

Each acquisition receives a monotonically increasing fencing token and a unique holder. Renew and release compare both, so an expired worker cannot renew or release another worker's replacement lease. The callback receives `{key, nodeId, holder, token, expires, signal, assert, renew, release}`. Pass `signal` to cancellable I/O. For protected database effects, call `assert()` inside the same write transaction as the effect; downstream services that accept a fencing token should reject stale tokens themselves.

```js
await coordinator.withLease(`mailbox-sync:${accountId}`, async lease => {
  const changes = await fetchChanges({ signal: lease.signal });
  db.exec('BEGIN IMMEDIATE');
  try {
    lease.assert();
    persistChanges(changes);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});
```

A lease cannot undo an email submission already accepted by an external provider. Avenor's durable submission IDs and explicit uncertain-outcome handling remain necessary. A callback that ignores its abort signal and performs an unfenced external side effect is outside the lease's guarantee. Lease ownership is not a distributed transaction with external email providers.

## Verification and operating limits

Run `node --test tests/cluster*.test.mjs tests/collab*.test.mjs`. Cluster tests use separate database connections, two actual WebSocket hubs, and the libSQL worker facade against a temporary database. They exercise concurrent stale-room writes, initialization races, convergence, shared presence, cross-node membership revocation, expiry cleanup, transactional authorization, durable cursors, failed-consumer retry, duplicate-node rejection, lease exclusion, fencing after expiry, and stale release/renew protection.

The deployment must supply a reliable shared database and object store, unique active node IDs, identical encryption/provider configuration, and load-balancer WebSocket support. Active sockets can remain on any healthy node; reconnecting sockets restore state from the shared database. A live geographically distributed service, real-provider failover during external submission, regional database outages, and capacity under production traffic require deployment-specific qualification. This implementation does not turn SQLite into a multi-writer replicated database; the configured database service must provide its advertised transactional consistency and availability.
