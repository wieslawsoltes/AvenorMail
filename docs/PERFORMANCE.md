# Offline persistence and rendering

Avenor has two distinct storage modes. GitHub Pages uses an explicit **device-local** workspace. IndexedDB is its source of truth, including attachment Blob bytes. Reloads preserve the data; other tabs in the same origin and browser profile receive BroadcastChannel invalidations. This does not provide cross-device or cross-user collaboration. Clearing site data removes that local workspace.

Connected mode uses the server as the source of truth, with IndexedDB snapshots and a durable queue for interrupted JSON writes. Never reuse one connected cache namespace for multiple identities. Use a namespace containing both the API origin/base and the authenticated user ID, and close the old store on logout or account switch. Authentication and permission failures must not fall back to cached content.

## Offline API

```js
import {OfflineStore, LocalWorkspace, createOfflineTransport} from './offline.js';

const local = new LocalWorkspace({
  namespace: 'device-local',
  onChange: () => refreshCurrentWorkspace()
});
await local.open();
const data = await local.call('data');
const task = await local.call('record', {
  method: 'POST',
  body: {kind: 'task', data: {title: 'Review design', done: false}}
});
await local.call('record', {
  method: 'PATCH',
  body: {id: task.id, version: task.version, patch: {done: true}}
});
```

`LocalWorkspace.call(path, {method, body})` implements `data` pagination, `record` create/update/delete, device-local `team` creation, `upload`, and local `send`. `body` accepts an object or JSON string; upload accepts FormData or `{file: Blob, scope}`. `getFile(id)` returns the original Blob. Its user defaults to `you@avenor.local`. Local send delivers only to that local identity, marks the result `delivery: 'device-local'`, and creates an unread local inbox record. External recipients leave the original draft unchanged and produce a clear error. Local teams cannot issue invitations or add real remote members.

`OfflineStore({namespace})` exposes:

| Method | Behavior |
| --- | --- |
| `open()` | Opens/version-checks IndexedDB; fails explicitly if storage is unavailable. |
| `getSnapshot(scope)`, `setSnapshot(scope, data)` | Reads/writes structured-cloneable snapshots. |
| `enqueue({id, method, path, body, scope, baseVersion})` | Persists a mutation and stable ID before attempting delivery; duplicate IDs keep the original request. |
| `pending()` | Returns mutations in transactionally allocated sequence order. |
| `flush(send)` | Replays in order; deletes only acknowledged operations and returns outcomes. |
| `resolveConflict(id, replacement)` | Explicitly replaces a reviewed edit with a new idempotency key; omitting replacement discards the queued edit. |
| `putBlob(id, blob)`, `getBlob(id)`, `deleteBlob(id)` | Persists attachment bytes in IndexedDB. |
| `clear()`, `close()` | Clears this namespace or closes the database connection. |

`flush` preserves a 409 conflict's original body and base version. It does not automatically change versions or overwrite the current server value. It stops at an unresolved operation so later dependent changes cannot overtake it. Other permanent 4xx errors become `blocked`; network/5xx failures remain `pending`. Web Locks serialize same-namespace replays across tabs when available. Servers must independently enforce idempotency because not every browser supports Web Locks, and a connection may disappear after the server has applied a write.

`createOfflineTransport({apiBase, namespace, getToken, onStatus})` provides `call`, `flush`, and `store` for JSON endpoints. It sends an `Idempotency-Key` header on mutations and requires the server to honor it. API URLs cannot escape the configured base. A queued result is `{queued: true, mutationId, delivery: 'pending'}`: callers must retain drafts/outbox state and must **not** display it as a successful send. Cache snapshots are returned only for transport failures, with `offline: true`. Callers should call `flush()` on reconnection, then fetch authoritative records. Pending optimistic rendering and conflict review are application responsibilities. Attachment uploads use the separate upload transport; this JSON helper does not pretend multipart bytes were uploaded.

## Service worker

`sw.js` resolves shell assets relative to its registration URL, so a Pages project base such as `/AvenorMail/` works. Navigation is network-first with an `index.html` offline fallback. Only an explicit allowlist of shell assets enters CacheStorage; API/auth URLs, attachments, arbitrary responses, and other origins never enter it. Shell cache names include the registration path. A required shell fetch failure rejects installation and preserves the last working service worker. Optional icons and install metadata may be absent. Register the worker from the same project base and use a matching relative manifest start URL.

## Optional GPU workspace read layer

```js
import {WorkspaceRenderer} from './gpu-workspace.js';
const renderer = await new WorkspaceRenderer(canvas, {onStatus}).init();
const metrics = renderer.render({
  width: 1000, height: 700, background: '#ffffff',
  items: [
    {id: 'row', type: 'rect', x: 20, y: 20, width: 400, height: 56,
     color: '#eee8f7', radius: 8},
    {type: 'text', x: 36, y: 35, width: 350, height: 22,
     text: 'Design review', fontSize: 16, color: '#45375f'}
  ]
});
const target = renderer.hitTest(25, 25);
await metrics.queueDone;
renderer.dispose();
```

The renderer retains the latest display list and draws rectangles, glyphs, and images using a WebGPU instance storage buffer. Image items accept `{type: 'image', image: CanvasImageSource, x, y, width, height, clip, opacity}`. Rasterize SVG icons to an ImageBitmap or canvas before adding them; their original colors are stored in the atlas, and Canvas 2D uses `drawImage` for fallback. Reuse image objects to reuse atlas entries. Hex, normalized RGBA arrays, and CSS `rgb()`/`rgba()` colors are supported. Text items accept `fontFamily`, `fontSize`, `fontWeight`, and `fontStyle`. Each glyph is rasterized with Canvas 2D into a real texture atlas, uploaded when the atlas changes, and sampled on GPU quads. Rounded rectangles use a fragment distance mask. Consecutive items sharing a clip form one instanced batch; scissor rectangles preserve clipping and painter order. The instance buffer grows geometrically rather than being recreated for each draw. A render currently normalizes and repacks the full list; it does not implement incremental dirty-region uploads.

Geometry is in CSS pixels. Device pixel ratio is capped at 2 by default and can be overridden through the renderer option. GPU initialization, validation, or device loss switches to Canvas 2D. When the original canvas already acquired a WebGPU context, a replacement canvas is inserted because browsers prohibit changing its context type. `dispose()` releases GPU resources and the replacement canvas.

This is an optional visual read layer. Keep semantic DOM content, keyboard navigation, focus indicators, selections, text inputs, contenteditable composition, and native controls available. The GPU renderer is not an accessibility tree. Glyph-by-glyph atlas placement does not perform complex-script shaping, ligatures, or bidirectional layout; use DOM text for those cases. Rich HTML bodies, native emoji color rendering, and text selection are not implemented by this renderer. Images must be decoded and safe to upload to a canvas texture; large images that exceed atlas capacity trigger Canvas 2D fallback. The atlas has a finite 2048 × 2048 capacity and falls back to Canvas 2D on exhaustion.

## Experimental DOM presentation and calendar integration

`GpuPresentation` in `gpu-mode.js` measures the visible DOM, paints simple backgrounds, borders and text in local stacking order, and clips to scroll-container client bounds. SVG icons are serialized from their actual paths/viewBox with computed paint styles on every descendant, then rasterized and cached at device pixel ratio. Missing or failed icon rasterization shows the original DOM until a complete scene is available; it never substitutes placeholder glyphs. Text includes computed font weight and style.

The DOM remains painted beneath the canvas. The read layer cuts transparent holes around actual inputs, selects, textareas and editable regions, retaining native browser control appearance and event handling. Editing, keyboard focus rings, text selection, embedded canvas/media and unsupported CSS/text layouts show the original DOM. Mouse focus on an ordinary button does not automatically disable presentation. The integration watches hover, input/change, scrolling, mutations, resize, and icon/font loading. Device-loss replacement canvases follow the same visibility lifecycle.

This integration is explicitly experimental. It does not replace browser layout or avoid the underlying DOM paint cost, and it currently measures/rebuilds the visible scene on updates. Simple local z-index sorting is not a complete implementation of CSS painting and stacking contexts; box shadows, sophisticated border shapes, kerning/letter spacing and all pseudo-element behavior are not pixel-equivalent. CSS background images/gradients, filters, complex wrapping, bidirectional/complex-script text, or a scene over 16,000 items return to native rendering. These fallbacks can mean a selected experimental mode is displaying the native page. Do not claim an application speedup from enabling this layer; measure actual workload and device results.

`CalendarRenderer` is a thin compatibility adapter over `WorkspaceRenderer`, retaining `initialize()`, `draw([{x,y,w,h,color}])`, `destroy()`, and the readable `mode`. It shares the geometric buffer allocation and actual device-loss Canvas 2D fallback. Calendar geometry is retained between resizes, with horizontal coordinates scaled to the new viewport; CSS continues to determine canvas size. Event labels and interactive controls remain HTML.

## Reproducible measurement

Open `benchmark.html` from the deployment or local server. Choose 1,000, 10,000, or 50,000 items, rectangles/text/mixed content, and WebGPU or Canvas 2D. The page warms up five frames and measures 60 requestAnimationFrame iterations. It reports actual CPU median/p95, observed frame intervals, and GPU queue completion wait where available. Stops produce partial results, explicitly labeled.

CPU time includes scene normalization, instance packing, cached glyph lookup, newly required glyph rasterization, texture/buffer uploads, and submission. **GPU queue time is the wall-clock interval from submission to `queue.onSubmittedWorkDone()`**, including queue scheduling. It is not a hardware timestamp and is not isolated GPU execution duration. Canvas 2D queue timing is reported unavailable. No benchmark numbers are embedded or claimed in advance. Text expands each retained item into multiple draw instances; the benchmark displays that count.

The synthetic dense scene intentionally overdraws. Browser, operating system, GPU, browser power mode, window size, DPR, and background activity affect results. Compare the same scene in the same environment and separately profile the full app's interaction latency. GPU acceleration is not guaranteed to outperform DOM or Canvas 2D for small scenes.

Run the persistence/queue and pure scene checks with:

```sh
node --test tests/offline*.mjs tests/rendering*.mjs
```

The tests use `fake-indexeddb` for actual database transactions, reopens, attachment round trips, ordering, conflict retention, and local version checks. Pure rendering tests verify clipping, painter-order hit testing, color normalization, and immutable scene input. Service worker policy tests verify scoped navigation fallback, API exclusion, and rejection of incomplete shell installs. Shader compilation, real device loss, actual service worker lifecycle, and browser typography require browser validation; these Node tests do not prove GPU throughput or pixel equivalence.
