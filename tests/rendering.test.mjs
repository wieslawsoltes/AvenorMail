import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeScene, intersectClip, hitTestScene, colorChannels, WorkspaceRenderer} from '../public/gpu-workspace.js';

test('clipping intersects nested regions and removes fully clipped display items', () => {
  assert.deepEqual(intersectClip({x: 0, y: 0, width: 100, height: 80}, {x: 50, y: -10, width: 100, height: 30}), {x: 50, y: 0, width: 50, height: 20});
  const scene = normalizeScene({width: 200, height: 100, items: [{id: 'visible', x: 0, y: 0, width: 50, height: 40}, {id: 'clipped', clip: {x: 250, y: 0, width: 20, height: 20}}]});
  assert.equal(scene.items.length, 1); assert.equal(scene.items[0].clip.width, 200);
});

test('hit testing respects painter order, exact bounds, clipping and disabled interactions', () => {
  const scene = normalizeScene({width: 100, height: 100, items: [{id: 'back', x: 0, y: 0, width: 100, height: 100}, {id: 'front', x: 10, y: 10, width: 80, height: 80, clip: {x: 20, y: 20, width: 30, height: 30}}, {id: 'decorative', x: 0, y: 0, width: 100, height: 100, interactive: false}]});
  assert.equal(hitTestScene(scene, 25, 25).id, 'front');
  assert.equal(hitTestScene(scene, 15, 15).id, 'back');
  assert.equal(hitTestScene(scene, 50, 50).id, 'back');
  assert.equal(hitTestScene(scene, 100, 50), null);
});

test('colors support normalized RGBA and short/alpha hex consistently', () => {
  assert.deepEqual(colorChannels('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(colorChannels('#ff000080'), [1, 0, 0, 128 / 255]);
  assert.deepEqual(colorChannels([.1, .2, .3]), [.1, .2, .3, 1]);
});

test('normalizing retained input never changes caller-owned geometry', () => {
  const items = [{id: 'negative', x: '5', y: 0, width: -3, height: 10}];
  const scene = normalizeScene({width: 80, height: 60, items});
  assert.equal(scene.items[0].x, 5); assert.equal(scene.items[0].width, 0);
  assert.equal(items[0].width, -3); assert.equal(items[0].x, '5');
});

test('computed DOM colors including rgb, rgba and percentage alpha are preserved', () => {
  assert.deepEqual(colorChannels('rgb(255, 0, 128)'), [1, 0, 128 / 255, 1]);
  assert.deepEqual(colorChannels('rgba(0, 128, 255, 0.5)'), [0, 128 / 255, 1, .5]);
  assert.deepEqual(colorChannels('rgb(100% 0% 50% / 25%)'), [1, 0, .5, .25]);
  assert.deepEqual(colorChannels('transparent'), [0, 0, 0, 0]);
});

test('Canvas 2D rendering errors propagate once instead of recursively rendering', () => {
  let calls = 0;
  const context = {setTransform() {}, clearRect() {}, fillRect() { calls++; throw new Error('Canvas failed'); }};
  const canvas = {width: 0, height: 0, style: {}, getContext() { return context; }};
  const renderer = new WorkspaceRenderer(canvas);
  renderer.fallback('Test');
  assert.throws(() => renderer.render({width: 10, height: 10, items: []}), /Canvas failed/);
  assert.equal(calls, 1);
});

test('negative border radii clamp before reaching native Canvas 2D', () => {
  const scene = normalizeScene({width: 20, height: 20, items: [{type: 'rect', x: 0, y: 0, width: 10, height: 10, radius: -5}]});
  assert.equal(scene.items[0].radius, 0);
});
