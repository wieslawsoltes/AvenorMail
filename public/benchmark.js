import {WorkspaceRenderer} from './gpu-workspace.js';
const byId = id => document.getElementById(id);
let renderer, cancelled = false, busy = false;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const percentile = (values, fraction) => { const sorted = values.filter(value => value !== null && Number.isFinite(value)).sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2) + ' ms' : 'Unavailable'; };
function makeScene(count, kind) {
  const width = 1100, height = 650, items = [];
  for (let index = 0; index < count; index++) {
    const text = kind === 'text' || kind === 'mixed' && index % 2 === 1;
    const x = (index * 47) % (width - 100), y = (Math.floor(index / 20) * 29) % (height - 24);
    items.push(text ? {id: index, type: 'text', x, y, width: 90, height: 20, text: 'Mail ' + index % 100, fontSize: 12, color: '#493c64'} : {id: index, type: 'rect', x, y, width: 90, height: 22, radius: 5, color: index % 3 ? '#e6dff2' : '#bdded8'});
  }
  return {width, height, background: '#f9f7fc', items};
}
byId('stop').onclick = () => { cancelled = true; };
byId('run').onclick = async () => {
  if (busy) return;
  busy = true; cancelled = false; byId('run').disabled = true; byId('stop').disabled = false;
  const cpu = [], queue = [], intervals = [];
  try {
    renderer?.dispose();
    renderer = new WorkspaceRenderer(byId('canvas'), {onStatus: status => { byId('status').textContent = status.backend + (status.reason ? ': ' + status.reason : ''); }});
    if (byId('backend').value === 'canvas2d') renderer.fallback('Canvas 2D selected'); else await renderer.init();
    const count = Number(byId('count').value), scene = makeScene(count, byId('kind').value);
    let previous = null;
    for (let frame = 0; frame < 65 && !cancelled; frame++) {
      const timestamp = await nextFrame();
      // Modify retained items to avoid benchmarking an empty no-op path.
      scene.items[0].x = frame % 60;
      const metrics = renderer.render(scene);
      const queueMs = await metrics.queueDone;
      if (frame >= 5) { cpu.push(metrics.cpuMs); queue.push(queueMs); if (previous !== null) intervals.push(timestamp - previous); }
      previous = timestamp;
      byId('status').textContent = `${metrics.backend} · ${Math.max(0, frame - 4)}/60 measured frames · ${metrics.primitives.toLocaleString()} draw instances`;
    }
    const row = document.createElement('tr');
    for (const value of [renderer.backend, count.toLocaleString(), cpu.length, percentile(cpu, .5) + ' / ' + percentile(cpu, .95), percentile(queue, .5), percentile(intervals, .5)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    byId('results').prepend(row); byId('status').textContent = cancelled ? 'Stopped. Partial measured results are shown.' : 'Measurement complete. Compare backends using the same scene and browser window.';
  } catch (cause) { byId('status').textContent = 'Measurement failed: ' + cause.message; }
  finally { busy = false; byId('run').disabled = false; byId('stop').disabled = true; }
};
