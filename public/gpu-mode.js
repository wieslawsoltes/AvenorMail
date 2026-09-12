import {WorkspaceRenderer, colorChannels, intersectClip} from './gpu-workspace.js';

const box = rectangle => ({x: rectangle.x ?? rectangle.left ?? 0, y: rectangle.y ?? rectangle.top ?? 0, width: rectangle.width, height: rectangle.height});
const hasArea = rectangle => rectangle.width > 0 && rectangle.height > 0;
const visibleElement = element => {
  const rectangle = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return hasArea(rectangle) && style.display !== 'none' && style.visibility !== 'hidden';
};

/** Native editing, keyboard focus rings, selected text and embedded surfaces remain authoritative. */
export function needsNativePresentation(root, active = root.ownerDocument.activeElement, keyboardFocus = false) {
  if (active && root.contains(active)) {
    if (active.matches('input,select,textarea') || active.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')) return true;
    if (keyboardFocus && active.matches('button,a,[tabindex],[role="button"]')) return true;
  }
  const selection = root.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return true;
  return [...root.querySelectorAll('iframe,canvas,video,object,embed')].some(visibleElement);
}

/** Clip to each scroll/overflow ancestor's client area, keeping the two axes independent. */
export function visibleClip(element, viewport, getStyle = node => node.ownerDocument.defaultView.getComputedStyle(node)) {
  let clip = {...viewport};
  for (let ancestor = element.parentElement; ancestor && hasArea(clip); ancestor = ancestor.parentElement) {
    const style = getStyle(ancestor), rectangle = box(ancestor.getBoundingClientRect());
    const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow || 'visible');
    const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow || 'visible');
    if (!clipX && !clipY) continue;
    const client = {x: rectangle.x + ancestor.clientLeft, y: rectangle.y + ancestor.clientTop, width: ancestor.clientWidth, height: ancestor.clientHeight};
    clip = intersectClip(clip, {x: clipX ? client.x : clip.x, y: clipY ? client.y : clip.y, width: clipX ? client.width : clip.width, height: clipY ? client.height : clip.height});
  }
  return clip;
}

/** A standalone copy of the actual SVG, with computed paint styles resolved before rasterization. */
export function svgMarkup(element, width, height, getStyle = node => node.ownerDocument.defaultView.getComputedStyle(node)) {
  const clone = element.cloneNode(true);
  const originals = [element, ...element.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
  const paint = ['color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'vector-effect', 'paint-order', 'font-family', 'font-size', 'font-weight', 'font-style'];
  for (let index = 0; index < originals.length; index++) {
    const style = getStyle(originals[index]), target = copies[index];
    for (const property of paint) {
      let value = style.getPropertyValue(property);
      if (value) { if (/currentcolor/i.test(value)) value = value.replace(/currentcolor/ig, style.color || style.getPropertyValue('color')); target.style.setProperty(property, value); }
    }
    for (const attribute of [...target.attributes]) if (/^on/i.test(attribute.name)) target.removeAttribute(attribute.name);
  }
  clone.querySelectorAll('script').forEach(script => script.remove());
  clone.removeAttribute('xmlns');
  clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width)); clone.setAttribute('height', String(height));
  clone.style.width = width + 'px'; clone.style.height = height + 'px';
  if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return new element.ownerDocument.defaultView.XMLSerializer().serializeToString(clone);
}

/** Subtract native-control rectangles from a paint region; the real DOM shows through the holes. */
export function subtractRegions(rectangle, holes) {
  let regions = [rectangle];
  for (const hole of holes) {
    const next = [];
    for (const region of regions) {
      const overlap = intersectClip(region, hole);
      if (!hasArea(overlap)) { next.push(region); continue; }
      for (const piece of [
        {x: region.x, y: region.y, width: region.width, height: overlap.y - region.y},
        {x: region.x, y: overlap.y + overlap.height, width: region.width, height: region.y + region.height - overlap.y - overlap.height},
        {x: region.x, y: overlap.y, width: overlap.x - region.x, height: overlap.height},
        {x: overlap.x + overlap.width, y: overlap.y, width: region.x + region.width - overlap.x - overlap.width, height: overlap.height}
      ]) if (hasArea(piece)) next.push(piece);
    }
    regions = next;
  }
  return regions;
}

/** Experimental visible-workspace read layer; DOM controls and accessibility remain intact. */
export class GpuPresentation {
  constructor(root) {
    this.root = root; this.document = root.ownerDocument; this.window = this.document.defaultView;
    this.canvas = this.document.createElement('canvas'); this.canvas.className = 'gpu-presentation'; this.canvas.hidden = true; this.canvas.setAttribute('aria-hidden', 'true'); this.document.body.append(this.canvas);
    this.renderer = new WorkspaceRenderer(this.canvas, {onStatus: status => {
      if (status.error) { this.showNative('Native rendering: ' + status.error); return; }
      if (this.ready) this.schedule();
    }});
    this.icons = new Map(); this.ready = false; this.disposed = false; this.keyboardFocus = false; this.nativeReason = 'Initializing';
    this.observer = new this.window.ResizeObserver(() => this.schedule()); this.observer.observe(root);
    this.mutation = new this.window.MutationObserver(records => { if (records.some(record => record.target !== root || record.attributeName !== 'class')) this.schedule(); });
    this.mutation.observe(root, {childList: true, subtree: true, characterData: true, attributes: true});
    this.listeners = [];
    const listen = (target, event, handler, capture = true) => { target.addEventListener(event, handler, capture); this.listeners.push(() => target.removeEventListener(event, handler, capture)); };
    const refresh = () => this.schedule();
    listen(this.document, 'scroll', refresh);
    listen(this.window, 'resize', refresh);
    listen(this.document, 'focusin', () => this.updateNativeVisibility());
    listen(this.document, 'focusout', () => queueMicrotask(() => this.updateNativeVisibility()));
    listen(this.document, 'selectionchange', () => this.updateNativeVisibility());
    listen(this.document, 'keydown', event => { if (event.key === 'Tab' || event.key.startsWith('Arrow')) { this.keyboardFocus = true; this.updateNativeVisibility(); } });
    listen(this.document, 'pointerdown', () => { this.keyboardFocus = false; this.updateNativeVisibility(); });
    for (const event of ['pointerover', 'pointerout', 'input', 'change', 'load', 'transitionend', 'animationend']) listen(root, event, refresh);
    listen(this.window, 'beforeprint', () => this.showNative('Printing'));
    listen(this.window, 'afterprint', refresh);
    this.document.fonts?.ready.then(() => this.schedule());
  }
  async initialize() {
    await this.renderer.init();
    if (this.disposed) return this.renderer.backend;
    this.ready = true; this.schedule(); return this.renderer.backend;
  }
  showNative(reason) {
    this.nativeReason = reason;
    this.canvas.hidden = true;
    if (this.renderer.activeCanvas) this.renderer.activeCanvas.hidden = true;
    this.root.classList.remove('gpu-source');
  }
  updateNativeVisibility() {
    if (this.disposed) return;
    if (needsNativePresentation(this.root, this.document.activeElement, this.keyboardFocus)) this.showNative('Native interaction');
    else this.schedule();
  }
  schedule() {
    if (this.disposed || !this.ready) return;
    this.window.cancelAnimationFrame(this.frame);
    this.frame = this.window.requestAnimationFrame(() => this.draw());
  }
  icon(element, rectangle) {
    const scale = Math.min(this.window.devicePixelRatio || 1, 2), width = Math.max(1, Math.ceil(rectangle.width * scale)), height = Math.max(1, Math.ceil(rectangle.height * scale));
    const markup = svgMarkup(element, width, height), key = markup;
    const existing = this.icons.get(key);
    if (existing) return existing;
    const entry = {image: null, pending: true, error: null}; this.icons.set(key, entry);
    const image = new this.window.Image(), url = this.window.URL.createObjectURL(new Blob([markup], {type: 'image/svg+xml'}));
    image.onload = () => {
      try {
        if (!this.disposed) {
          const surface = this.document.createElement('canvas'); surface.width = width; surface.height = height;
          const context = surface.getContext('2d'); if (!context) throw Error('SVG rasterization is unavailable');
          context.drawImage(image, 0, 0, width, height); entry.image = surface;
        }
      } catch (cause) { entry.error = cause.message; }
      finally { entry.pending = false; this.window.URL.revokeObjectURL(url); this.schedule(); }
    };
    image.onerror = () => { entry.pending = false; entry.error = 'SVG icon could not be rasterized'; this.window.URL.revokeObjectURL(url); this.schedule(); };
    image.src = url;
    return entry;
  }
  draw() {
    if (this.disposed || !this.ready) return;
    if (needsNativePresentation(this.root, this.document.activeElement, this.keyboardFocus)) { this.showNative('Native interaction'); return; }
    try {
      const width = this.window.innerWidth, height = this.window.innerHeight, viewport = {x: 0, y: 0, width, height};
      const background = this.window.getComputedStyle(this.document.documentElement).getPropertyValue('--bg').trim() || '#f5f7fb';
      const items = [{type: 'rect', ...viewport, color: background, clip: viewport}], holes = [];
      let pending = false, unsupported = '';
      const color = (value, opacity) => { const rgba = colorChannels(value); rgba[3] *= opacity; return rgba; };
      const paintText = (node, style, opacity, clip) => {
        if (!node.textContent.trim()) return;
        const range = this.document.createRange(); let offset = 0;
        for (const word of node.textContent.match(/\S+\s*/g) || []) {
          const start = node.textContent.indexOf(word, offset); offset = start + word.length;
          range.setStart(node, start); range.setEnd(node, offset);
          if (range.getClientRects().length > 1) { unsupported = 'Complex text wrapping'; return; }
          const rectangle = box(range.getBoundingClientRect());
          if (!hasArea(intersectClip(rectangle, clip))) continue;
          const size = parseFloat(style.fontSize) || 14;
          let text = word.replace(/\s+/g, ' ');
          if (style.textTransform === 'uppercase') text = text.toUpperCase();
          if (style.textTransform === 'lowercase') text = text.toLowerCase();
          // Complex shaping/bidi stays in the native text engine.
          if (style.direction === 'rtl' || /[\u0590-\u0fff\u1100-\u11ff]/u.test(text)) { unsupported = 'Native text shaping'; return; }
          items.push({type: 'text', text, ...rectangle, height: Math.max(rectangle.height, size * 1.3), fontSize: size, fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontStyle: style.fontStyle, color: color(style.color, opacity), clip});
        }
      };
      const paintElement = (element, inheritedOpacity = 1) => {
        if (items.length > 16000 || unsupported) { unsupported ||= 'Scene size limit'; return; }
        const style = this.window.getComputedStyle(element), rectangle = box(element.getBoundingClientRect()), clip = visibleClip(element, viewport);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const opacity = inheritedOpacity * (parseFloat(style.opacity) || (style.opacity === '0' ? 0 : 1));
        if (!opacity) return;
        const visible = hasArea(intersectClip(rectangle, clip));
        if (visible) {
          if (style.backgroundImage && style.backgroundImage !== 'none' || style.filter && style.filter !== 'none') { unsupported = 'Native CSS effect'; return; }
          // A real form control is visible through a transparent hole in the read layer.
          if (element.matches('input,select,textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')) {
            holes.push(intersectClip({x: rectangle.x - 1, y: rectangle.y - 1, width: rectangle.width + 2, height: rectangle.height + 2}, clip)); return;
          }
          const fill = color(style.backgroundColor || 'transparent', opacity);
          if (fill[3]) items.push({type: 'rect', ...rectangle, color: fill, radius: parseFloat(style.borderRadius) || 0, clip});
          for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
            const size = parseFloat(style['border' + side + 'Width']) || 0;
            if (!size || style['border' + side + 'Style'] === 'none') continue;
            const horizontal = side === 'Top' || side === 'Bottom';
            items.push({type: 'rect', x: rectangle.x + (side === 'Right' ? rectangle.width - size : 0), y: rectangle.y + (side === 'Bottom' ? rectangle.height - size : 0), width: horizontal ? rectangle.width : size, height: horizontal ? size : rectangle.height, color: color(style['border' + side + 'Color'], opacity), clip});
          }
          if (element.localName === 'svg') {
            const cached = this.icon(element, rectangle);
            if (cached.error) unsupported = cached.error;
            else if (cached.pending) pending = true;
            else items.push({type: 'image', image: cached.image, ...rectangle, opacity: inheritedOpacity, clip});
            return;
          }
          if (element.localName === 'img') {
            if (!element.complete || !element.naturalWidth) { unsupported = 'Image loading'; return; }
            items.push({type: 'image', image: element, ...rectangle, opacity, clip}); return;
          }
          for (const pseudo of ['::before', '::after']) {
            const before = this.window.getComputedStyle(element, pseudo);
            if (!before.content || before.content === 'none' || before.content === 'normal' || before.display === 'none') continue;
            if (before.content !== '""' && before.content !== "''") { unsupported = 'Native generated text'; return; }
            if (before.position !== 'absolute') continue;
            const left = parseFloat(before.left), right = parseFloat(before.right), top = parseFloat(before.top), bottom = parseFloat(before.bottom);
            const w = parseFloat(before.width) || (Number.isFinite(left) && Number.isFinite(right) ? rectangle.width - left - right : 0), h = parseFloat(before.height) || (Number.isFinite(top) && Number.isFinite(bottom) ? rectangle.height - top - bottom : 0);
            if (w > 0 && h > 0) items.push({type: 'rect', x: rectangle.x + (Number.isFinite(left) ? left : rectangle.width - right - w), y: rectangle.y + (Number.isFinite(top) ? top : rectangle.height - bottom - h), width: w, height: h, radius: parseFloat(before.borderRadius) || 0, color: color(before.backgroundColor, opacity), clip});
          }
        }
        const children = [...element.childNodes].map((node, index) => ({node, index, layer: node.nodeType === 1 ? parseInt(this.window.getComputedStyle(node).zIndex) || 0 : 0})).sort((a, b) => a.layer - b.layer || a.index - b.index);
        for (const {node} of children) {
          if (node.nodeType === 1 && !['SCRIPT', 'STYLE', 'OPTION'].includes(node.tagName)) paintElement(node, opacity);
          else if (node.nodeType === 3 && visible) paintText(node, style, opacity, clip);
        }
      };
      paintElement(this.root);
      if (items.length > 16000) unsupported = 'Scene size limit';
      if (pending || unsupported) { this.showNative(unsupported || 'Preparing exact SVG icons'); return; }
      // Draw only outside native controls, leaving their actual browser pixels visible below.
      const display = [];
      for (const item of items) {
        const bounds = intersectClip(item, item.clip || viewport);
        for (const clip of subtractRegions(bounds, holes)) display.push({...item, clip});
      }
      this.renderer.render({width, height, background: '#00000000', items: display});
      this.renderer.activeCanvas.hidden = false;
      if (this.renderer.activeCanvas !== this.canvas) this.canvas.hidden = true;
      this.root.classList.add('gpu-source'); this.nativeReason = null;
    } catch (cause) { this.showNative('Native rendering: ' + cause.message); }
  }
  dispose() {
    this.disposed = true; this.window.cancelAnimationFrame(this.frame); this.observer.disconnect(); this.mutation.disconnect();
    for (const remove of this.listeners) remove();
    this.root.classList.remove('gpu-source'); this.renderer.dispose(); this.canvas.remove(); this.icons.clear();
  }
}
