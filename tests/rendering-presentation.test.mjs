import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {needsNativePresentation, svgMarkup, visibleClip, subtractRegions} from '../public/gpu-mode.js';

function fixture(t, markup) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`);
  for (const name of ['window', 'document', 'XMLSerializer', 'getComputedStyle']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value: dom.window[name]});
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  t.after(() => dom.window.close());
  return dom.window.document;
}

function geometry(element, {x, y, width, height}, client = {}) {
  element.getBoundingClientRect = () => ({x, y, width, height, left: x, top: y, right: x + width, bottom: y + height});
  const dimensions = {clientLeft: 0, clientTop: 0, clientWidth: width, clientHeight: height, ...client};
  for (const [name, value] of Object.entries(dimensions)) {
    Object.defineProperty(element, name, {configurable: true, value});
  }
}

function computedStyles(entries = new Map()) {
  return element => {
    const values = {overflow: 'visible', overflowX: 'visible', overflowY: 'visible', display: 'block', visibility: 'visible', ...entries.get(element)};
    return {
      ...values,
      getPropertyValue(name) {
        const camelCase = name.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
        return values[name] ?? values[camelCase] ?? '';
      },
    };
  };
}

test('native controls retain DOM presentation while focused inside the workspace', t => {
  const document = fixture(t, '<main id="root"><input><textarea></textarea><select><option>One</option></select><input type="checkbox"></main>');
  const root = document.querySelector('#root');
  for (const control of root.querySelectorAll('input, textarea, select')) {
    control.focus();
    assert.equal(needsNativePresentation(root), true, `${control.outerHTML} needs native focus and input behavior`);
  }
});

test('contenteditable text descendants require native presentation', t => {
  const document = fixture(t, '<main id="root"><div contenteditable="true"><span id="text">Editable</span></div><div contenteditable="plaintext-only" id="plain">Plain</div></main>');
  const root = document.querySelector('#root');
  assert.equal(needsNativePresentation(root, document.querySelector('#text')), true);
  assert.equal(needsNativePresentation(root, document.querySelector('#plain')), true);
});

test('keyboard focus on buttons and links retains native focus rings', t => {
  const document = fixture(t, '<main id="root"><button>Action</button><a href="#destination">Destination</a></main>');
  const root = document.querySelector('#root');
  for (const control of root.querySelectorAll('button, a')) {
    control.focus();
    assert.equal(needsNativePresentation(root, document.activeElement, true), true);
    assert.equal(needsNativePresentation(root, document.activeElement, false), false);
  }
});

test('inactive workspaces and controls focused outside the root keep GPU presentation', t => {
  const document = fixture(t, '<input id="outside"><main id="root"><button>Action</button><p>Message text</p></main>');
  const root = document.querySelector('#root');
  assert.equal(needsNativePresentation(root), false);
  root.querySelector('button').click();
  assert.equal(needsNativePresentation(root), false);
  document.querySelector('#outside').focus();
  assert.equal(needsNativePresentation(root, document.activeElement, true), false);
});

test('selected workspace text retains native selection, while collapsed and external ranges do not', t => {
  const document = fixture(t, '<main id="root"><p>Message text</p></main><aside>Outside text</aside>');
  const root = document.querySelector('#root');
  const selection = document.defaultView.getSelection();
  const range = document.createRange();
  range.setStart(root.querySelector('p').firstChild, 0);
  range.setEnd(root.querySelector('p').firstChild, 7);
  selection.addRange(range);
  assert.equal(needsNativePresentation(root), true);
  selection.collapseToEnd();
  assert.equal(needsNativePresentation(root), false);
  selection.removeAllRanges();
  range.selectNodeContents(document.querySelector('aside'));
  selection.addRange(range);
  assert.equal(needsNativePresentation(root), false);
});

test('visible embedded rendering surfaces retain native presentation', t => {
  const document = fixture(t, '<main id="root"></main>');
  const root = document.querySelector('#root');
  for (const tag of ['iframe', 'canvas', 'video', 'object']) {
    const embedded = document.createElement(tag);
    root.append(embedded);
    geometry(embedded, {x: 10, y: 20, width: 100, height: 60});
    assert.equal(needsNativePresentation(root), true, `${tag} must remain visible through its native renderer`);
    embedded.remove();
  }
});

test('hidden or zero-area embedded surfaces do not disable GPU presentation', t => {
  const document = fixture(t, '<main id="root"><iframe hidden></iframe><canvas style="display:none"></canvas><video></video><object></object></main>');
  const root = document.querySelector('#root');
  geometry(root.querySelector('video'), {x: 0, y: 0, width: 100, height: 0});
  geometry(root.querySelector('object'), {x: 0, y: 0, width: 0, height: 100});
  assert.equal(needsNativePresentation(root), false);
});

test('SVG serialization preserves actual geometry and standalone SVG namespace', t => {
  const document = fixture(t, '<main><svg viewBox="0 0 24 24" aria-label="Send"><g transform="translate(1 2)"><path d="M2 3 L18 10 L2 17 Z" fill="none" stroke="currentColor"/></g></svg></main>');
  const svg = document.querySelector('svg');
  const original = svg.outerHTML;
  const result = svgMarkup(svg, 48, 32, computedStyles());
  const parsed = new document.defaultView.DOMParser().parseFromString(result, 'image/svg+xml');
  assert.equal(parsed.querySelector('parsererror'), null);
  assert.equal(parsed.documentElement.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(parsed.documentElement.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(parsed.documentElement.getAttribute('width'), '48');
  assert.equal(parsed.documentElement.getAttribute('height'), '32');
  assert.equal(parsed.querySelector('g').getAttribute('transform'), 'translate(1 2)');
  assert.equal(parsed.querySelector('path').getAttribute('d'), 'M2 3 L18 10 L2 17 Z');
  assert.equal(parsed.querySelector('text'), null);
  assert.equal(svg.outerHTML, original, 'serializing an icon does not mutate the live workspace DOM');
});

test('SVG serialization resolves computed colors and stroke styling on each descendant', t => {
  const document = fixture(t, '<svg viewBox="0 0 20 20"><g><path id="line" d="M1 1 L19 19"/><circle id="dot" cx="10" cy="10" r="3"/></g></svg>');
  const svg = document.querySelector('svg');
  const line = document.querySelector('#line');
  const dot = document.querySelector('#dot');
  const styles = computedStyles(new Map([
    [svg, {color: 'rgb(1, 2, 3)', fill: 'none', stroke: 'rgb(1, 2, 3)'}],
    [svg.querySelector('g'), {color: 'rgb(10, 20, 30)', fill: 'none', stroke: 'rgb(10, 20, 30)', opacity: '0.75'}],
    [line, {color: 'rgb(10, 20, 30)', fill: 'none', stroke: 'currentColor', strokeWidth: '2px', strokeLinecap: 'round', strokeLinejoin: 'bevel', strokeDasharray: '4px, 2px', strokeOpacity: '0.5'}],
    [dot, {color: 'rgb(40, 50, 60)', fill: 'rgb(200, 100, 50)', stroke: 'none', fillOpacity: '0.6'}],
  ]));
  const parsed = new document.defaultView.DOMParser().parseFromString(svgMarkup(svg, 20, 20, styles), 'image/svg+xml');
  const read = (selector, property) => {
    const element = parsed.querySelector(selector);
    return element.style.getPropertyValue(property) || element.getAttribute(property);
  };
  assert.equal(read('svg', 'color'), 'rgb(1, 2, 3)');
  assert.equal(read('g', 'opacity'), '0.75');
  assert.equal(read('#line', 'stroke'), 'rgb(10, 20, 30)');
  assert.equal(read('#line', 'fill'), 'none');
  assert.equal(read('#line', 'stroke-width'), '2px');
  assert.equal(read('#line', 'stroke-linecap'), 'round');
  assert.equal(read('#line', 'stroke-linejoin'), 'bevel');
  assert.equal(read('#line', 'stroke-dasharray'), '4px, 2px');
  assert.equal(read('#line', 'stroke-opacity'), '0.5');
  assert.equal(read('#dot', 'fill'), 'rgb(200, 100, 50)');
  assert.equal(read('#dot', 'fill-opacity'), '0.6');
  assert.equal(read('#dot', 'stroke'), 'none');
});

test('visible overflow preserves the viewport clip instead of clipping to element bounds', t => {
  const document = fixture(t, '<main><p>Text can extend beyond this box</p></main>');
  const element = document.querySelector('p');
  const viewport = {x: 0, y: 0, width: 320, height: 240};
  geometry(element, {x: 50, y: 60, width: 20, height: 10});
  geometry(element.parentElement, {x: 40, y: 40, width: 100, height: 100});
  assert.deepEqual(visibleClip(element, viewport, computedStyles()), viewport);
});

test('overflow clipping respects separate axes across nested ancestors', t => {
  const document = fixture(t, '<main id="horizontal"><section id="vertical"><p>Clipped text</p></section></main>');
  const horizontal = document.querySelector('#horizontal');
  const vertical = document.querySelector('#vertical');
  geometry(horizontal, {x: 30, y: 15, width: 180, height: 30});
  geometry(vertical, {x: 5, y: 60, width: 20, height: 90});
  const styles = computedStyles(new Map([
    [horizontal, {overflowX: 'hidden', overflowY: 'visible'}],
    [vertical, {overflowX: 'visible', overflowY: 'auto'}],
  ]));
  assert.deepEqual(visibleClip(document.querySelector('p'), {x: 0, y: 0, width: 320, height: 240}, styles), {x: 30, y: 60, width: 180, height: 90});
});

test('overflow clips to the ancestor client area, excluding borders and scrollbar space', t => {
  const document = fixture(t, '<main><p>Clipped text</p></main>');
  const ancestor = document.querySelector('main');
  geometry(ancestor, {x: 20, y: 30, width: 140, height: 100}, {clientLeft: 3, clientTop: 5, clientWidth: 120, clientHeight: 80});
  const styles = computedStyles(new Map([[ancestor, {overflowX: 'scroll', overflowY: 'hidden'}]]));
  assert.deepEqual(visibleClip(document.querySelector('p'), {x: 0, y: 0, width: 320, height: 240}, styles), {x: 23, y: 35, width: 120, height: 80});
});

test('nested clips intersect the viewport and fully clipped content has no drawable area', t => {
  const document = fixture(t, '<main><section><p>Clipped text</p></section></main>');
  const outer = document.querySelector('main');
  const inner = document.querySelector('section');
  geometry(outer, {x: -10, y: 20, width: 100, height: 150});
  geometry(inner, {x: 50, y: -20, width: 100, height: 100});
  const styles = computedStyles(new Map([
    [outer, {overflowX: 'hidden', overflowY: 'hidden'}],
    [inner, {overflowX: 'clip', overflowY: 'clip'}],
  ]));
  const element = document.querySelector('p');
  const viewport = {x: 0, y: 0, width: 320, height: 240};
  assert.deepEqual(visibleClip(element, viewport, styles), {x: 50, y: 20, width: 40, height: 60});
  geometry(inner, {x: 150, y: 200, width: 100, height: 100});
  const clipped = visibleClip(element, viewport, styles);
  assert.ok(clipped == null || clipped.width === 0 || clipped.height === 0);
});

test('native control holes leave disjoint paint regions with exactly the remaining area', () => {
  const rectangle = {x: 10, y: 20, width: 100, height: 80};
  const holes = [
    {x: 30, y: 40, width: 30, height: 20},
    {x: 80, y: 70, width: 50, height: 50},
    {x: 200, y: 200, width: 10, height: 10},
  ];
  const pieces = subtractRegions(rectangle, holes);
  const intersectionArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  assert.equal(pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0), 8000 - 600 - 900);
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    assert.ok(piece.width > 0 && piece.height > 0);
    assert.equal(intersectionArea(piece, rectangle), piece.width * piece.height, 'every piece stays inside the original region');
    for (const hole of holes) assert.equal(intersectionArea(piece, hole), 0, 'native controls are never overpainted');
    for (const other of pieces.slice(index + 1)) assert.equal(intersectionArea(piece, other), 0, 'painting pieces cannot overlap');
  }
});

test('overlapping holes subtract their union once and complete coverage removes all paint', () => {
  const rectangle = {x: 0, y: 0, width: 100, height: 100};
  const pieces = subtractRegions(rectangle, [{x: 10, y: 10, width: 40, height: 40}, {x: 30, y: 30, width: 40, height: 40}]);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0), 10000 - 1600 - 1600 + 400);
  assert.deepEqual(subtractRegions(rectangle, [{x: -10, y: -10, width: 120, height: 120}]), []);
  assert.deepEqual(subtractRegions(rectangle, []), [rectangle]);
});
