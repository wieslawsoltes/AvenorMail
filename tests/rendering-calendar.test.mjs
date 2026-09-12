import test from 'node:test';
import assert from 'node:assert/strict';
import {CalendarRenderer} from '../public/renderer.js';
import {WorkspaceRenderer} from '../public/gpu-workspace.js';

function mockObserver(t) {
  const previous = globalThis.ResizeObserver, observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  t.after(() => { if (previous) globalThis.ResizeObserver = previous; else delete globalThis.ResizeObserver; });
  return observers;
}
const fakeCanvas = () => ({style: {width: '', height: '', visibility: ''}, clientWidth: 700, clientHeight: 650, parentElement: {}});

test('calendar retains pre-initialization geometry, resizes and restores CSS sizing', async t => {
  const observers = mockObserver(t), scenes = [];
  t.mock.method(WorkspaceRenderer.prototype, 'init', async function () { this.backend = 'canvas2d'; this.onStatus({backend: this.backend}); return this; });
  t.mock.method(WorkspaceRenderer.prototype, 'render', function (scene) { scenes.push(scene); this.activeCanvas.style.width = scene.width + 'px'; this.activeCanvas.style.height = scene.height + 'px'; });
  const canvas = fakeCanvas(), calendar = new CalendarRenderer(canvas), rectangles = [{x: 100, y: 60, w: 200, h: 2, color: [1, 0, 0, 1]}];
  calendar.draw(rectangles);
  assert.equal(scenes.length, 0);
  assert.equal(await calendar.initialize(), 'Canvas 2D');
  assert.equal(scenes.at(-1).items[0].width, 200);
  assert.equal(canvas.style.width, ''); assert.equal(canvas.style.height, '');
  canvas.clientWidth = 350; observers[0].callback();
  assert.equal(scenes.at(-1).items[0].x, 50); assert.equal(scenes.at(-1).items[0].width, 100);
  assert.equal(rectangles[0].w, 200);
  calendar.destroy(); assert.equal(observers[0].disconnected, true);
});

test('destroying a calendar while GPU initialization is pending prevents later drawing', async t => {
  const observers = mockObserver(t); let finish, renders = 0;
  t.mock.method(WorkspaceRenderer.prototype, 'init', () => new Promise(resolve => { finish = resolve; }));
  t.mock.method(WorkspaceRenderer.prototype, 'render', () => { renders++; });
  const calendar = new CalendarRenderer(fakeCanvas()), initialized = calendar.initialize();
  calendar.destroy(); finish(); await initialized;
  assert.equal(renders, 0); assert.equal(observers[0].disconnected, true);
});

test('a Canvas rendering error does not recursively reenter the calendar status callback', async t => {
  mockObserver(t); let renders = 0;
  t.mock.method(WorkspaceRenderer.prototype, 'init', async function () { this.backend = 'canvas2d'; this.onStatus({backend: this.backend}); return this; });
  t.mock.method(WorkspaceRenderer.prototype, 'render', function () { renders++; this.onStatus({backend: 'canvas2d', error: 'Canvas unavailable'}); throw new Error('Canvas unavailable'); });
  const calendar = new CalendarRenderer(fakeCanvas());
  await assert.rejects(calendar.initialize(), /Canvas unavailable/);
  await Promise.resolve();
  assert.equal(renders, 1);
  calendar.destroy();
});
