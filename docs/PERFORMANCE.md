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

## Standalone rendering engine

`gpu-workspace.js`, `scene-text.js`, and `scene-layout.js` are ordinary ES modules. They have no application, database, framework, or server dependency. Use them directly with a canvas, or with the independent retained layout tree below.

```js
import {WorkspaceRenderer} from './gpu-workspace.js';
const renderer = await new WorkspaceRenderer(canvas, {
  maxDpr: 3, atlasSize: 2048, maxAtlasPages: 8, onStatus
}).init();
const metrics = renderer.render({
  width: 1000, height: 700, background: '#ffffff',
  items: [
    {id: 'row', type: 'rect', x: 20, y: 20, width: 400, height: 56,
     color: '#eee8f7', radius: 8},
    {type: 'text', x: 36, y: 35, width: 350, height: 22,
     text: 'Design review · مرحبا 👩🏽‍💻', direction: 'rtl',
     fontSize: 16, fontWeight: 500, color: '#45375f'}
  ]
});
const target = renderer.hitTest(25, 25);
await metrics.queueDone;
renderer.dispose();
```

The backend draws rectangles, full shaped text lines, and images through instanced WebGPU storage buffers. Canvas 2D is a functional fallback for unavailable devices, failed initialization, validation errors, device loss, or a scene exceeding configured raster resources. Context replacement is managed because a canvas cannot switch from a WebGPU context to a 2D context. `dispose()` releases buffers, textures, font listeners, and replacement canvases.

Text is shaped by the browser's Canvas text preparation algorithm as a **complete line**, then cached as colored pixels in a paged texture atlas. Arabic joins, Hebrew/bidirectional runs, Indic shaping, ligatures, combining marks, emoji sequences, and color emoji are no longer split into separate character draw calls. Actual script/font support comes from the browser and installed/loaded fonts. `direction`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `fontKerning`, `fontStretch`, `fontVariantCaps`, `letterSpacing`, `wordSpacing`, and `lang` participate in text preparation/cache identity. Letter and word spacing apply when the browser exposes those Canvas properties. `baseline` gives an explicit CSS-pixel baseline offset; `textAlign` supports left/right/center/start/end. Text occupies one instance per line in the usual case. Oversized lines are shaped once on a temporary surface and tiled **after rasterization**, preserving joins at tile boundaries. The temporary surface is bounded to 32 megapixels and a 32,768-pixel dimension.

The atlas defaults to at most eight 2048 × 2048 RGBA pages: up to 128 MiB in GPU textures plus corresponding browser canvas storage. Pages are allocated on demand, reused between frames, and evicted by least recent frame use. Entries already referenced in the current frame cannot be evicted during packing. Font loading invalidates cached rasters. Page uploads cover only the dirty bounding region. The geometric instance and clip buffers grow geometrically; only changed aligned spans are uploaded. Scene normalization, packing, and changed-span detection still inspect the list on each render. These are reduced **uploads**, not a claim of sublinear full-frame CPU processing.

Geometry uses CSS pixels with DPR capped at 3 by default. Items support rectangular `clip` plus any number of nested rounded `clipShapes: [{x,y,width,height,radius}]`. The GPU evaluates rounded clip masks in the fragment stage and batches consecutive instances by page and scissor; Canvas uses matching nested clipping paths. Painter order is preserved across texture pages, and hit testing excludes rounded transparent corners and clipped areas. Offscreen items with known bounds are culled before raster preparation/drawing.

Image items accept `{type: 'image', image: CanvasImageSource, imageRevision, x, y, width, height, clip, clipShapes, opacity}`. Reuse the same decoded image object to reuse resources. Increment `imageRevision` for changes in a mutable canvas/video source. SVG icons should first be rasterized to a canvas or ImageBitmap; the application does this from actual SVG geometry. Decoding and cross-origin restrictions still apply. Images larger than a configured atlas page use the Canvas fallback. Hex, CSS `rgb()`/`rgba()`, and normalized RGBA arrays are supported color inputs.

## Independent layout, text flow, and semantic editing

```js
import {RetainedScene, SemanticOverlay} from './scene-layout.js';
import {TextMeasurer} from './scene-text.js';
const state = new RetainedScene({
  id: 'workspace', style: {layout: 'row', gap: 12, padding: 16},
  children: [
    {id: 'folders', style: {width: 180, height: 600, background: '#f0edf5'}},
    {id: 'editor', role: 'textbox', editable: true, multiline: true,
     label: 'Message', text: 'Hello',
     style: {grow: 1, height: 300, padding: 12, fontSize: 16}}
  ]
}, {width: 1000, height: 700, measurer: new TextMeasurer()});
const overlay = new SemanticOverlay(stage, {
  onInput(id, value) { state.update(id, {text: value, value}); repaint(); }
});
function repaint() {
  const scene = state.layout();
  renderer.render(scene);
  overlay.sync(scene);
}
repaint();
```

The `stage` must establish a containing block, for example `position: relative`, around its canvas. `RetainedScene` clones the scene description while preserving callbacks and image resources, addresses nodes by unique stable IDs, caches layout until `update()` or `resize()`, and maps painter-order hit tests back to source nodes. `layoutScene(tree, options)` returns the display list, node bounds, content extent, and semantic records without measuring DOM elements. Measurement can be injected as a pure function for server/tests.

The explicit layout vocabulary provides column flow; horizontal flex rows with basis, grow, shrink, wrapping, gap, align/alignSelf, and justify; grid columns with pixel/percentage/fraction tracks; absolute stack placement; padding; min/max dimensions; explicit local z-order; and clipped scroll offsets. It is a **defined scene API**, not an implementation of arbitrary browser CSS (for example, CSS subgrid, arbitrary selectors, transforms, blend groups and writing-mode layout are outside this vocabulary). Text flow measures shaped candidate substrings, wraps at word boundaries, uses Unicode grapheme boundaries for oversized tokens, and supports max-line ellipsis without splitting combining sequences or emoji. `TextMeasurer` bounds its measurement cache and can be cleared after font changes.

`SemanticOverlay` keeps real browser focusable controls at scene bounds, labels/roles/states for assistive technology, keyboard activation, and native input/textarea editing. Synchronization retains focused elements and selection, never overwrites an active IME composition, and dispatches text changes after composition commits. This is plain-text native input; rich-text coauthoring remains the application's ProseMirror editor. Native focus rings and editing are intentional browser integration, not fake canvas caret/keyboard implementations. The engine does not implement a separate accessibility platform or OS input method.

## Workspace presentation and calendar integration

`GpuPresentation` still adapts Avenor's existing HTML views. It groups logical substrings by actual browser line boxes, shapes complete visual lines (including RTL, complex scripts, emoji and wrapped text), and carries computed font attributes and baseline metrics into the renderer. Backgrounds, borders, underline/strikethrough, real SVG icons, ordinary images, client-area scroll clips, and nested rounded overflow clips are captured. SVG paint styles are resolved on every descendant, so icons never become placeholder glyphs. Font, image, mutation, scrolling, resizing, hover, and input events invalidate the presentation.

Actual form controls, editable regions, calendar canvases, media/embedded surfaces, transforms, gradients/background images, filters, and overlapping opacity groups remain visible in transparent native regions. Focusing native editors, keyboard focus rings, text selection, unsupported generated content, incomplete image preparation, or a scene beyond 16,000 captured items may show the whole native view. `lastMetrics` reports native region count, DOM capture time, and total capture/render time. The underlying DOM continues to supply layout, accessibility and event handling for these existing views; switching the workspace option does not migrate every view to the independent scene layout tree.

This adapter is not a replacement browser CSS renderer. Local z-index ordering cannot reproduce every CSS stacking context; sophisticated borders, group blending, shadows and all pseudo-element behavior are not universally pixel-equivalent. DOM painting is retained beneath the canvas. Consequently, no application speedup or exact Outlook pixel equivalence is claimed. The independent renderer/scene API above is available for applications that deliberately own their layout and display list.

`CalendarRenderer` retains its compatible `initialize()`, `draw([{x,y,w,h,color}])`, `destroy()`, and readable `mode` API over the same backend. Event labels and interactive calendar controls remain HTML. Resize maintains retained calendar geometry and CSS sizing.

## Reproducible measurement and verification

Open `benchmark.html` and choose 1,000, 10,000 or 50,000 items with rectangles, Latin text, Arabic/Hebrew/Indic/emoji runs, rounded images, mixed content, or independent grid layout. Select WebGPU when available or Canvas 2D. Five warm-up frames precede 60 measured requestAnimationFrame iterations. A retained item changes every frame; the layout case updates a scene node and recalculates layout. Grid content outside the viewport is culled, so its retained node count is different from its visible draw-instance count. The other synthetic scenes intentionally overlap densely.

Results report median/p95 render CPU time, layout time, frame intervals, queue completion wait, and median buffer bytes uploaded. JSON export includes raw samples, timestamp, browser, actual backend, DPR, atlas pages and texture-upload bytes. No numbers are populated before running a measurement. The separate **Try standalone editing** action demonstrates independent scene layout with keyboard/IME semantic controls; it is not a timing result.

**GPU queue wait is wall-clock time from submission to `queue.onSubmittedWorkDone()`**, including queue scheduling. It is not an isolated hardware execution timestamp. Canvas queue time is unavailable. These synthetic measurements do not establish full application interaction latency or a universal speed advantage. Compare identical browser/window/power settings and workload before drawing conclusions.

```sh
node --test tests/offline*.mjs tests/rendering*.mjs
```

Rendering tests cover complete-run submission, tiled shaping, grapheme-safe wrap/ellipsis, cache reuse/eviction, DPR and baseline preparation, dirty upload spans, rounded clip hit tests, independent flex/grid geometry, retained invalidation, painter order, native focus/IME lifecycle, DOM clipping, SVG serialization, and calendar resize/disposal. Fake Canvas/DOM tests validate control flow and geometry, not actual font raster pixels or physical GPU throughput. Real shader compilation, hardware/device-loss behavior, assistive technology, cross-browser typography and mobile input need target-environment qualification.

The implementation follows the primary [HTML Canvas text preparation and metrics specification](https://html.spec.whatwg.org/multipage/canvas.html#text-preparation-algorithm) and [WebGPU resource/queue specification](https://www.w3.org/TR/webgpu/). Native shaping and accessibility remain platform services; the renderer does not claim to replace them.
