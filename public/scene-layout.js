import {flowText, TextMeasurer} from './scene-text.js';
import {intersectClip, hitTestScene} from './gpu-workspace.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const edges = value => {
  const values = Array.isArray(value) ? value : [finite(value)];
  return [values[0] || 0, values[1] ?? values[0] ?? 0, values[2] ?? values[0] ?? 0, values[3] ?? values[1] ?? values[0] ?? 0];
};
const length = (value, available, fallback) => typeof value === 'string' && value.endsWith('%') ? finite(parseFloat(value)) * available / 100 : value === undefined || value === 'auto' ? fallback : finite(value, fallback);
const bounded = (value, min, max) => Math.max(finite(min), Math.min(max === undefined ? Infinity : finite(max, Infinity), value));

/** Small explicit scene layout vocabulary, independent of DOM layout and browser CSS. */
export function layoutScene(tree, {width = 1000, height = 700, measureText, measurer, background = '#ffffff', dpr} = {}) {
  const owned = !measureText && !measurer ? new TextMeasurer() : null;
  const measure = measureText || (measurer || owned).measure;
  const items = [], nodes = new Map(), semantics = [], identifiers = new Set(), viewport = {x: 0, y: 0, width, height};
  const intrinsic = (node, available, inherited) => {
    const style = {...inherited, ...node.style}, [pt, pr, pb, pl] = edges(style.padding);
    const w = bounded(length(style.width, available, available), style.minWidth, style.maxWidth);
    if (node.type === 'text' || node.text !== undefined && !node.children?.length) {
      const flow = flowText(node.text || '', {...style, width: Math.max(0, w - pl - pr)}, measure);
      return {width: w, height: length(style.height, height, flow.height + pt + pb)};
    }
    return {width: w, height: length(style.height, height, finite(style.minHeight, 0) + pt + pb)};
  };
  const visit = (node, allocation, inherited, parentClip, parentShapes) => {
    if (!node || node.style?.display === 'none') return {height: 0, width: 0};
    if (node.id !== undefined && identifiers.has(node.id)) throw new Error('Scene node IDs must be unique: ' + node.id);
    if (node.id !== undefined) identifiers.add(node.id);
    const style = {...inherited, ...node.style}, [pt, pr, pb, pl] = edges(node.style?.padding), {x, y} = allocation;
    const w = bounded(length(node.style?.width, allocation.width, allocation.width), node.style?.minWidth, node.style?.maxWidth);
    let h = length(node.style?.height, allocation.height, allocation.forcedHeight);
    const contentWidth = Math.max(0, w - pl - pr), gap = finite(node.style?.gap), paddingTop = pt;
    const itemStart = items.length, ownItems = [], children = [...(node.children || [])].filter(child => child.style?.display !== 'none');
    const shapes = [...parentShapes];
    const provisional = {x, y, width: w, height: h ?? allocation.height};
    const clip = h !== undefined && (node.style?.overflow === 'hidden' || node.style?.overflow === 'scroll') ? intersectClip(parentClip, provisional) : parentClip;
    const groupOpacity = (inherited.opacity ?? 1) * (node.style?.opacity ?? 1); style.opacity = groupOpacity;
    const common = {id: node.id, clip, clipShapes: shapes, interactive: node.interactive === true || !!node.onActivate || !!node.role, opacity: groupOpacity};
    if (node.style?.background) ownItems.push({...common, type: 'rect', x, y, width: w, height: h || 0, radius: finite(node.style.radius), color: node.style.background});
    if (node.type === 'image' && node.image) ownItems.push({...common, type: 'image', image: node.image, imageRevision: node.imageRevision, x: x + pl, y: y + pt, width: contentWidth, height: Math.max(0, (h ?? node.image.height ?? 0) - pt - pb)});
    const inheritable = {};
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'letterSpacing', 'wordSpacing', 'direction', 'lang', 'lineHeight', 'color', 'opacity']) if (style[property] !== undefined) inheritable[property] = style[property];
    let contentHeight = 0;
    if (node.type === 'text' || node.text !== undefined && !children.length) {
      const flow = flowText(node.text || '', {...style, width: contentWidth}, measure); contentHeight = flow.height;
      for (let index = 0; index < flow.lines.length; index++) {
        const line = flow.lines[index];
        ownItems.push({...inheritable, ...common, id: node.id === undefined ? undefined : `${node.id}:line:${index}`, ownerId: node.id, type: 'text', text: line.text, x: x + pl + line.x, y: y + pt + line.y, width: line.width, height: line.height, baseline: line.baseline, color: style.color || '#17202e', textAlign: 'left'});
      }
    }
    // Parent paints first. Child stacking is local, stable and explicit, not a CSS z-index approximation.
    items.push(...ownItems);
    const childStart = items.length, arranged = [], innerX = x + pl - finite(node.style?.scrollX), innerY = y + pt - finite(node.style?.scrollY);
    const availableHeight = Math.max(0, (h ?? allocation.height) - pt - pb), layout = node.style?.layout || 'column';
    const addChild = (child, cx, cy, cw, ch) => {
      const start = items.length;
      const result = visit(child, {x: innerX + cx, y: innerY + cy, width: Math.max(0, cw), height: availableHeight, forcedHeight: ch}, inheritable, clip, shapes);
      arranged.push({index: arranged.length, z: finite(child.style?.zIndex), items: items.splice(start), result}); return result;
    };
    if (layout === 'row' || layout === 'flex') {
      let line = [], lines = [], used = 0;
      for (const child of children) {
        const basis = length(child.style?.basis ?? child.style?.width, contentWidth, child.style?.grow ? 0 : contentWidth / Math.max(1, children.length));
        if (node.style?.wrap && line.length && used + gap + basis > contentWidth) { lines.push(line); line = []; used = 0; }
        line.push({child, basis: bounded(basis, child.style?.minWidth, child.style?.maxWidth)}); used += basis + (line.length > 1 ? gap : 0);
      }
      if (line.length) lines.push(line);
      for (const row of lines) {
        const total = row.reduce((sum, value) => sum + value.basis, 0) + gap * Math.max(0, row.length - 1), free = contentWidth - total;
        const grow = row.reduce((sum, value) => sum + finite(value.child.style?.grow), 0), shrink = row.reduce((sum, value) => sum + value.basis * finite(value.child.style?.shrink, 1), 0);
        let cx = node.style?.justify === 'center' && free > 0 && !grow ? free / 2 : node.style?.justify === 'end' && free > 0 && !grow ? free : 0;
        const space = node.style?.justify === 'space-between' && free > 0 && !grow && row.length > 1 ? gap + free / (row.length - 1) : gap;
        const measures = row.map(value => {
          const extra = free >= 0 ? grow ? free * finite(value.child.style?.grow) / grow : 0 : shrink ? free * value.basis * finite(value.child.style?.shrink, 1) / shrink : 0;
          const cw = bounded(value.basis + extra, value.child.style?.minWidth, value.child.style?.maxWidth);
          return {...value, width: cw, height: intrinsic(value.child, cw, inheritable).height};
        });
        const rowHeight = Math.max(0, ...measures.map(value => value.height), lines.length === 1 && h !== undefined ? availableHeight : 0);
        let measuredHeight = 0;
        for (const value of measures) {
          const align = value.child.style?.alignSelf || node.style?.align || 'start';
          const cy = contentHeight + (align === 'center' ? Math.max(0, (rowHeight - value.height) / 2) : align === 'end' ? Math.max(0, rowHeight - value.height) : 0);
          const result = addChild(value.child, cx, cy, value.width, align === 'stretch' ? rowHeight : undefined); measuredHeight = Math.max(measuredHeight, result.height); cx += value.width + space;
        }
        contentHeight += Math.max(rowHeight, measuredHeight) + gap;
      }
      contentHeight = Math.max(0, contentHeight - gap);
    } else if (layout === 'grid') {
      const definition = node.style?.columns || ['1fr', '1fr'], tracks = typeof definition === 'number' ? Array.from({length: Math.max(1, definition)}, () => '1fr') : definition;
      const fractions = tracks.map(track => typeof track === 'string' && track.endsWith('fr') ? Math.max(0, parseFloat(track) || 1) : 0), fixed = tracks.reduce((sum, track, index) => sum + (fractions[index] ? 0 : length(track, contentWidth, 0)), 0);
      const remaining = Math.max(0, contentWidth - fixed - gap * Math.max(0, tracks.length - 1)), sum = fractions.reduce((a, b) => a + b, 0);
      const widths = tracks.map((track, index) => fractions[index] ? remaining * fractions[index] / sum : length(track, contentWidth, 0));
      for (let index = 0; index < children.length; index += tracks.length) {
        let cx = 0, rowHeight = 0;
        for (let column = 0; column < tracks.length && children[index + column]; column++) {
          const result = addChild(children[index + column], cx, contentHeight, widths[column]); rowHeight = Math.max(rowHeight, result.height); cx += widths[column] + gap;
        }
        contentHeight += rowHeight + gap;
      }
      contentHeight = Math.max(0, contentHeight - gap);
    } else {
      let cy = 0;
      for (const child of children) {
        const result = addChild(child, finite(child.style?.x), layout === 'stack' ? finite(child.style?.y) : cy, length(child.style?.width, contentWidth, contentWidth));
        contentHeight = Math.max(contentHeight, (layout === 'stack' ? finite(child.style?.y) : cy) + result.height);
        if (layout !== 'stack') cy += result.height + gap;
      }
    }
    arranged.sort((a, b) => a.z - b.z || a.index - b.index); for (const entry of arranged) items.push(...entry.items);
    h = bounded(h ?? contentHeight + paddingTop + pb, node.style?.minHeight, node.style?.maxHeight);
    const bounds = {x, y, width: w, height: h};
    if (node.style?.overflow === 'hidden' || node.style?.overflow === 'scroll') {
      const finalClip = intersectClip(parentClip, bounds), rounded = finite(node.style?.radius) ? {...bounds, radius: finite(node.style.radius)} : null;
      for (let index = itemStart; index < items.length; index++) { items[index].clip = intersectClip(items[index].clip, finalClip); if (rounded && index >= childStart) items[index].clipShapes = [...items[index].clipShapes, rounded]; }
    }
    if (ownItems[0]?.type === 'rect') ownItems[0].height = h;
    if (node.id !== undefined) {
      nodes.set(node.id, {node, bounds, contentHeight: contentHeight + pt + pb, clip: intersectClip(parentClip, bounds)});
      if (node.role || node.label || node.editable) semantics.push({id: node.id, role: node.role || (node.editable ? 'textbox' : 'group'), label: node.label || node.text || '', ...bounds, clip: intersectClip(parentClip, bounds), value: node.value ?? node.text, editable: node.editable, multiline: node.multiline, disabled: node.disabled, checked: node.checked, pressed: node.pressed, onActivate: node.onActivate, onInput: node.onInput, tabIndex: node.tabIndex});
      if (common.interactive && !items.slice(itemStart).some(item => item.id === node.id)) items.splice(itemStart, 0, {...common, ...bounds, type: 'rect', color: [0, 0, 0, 0]});
    }
    return bounds;
  };
  visit(tree, {...viewport, forcedHeight: tree.style?.height === undefined ? height : undefined}, {}, viewport, []);
  const order = new Map(); items.forEach((item, index) => order.set(item.ownerId ?? item.id, index));
  semantics.sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
  return {width, height, dpr, background, items, nodes, semantics};
}

/** Transactional retained scene updates with stable IDs and explicit invalidation. */
export class RetainedScene {
  constructor(tree, options = {}) { this.tree = structuredCloneScene(tree); this.options = options; this.version = 0; this.layoutVersion = -1; this.dirty = new Set(); }
  find(id, node = this.tree) { if (node.id === id) return node; for (const child of node.children || []) { const found = this.find(id, child); if (found) return found; } return null; }
  update(id, patch) { const node = this.find(id); if (!node) throw new Error('Unknown scene node: ' + id); Object.assign(node, patch, patch.style ? {style: {...node.style, ...patch.style}} : {}); this.dirty.add(id); this.version++; return this; }
  resize(width, height) { if (this.options.width !== width || this.options.height !== height) { Object.assign(this.options, {width, height}); this.version++; } return this; }
  layout() { if (this.layoutVersion !== this.version) { this.scene = layoutScene(this.tree, this.options); this.layoutVersion = this.version; this.dirty.clear(); } return this.scene; }
  hitTest(x, y) { const hit = hitTestScene(this.layout(), x, y); return hit ? this.find(hit.ownerId ?? hit.id) : null; }
  render(renderer) { return renderer.render(this.layout()); }
}
function structuredCloneScene(node) { return {...node, style: {...node.style}, children: node.children?.map(structuredCloneScene)}; }

/** Real focusable semantic controls and native IME editors over a standalone scene canvas. */
export class SemanticOverlay {
  constructor(container, {onActivate = () => {}, onInput = () => {}} = {}) {
    this.container = container; this.document = container.ownerDocument; this.onActivate = onActivate; this.onInput = onInput; this.controls = new Map();
    this.layer = this.document.createElement('div'); this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none'; container.append(this.layer);
  }
  sync(scene) {
    const present = new Set();
    for (const semantic of scene.semantics || []) {
      present.add(semantic.id); let control = this.controls.get(semantic.id);
      const tag = semantic.editable ? semantic.multiline ? 'textarea' : 'input' : semantic.role === 'button' ? 'button' : 'div';
      if (control?.localName !== tag) { control?.remove(); control = null; }
      if (!control) {
        control = this.document.createElement(tag); control.dataset.sceneId = String(semantic.id); control.style.cssText = 'position:absolute;box-sizing:border-box;border:0;margin:0;padding:0;background:transparent;color:transparent;pointer-events:auto;outline-offset:2px;';
        control.addEventListener('focus', () => { control.style.outline = '2px solid Highlight'; if (control._semantic.editable) { control.style.background = 'Canvas'; control.style.color = 'CanvasText'; } });
        control.addEventListener('blur', () => { control.style.outline = ''; control.style.background = 'transparent'; control.style.color = 'transparent'; });
        control.addEventListener('compositionstart', () => { control._composing = true; });
        control.addEventListener('compositionend', () => { control._composing = false; this.input(control); });
        control.addEventListener('input', () => { if (!control._composing) this.input(control); });
        control.addEventListener('click', event => { if (!control._semantic.disabled && !control._semantic.editable) { control._semantic.onActivate?.(event); this.onActivate(control._semantic.id, event); } });
        control.addEventListener('keydown', event => { if (tag !== 'button' && !control._semantic.editable && ['Enter', ' '].includes(event.key)) { event.preventDefault(); control.click(); } });
        this.controls.set(semantic.id, control); this.layer.append(control);
      }
      control._semantic = semantic; control.style.pointerEvents = semantic.editable || semantic.onActivate || ['button', 'checkbox', 'link', 'menuitem', 'tab'].includes(semantic.role) ? 'auto' : 'none'; control.setAttribute('role', semantic.role); control.setAttribute('aria-label', semantic.label); control.tabIndex = semantic.disabled ? -1 : semantic.tabIndex ?? (semantic.editable || ['button', 'checkbox', 'link', 'menuitem', 'tab'].includes(semantic.role) ? 0 : -1);
      control.setAttribute('aria-disabled', String(!!semantic.disabled)); if ('disabled' in control) control.disabled = !!semantic.disabled;
      for (const property of ['checked', 'pressed']) if (semantic[property] !== undefined) control.setAttribute('aria-' + property, String(semantic[property])); else control.removeAttribute('aria-' + property);
      for (const property of ['width', 'height']) control.style[property] = Math.max(0, semantic[property]) + 'px'; control.style.left = semantic.x + 'px'; control.style.top = semantic.y + 'px';
      if (semantic.clip) {
        const clip = semantic.clip; control.style.clipPath = `inset(${Math.max(0, clip.y - semantic.y)}px ${Math.max(0, semantic.x + semantic.width - clip.x - clip.width)}px ${Math.max(0, semantic.y + semantic.height - clip.y - clip.height)}px ${Math.max(0, clip.x - semantic.x)}px)`;
        if (!clip.width || !clip.height) { control.tabIndex = -1; control.setAttribute('aria-hidden', 'true'); } else control.removeAttribute('aria-hidden');
      }
      if (semantic.editable && !control._composing && this.document.activeElement !== control && control.value !== String(semantic.value ?? '')) control.value = semantic.value ?? '';
    }
    for (const [id, control] of this.controls) if (!present.has(id)) { control.remove(); this.controls.delete(id); }
  }
  input(control) { control._semantic.onInput?.(control.value); this.onInput(control._semantic.id, control.value); }
  focus(id) { this.controls.get(id)?.focus(); }
  dispose() { this.layer.remove(); this.controls.clear(); }
}
