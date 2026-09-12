import {WorkspaceRenderer} from './gpu-workspace.js';
import {layoutScene, RetainedScene, SemanticOverlay} from './scene-layout.js';
import {TextMeasurer} from './scene-text.js';
const byId = id => document.getElementById(id);
let renderer, cancelled = false, busy = false, semanticOverlay;
const measurements = [];
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const stats = values => {
  const sorted = values.filter(value => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? {median: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))]} : null;
};
const show = value => value ? value.median.toFixed(2) + ' / ' + value.p95.toFixed(2) + ' ms' : 'Unavailable';
const texts = ['Avenor · ffi office', 'مرحبا بفريق العمل', 'פגישת צוות · 12:30', '日本語の予定表', 'नमस्ते सहयोग', '👩🏽‍💻 🇵🇱 👨‍👩‍👧‍👦'];
function makeImage() {
  const image = document.createElement('canvas'); image.width = image.height = 64;
  const context = image.getContext('2d'); context.fillStyle = '#d7c5f0'; context.fillRect(0, 0, 64, 64); context.fillStyle = '#67528c'; context.beginPath(); context.arc(32, 24, 12, 0, Math.PI * 2); context.fill(); context.fillRect(15, 42, 34, 22); return image;
}
function makeScene(count, kind) {
  const width = 1100, height = 650, items = [], image = makeImage();
  if (kind === 'layout') {
    const tree = {id: 'workspace', style: {layout: 'grid', columns: ['1fr', '2fr', '1fr'], gap: 12, padding: 16, overflow: 'hidden'}, children: Array.from({length: count}, (_, index) => ({id: 'card-' + index, style: {padding: 10, height: 88, background: index % 2 ? '#e9e3f2' : '#d6e9e6', radius: 8, gap: 4}, children: [{id: 'title-' + index, type: 'text', text: texts[index % texts.length], style: {fontSize: 14, direction: index % 6 === 1 || index % 6 === 2 ? 'rtl' : 'ltr'}}, {id: 'body-' + index, type: 'text', text: 'A full shaped line · ' + index, style: {fontSize: 12, color: '#536070'}}]}))};
    return new RetainedScene(tree, {width, height, measurer: new TextMeasurer(), background: '#f9f7fc'});
  }
  for (let index = 0; index < count; index++) {
    const x = (index * 47) % (width - 180), y = (Math.floor(index / 20) * 29) % (height - 30);
    const isText = kind === 'text' || kind === 'shaped' || kind === 'mixed' && index % 3 === 1, isImage = kind === 'images' || kind === 'mixed' && index % 3 === 2;
    items.push(isText ? {id: index, type: 'text', x, y, width: 180, height: 26, text: kind === 'text' ? 'Mail ' + index % 100 : texts[index % texts.length], fontSize: 14, direction: index % 6 === 1 || index % 6 === 2 ? 'rtl' : 'ltr', color: '#493c64'} : isImage ? {id: index, type: 'image', image, x, y, width: 24, height: 24, clipShapes: [{x, y, width: 24, height: 24, radius: 12}]} : {id: index, type: 'rect', x, y, width: 90, height: 22, radius: 5, color: index % 3 ? '#e6dff2' : '#bdded8'});
  }
  return {width, height, background: '#f9f7fc', items};
}
byId('stop').onclick = () => { cancelled = true; };
byId('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({schema: 1, measurements}, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'avenor-renderer-measurements.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
byId('run').onclick = async () => {
  if (busy) return;
  busy = true; cancelled = false; byId('run').disabled = true; byId('stop').disabled = false; byId('semantic').disabled = true;
  const cpu = [], queue = [], intervals = [], layout = [], uploads = [], rasterUploads = [];
  try {
    semanticOverlay?.dispose(); renderer?.dispose();
    renderer = new WorkspaceRenderer(byId('canvas'), {onStatus: status => { byId('status').textContent = status.backend + (status.reason ? ': ' + status.reason : ''); }});
    if (byId('backend').value === 'canvas2d') renderer.fallback('Canvas 2D selected'); else await renderer.init();
    const count = Number(byId('count').value), kind = byId('kind').value, source = makeScene(count, kind);
    let previous = null, last;
    for (let frame = 0; frame < 65 && !cancelled; frame++) {
      const timestamp = await nextFrame(), layoutStarted = performance.now();
      let scene;
      if (source instanceof RetainedScene) {
        source.update('title-0', {text: 'Retained frame ' + frame}); scene = source.layout();
      } else { source.items[0].x = frame % 60; scene = source; }
      const layoutMs = performance.now() - layoutStarted, metrics = renderer.render(scene); last = metrics;
      const queueMs = await metrics.queueDone;
      if (frame >= 5) { cpu.push(metrics.cpuMs); queue.push(queueMs); layout.push(layoutMs); uploads.push(metrics.uploadedBytes); rasterUploads.push(metrics.textureBytes); if (previous !== null) intervals.push(timestamp - previous); }
      previous = timestamp;
      byId('status').textContent = `${metrics.backend} · ${Math.max(0, frame - 4)}/60 measured frames · ${metrics.primitives.toLocaleString()} visible draw instances · ${metrics.atlasPages} atlas pages · ${metrics.cacheHits} cache hits`;
    }
    const result = {time: new Date().toISOString(), browser: navigator.userAgent, backend: renderer.backend, dpr: devicePixelRatio, count, kind, samples: cpu.length, stopped: cancelled, cpu: stats(cpu), layout: stats(layout), queueWait: stats(queue), frameInterval: stats(intervals), bufferBytes: stats(uploads), textureBytes: stats(rasterUploads), atlasPages: last?.atlasPages ?? 0, frames: {cpu, layout, queue, intervals, uploads, rasterUploads}};
    measurements.push(result); byId('export').disabled = false;
    const row = document.createElement('tr');
    for (const value of [result.backend, `${kind} · ${count.toLocaleString()}`, cpu.length, show(result.cpu), show(result.layout), show(result.queueWait), show(result.frameInterval), Math.round(result.bufferBytes?.median ?? 0).toLocaleString() + ' B']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    byId('results').prepend(row); byId('status').textContent = cancelled ? 'Stopped. Partial measured results are shown.' : 'Measurement complete. Export includes raw samples and actual selected backend.';
  } catch (cause) { byId('status').textContent = 'Measurement failed: ' + cause.message; }
  finally { busy = false; byId('run').disabled = false; byId('stop').disabled = true; byId('semantic').disabled = false; }
};
byId('semantic').onclick = async () => {
  semanticOverlay?.dispose(); renderer?.dispose();
  renderer = new WorkspaceRenderer(byId('canvas'), {onStatus: status => { byId('status').textContent = 'Standalone scene: ' + status.backend; }}); await renderer.init();
  const tree = {id: 'root', style: {padding: 24, gap: 18, background: '#f9f7fc'}, children: [{id: 'intro', type: 'text', text: 'Independent scene layout · keyboard and IME editing', style: {fontSize: 24}}, {id: 'label', type: 'text', text: 'Message — الرسالة — メッセージ', style: {fontSize: 16}}, {id: 'editor', role: 'textbox', editable: true, multiline: true, label: 'Message', text: 'Try typing 日本語, العربية, or 👩🏽‍💻', style: {fontSize: 18, height: 140, padding: 12, background: '#fff', radius: 8}}, {id: 'send', role: 'button', label: 'Preview message', text: 'Preview message', style: {fontSize: 16, width: 200, height: 44, padding: 10, background: '#d6c6ec', radius: 8}}]};
  const state = new RetainedScene(tree, {width: 1100, height: 650, measurer: new TextMeasurer()});
  semanticOverlay = new SemanticOverlay(byId('stage'), {onInput(id, value) { state.update(id, {text: value, value}); refresh(); }, onActivate() { byId('status').textContent = state.find('editor').text; }});
  function refresh() { const scene = state.layout(); renderer.render(scene); semanticOverlay.sync(scene); }
  refresh(); byId('status').textContent = 'Canvas layout is independent of DOM layout. Tab to the native text editor; IME composition and focus remain browser-managed.';
};
// Expose the pure scene constructor for browser profiling without synthetic results.
export {makeScene, layoutScene};
