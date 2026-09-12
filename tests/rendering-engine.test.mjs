import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {RunAtlas, dirtyBufferRanges, containsPoint, WorkspaceRenderer, normalizeScene, hitTestScene} from '../public/gpu-workspace.js';
import {flowText, textSegments, configureText, TextMeasurer} from '../public/scene-text.js';
import {layoutScene, RetainedScene, SemanticOverlay} from '../public/scene-layout.js';

const measure = (text, style = {}) => ({width: textSegments(text).length * (style.fontSize || 10), ascent: 8, descent: 2});
function canvases() {
  const calls = [], contexts = [];
  const createCanvas = () => {
    const context = {font: '', direction: '', letterSpacing: '', wordSpacing: '', fillStyle: '', save() {}, restore() {}, clearRect() {}, drawImage(...args) { calls.push({type: 'image', args}); }, fillText(text, x, y) { calls.push({type: 'text', text, x, y, direction: this.direction, font: this.font, color: this.fillStyle}); }, measureText(text) { return {width: textSegments(text).length * 10, actualBoundingBoxLeft: 1, actualBoundingBoxRight: textSegments(text).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2}; }};
    contexts.push(context); return {width: 0, height: 0, getContext: () => context};
  };
  return {calls, contexts, createCanvas};
}

test('browser shaping receives one complete Arabic/emoji/ligature run and preserves atlas colors', () => {
  const fake = canvases(), atlas = new RunAtlas({size: 256, createCanvas: fake.createCanvas}); atlas.beginFrame();
  const text = 'مرحبا ffi 👩🏽‍💻', style = {fontSize: 18, color: '#147850', direction: 'rtl', fontWeight: 600};
  const result = atlas.textTiles(text, style, 1);
  assert.equal(result.length, 1); assert.equal(fake.calls.filter(value => value.type === 'text').length, 1);
  assert.equal(fake.calls[0].text, text); assert.equal(fake.calls[0].direction, 'rtl'); assert.equal(fake.calls[0].color, 'rgba(20,120,80,1)');
  atlas.beginFrame(); atlas.textTiles(text, style, 1); assert.equal(fake.calls.length, 1); assert.equal(atlas.hits, 1);
});

test('long text is shaped once then tiled at pixel boundaries without dividing the string', () => {
  const fake = canvases(), atlas = new RunAtlas({size: 64, maxPages: 8, createCanvas: fake.createCanvas}); atlas.beginFrame();
  const text = 'متواصل 👩🏽‍💻 متواصل 👩🏽‍💻', tiles = atlas.textTiles(text, {fontSize: 14, direction: 'rtl'}, 1);
  assert.ok(tiles.length > 1); assert.equal(fake.calls.filter(value => value.type === 'text').length, 1); assert.equal(fake.calls.find(value => value.type === 'text').text, text);
  assert.ok(tiles.every(tile => tile.width <= 56 && tile.height <= 56));
  assert.equal(tiles[0].left - tiles[1].left, 56);
  atlas.beginFrame(); atlas.textTiles(text, {fontSize: 14, direction: 'rtl'}, 1); assert.equal(fake.calls.filter(value => value.type === 'text').length, 1);
});

test('font scale, baseline, direction and letter/word spacing use the same physical DPI', () => {
  const fake = canvases(), context = fake.createCanvas().getContext('2d');
  configureText(context, {fontSize: 13, fontWeight: 'bold', fontStyle: 'italic', direction: 'rtl', letterSpacing: 1.5, wordSpacing: 2}, 2);
  assert.match(context.font, /italic bold 26px/); assert.equal(context.letterSpacing, '3px'); assert.equal(context.wordSpacing, '4px'); assert.equal(context.textBaseline, 'alphabetic'); assert.equal(context.textAlign, 'left');
  const atlas = new RunAtlas({size: 256, createCanvas: fake.createCanvas}); const at1 = atlas.text('hello', {fontSize: 13}, 1), at2 = atlas.text('hello', {fontSize: 13}, 2);
  assert.notEqual(at1, at2); assert.equal(at1.ascent, at2.ascent * 2);
});

test('paged atlas reuses resources and evicts old frames while protecting current draw references', () => {
  const fake = canvases(), atlas = new RunAtlas({size: 32, maxPages: 2, createCanvas: fake.createCanvas});
  atlas.beginFrame(); atlas.image({}, 24, 24, 1); atlas.image({}, 24, 24, 1);
  assert.equal(atlas.pages.length, 2); assert.throws(() => atlas.image({}, 24, 24, 1), /bounded raster cache/);
  atlas.beginFrame(); atlas.image({}, 24, 24, 1); assert.equal(atlas.pages.length, 2); assert.equal(atlas.entries.size, 2);
});

test('dirty upload spans skip identical arrays and isolate changed instance records', () => {
  const previous = new Float32Array(1600), current = previous.slice(); current[33] = 1; current[1550] = 2;
  assert.deepEqual(dirtyBufferRanges(previous, previous), []);
  assert.deepEqual(dirtyBufferRanges(previous, current), [{offset: 32, length: 16}, {offset: 1536, length: 16}]);
  assert.deepEqual(dirtyBufferRanges(null, current), [{offset: 0, length: 1600}]);
});

test('nested rounded clips reject transparent corner hits in painter order', () => {
  const scene = normalizeScene({width: 100, height: 100, items: [{id: 'back', x: 0, y: 0, width: 100, height: 100}, {id: 'round', x: 0, y: 0, width: 100, height: 100, clipShapes: [{x: 0, y: 0, width: 100, height: 100, radius: 40}]}]});
  assert.equal(hitTestScene(scene, 1, 1).id, 'back'); assert.equal(hitTestScene(scene, 50, 1).id, 'round'); assert.equal(containsPoint({x: 0, y: 0, width: 100, height: 100, radius: 40}, 0, 0), false);
});

test('grapheme-safe line wrapping and ellipsis preserve combining sequences and emoji joins', () => {
  const text = 'e\u0301👨‍👩‍👧‍👦🇵🇱', segments = textSegments(text);
  assert.equal(segments.length, 3); const wrapped = flowText(text, {width: 10}, measure);
  assert.deepEqual(wrapped.lines.map(value => value.text), segments);
  const clipped = flowText('alpha beta gamma', {width: 60, maxLines: 2}, measure); assert.equal(clipped.overflow, true); assert.equal(clipped.lines.length, 2); assert.ok(clipped.lines.at(-1).text.endsWith('…'));
});

test('wrap decisions measure contextual shaped substrings instead of summing glyph widths', () => {
  const measured = [], contextMeasure = text => { measured.push(text); return {width: text === 'ffi' ? 10 : text.length * 10, ascent: 8, descent: 2}; };
  const result = flowText('ffi', {width: 12}, contextMeasure); assert.equal(result.lines.length, 1); assert.equal(result.lines[0].text, 'ffi'); assert.ok(measured.includes('ffi'));
});

test('text measurement cache is bounded and can be invalidated after font loading', () => {
  const fake = canvases(), measurer = new TextMeasurer({context: fake.createCanvas().getContext('2d'), limit: 2});
  const one = measurer.measure('one'); assert.equal(measurer.measure('one'), one); measurer.measure('two'); measurer.measure('three'); assert.equal(measurer.cache.size, 2); measurer.clear(); assert.equal(measurer.cache.size, 0);
});

test('standalone grid allocates fixed and proportional tracks without using DOM layout', () => {
  const scene = layoutScene({id: 'root', style: {layout: 'grid', columns: [100, '1fr', '2fr'], gap: 10, padding: 10}, children: ['a', 'b', 'c'].map(id => ({id, type: 'text', text: 'hello', style: {fontSize: 10}}))}, {width: 450, height: 200, measureText: measure});
  assert.equal(scene.nodes.get('a').bounds.width, 100); assert.equal(scene.nodes.get('b').bounds.width, 310 / 3); assert.equal(scene.nodes.get('c').bounds.width, 620 / 3);
  assert.equal(scene.nodes.get('a').bounds.x, 10); assert.equal(scene.nodes.get('b').bounds.x, 120);
});

test('standalone flex growth and shrink allocation respect explicit geometry and padding', () => {
  const tree = {id: 'root', style: {layout: 'row', gap: 10, padding: 10}, children: [{id: 'sidebar', style: {width: 100, height: 40, shrink: 0}}, {id: 'body', style: {grow: 1, height: 40}}]};
  const scene = layoutScene(tree, {width: 500, height: 100, measureText: measure}); assert.equal(scene.nodes.get('body').bounds.width, 370); assert.equal(scene.nodes.get('body').bounds.x, 120);
});

test('retained scenes cache geometry until explicit changes and preserve local stacking in hit tests', () => {
  const tree = {id: 'root', style: {layout: 'stack'}, children: [{id: 'front', role: 'button', style: {width: 80, height: 80, zIndex: 2, background: '#f00'}}, {id: 'back', role: 'button', style: {width: 100, height: 100, background: '#0f0'}}]};
  const retained = new RetainedScene(tree, {width: 200, height: 100, measureText: measure}), initial = retained.layout();
  assert.equal(retained.layout(), initial); assert.equal(retained.hitTest(20, 20).id, 'front');
  retained.update('front', {style: {width: 10}}); assert.notEqual(retained.layout(), initial); assert.equal(retained.hitTest(20, 20).id, 'back'); assert.equal(tree.children[0].style.width, 80);
  assert.throws(() => layoutScene({id: 'same', children: [{id: 'same'}]}, {measureText: measure}), /unique/);
});

test('nested layout clipping propagates rounded masks through every child and tracks content overflow', () => {
  const scene = layoutScene({id: 'root', style: {width: 100, height: 50, overflow: 'scroll', radius: 10}, children: [{id: 'text', type: 'text', text: 'one two three four five six seven eight nine ten', style: {fontSize: 10}}]}, {width: 100, height: 50, measureText: measure});
  assert.ok(scene.nodes.get('root').contentHeight > 50); assert.ok(scene.items.every(item => item.clip.height <= 50)); assert.ok(scene.items.filter(item => item.type === 'text').every(item => item.clipShapes[0].radius === 10));
});

test('native semantic overlay keeps focus, selection and IME composition across scene updates', t => {
  const dom = new JSDOM('<div id="stage"></div>'); t.after(() => dom.window.close()); const inputs = [], activations = [];
  const overlay = new SemanticOverlay(dom.window.document.querySelector('#stage'), {onInput: (id, value) => inputs.push([id, value]), onActivate: id => activations.push(id)});
  const scene = {semantics: [{id: 'edit', role: 'textbox', editable: true, label: 'Message', value: 'start', x: 10, y: 20, width: 100, height: 30}, {id: 'send', role: 'button', label: 'Send', x: 120, y: 20, width: 60, height: 30}]};
  overlay.sync(scene); const input = overlay.controls.get('edit'); overlay.focus('edit'); input.setSelectionRange(1, 3);
  input.dispatchEvent(new dom.window.CompositionEvent('compositionstart')); input.value = '日本'; input.dispatchEvent(new dom.window.Event('input')); overlay.sync(scene);
  assert.equal(input.value, '日本'); assert.equal(inputs.length, 0); assert.equal(overlay.controls.get('edit'), input);
  input.dispatchEvent(new dom.window.CompositionEvent('compositionend')); assert.deepEqual(inputs, [['edit', '日本']]);
  overlay.controls.get('send').click(); assert.deepEqual(activations, ['send']); assert.equal(input.getAttribute('aria-label'), 'Message');
  overlay.sync({semantics: []}); assert.equal(overlay.controls.size, 0); overlay.dispose();
});

test('GPU instance packing keeps a shaped line as one quad and preserves nested clip data', () => {
  const fake = canvases(), renderer = new WorkspaceRenderer({}); renderer.atlas = new RunAtlas({size: 256, createCanvas: fake.createCanvas});
  const packed = renderer.buildInstances(normalizeScene({width: 200, height: 100, items: [{id: 't', type: 'text', text: 'ffi مرحبا 👩‍💻', x: 4, y: 5, width: 150, height: 20, clipShapes: [{x: 0, y: 0, width: 150, height: 40, radius: 6}]}]}), 1);
  assert.equal(packed.data.length, 16); assert.equal(packed.clipData.length, 8); assert.equal(packed.clipData[4], 6); assert.equal(packed.data[15], 1);
});
