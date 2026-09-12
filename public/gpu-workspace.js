import {configureText} from './scene-text.js';

export function intersectClip(a, b) {
  if (!a) return b ? {...b} : null;
  if (!b) return {...a};
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)};
}
export function normalizeScene(scene = {}) {
  const width = Math.max(1, Number(scene.width) || 1), height = Math.max(1, Number(scene.height) || 1), viewport = {x: 0, y: 0, width, height};
  return {...scene, width, height, items: (scene.items || []).map(item => ({...item, x: Number(item.x) || 0, y: Number(item.y) || 0, width: Math.max(0, Number(item.width) || 0), height: Math.max(0, Number(item.height) || 0), radius: Math.max(0, Number(item.radius) || 0), clip: intersectClip(viewport, item.clip), clipShapes: (item.clipShapes || []).map(shape => ({...shape, radius: Math.max(0, Number(shape.radius) || 0)}))})).filter(item => item.clip.width > 0 && item.clip.height > 0 && item.opacity !== 0)};
}
export function containsPoint(rectangle, x, y) {
  if (x < rectangle.x || y < rectangle.y || x >= rectangle.x + rectangle.width || y >= rectangle.y + rectangle.height) return false;
  const radius = Math.min(rectangle.radius || 0, rectangle.width / 2, rectangle.height / 2);
  if (!radius) return true;
  const dx = Math.max(rectangle.x + radius - x, 0, x - rectangle.x - rectangle.width + radius), dy = Math.max(rectangle.y + radius - y, 0, y - rectangle.y - rectangle.height + radius);
  return dx * dx + dy * dy <= radius * radius;
}
export function hitTestScene(scene, x, y) {
  for (let i = (scene?.items?.length || 0) - 1; i >= 0; i--) {
    const item = scene.items[i];
    if (item.id !== undefined && item.interactive !== false && containsPoint(item, x, y) && (!item.clip || containsPoint(item.clip, x, y)) && (item.clipShapes || []).every(shape => containsPoint(shape, x, y))) return item;
  }
  return null;
}
export function colorChannels(value = '#000000') {
  if (typeof value === 'string') value = value.trim();
  if (value === 'transparent') return [0, 0, 0, 0];
  const rgb = typeof value === 'string' && value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].trim().split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3).map(channel => Math.max(0, Math.min(1, parseFloat(channel) / (channel.endsWith('%') ? 100 : 255)))).concat(parts[3] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1))));
  }
  if (/^#[\da-f]{4}$/i.test(value)) value = '#' + value.slice(1).split('').map(character => character + character).join('');
  if (Array.isArray(value)) return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1];
  if (/^#[\da-f]{3}$/i.test(value)) value = '#' + value.slice(1).split('').map(character => character + character).join('');
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) return [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255, value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1];
  return [0, 0, 0, 1];
}
export const cssColor = value => { const [r, g, b, a] = colorChannels(value); return `rgba(${r * 255},${g * 255},${b * 255},${a})`; };
export const workspaceShader = `
struct Instance { bounds: vec4f, color: vec4f, uv: vec4f, extra: vec4f };
struct Clip { bounds: vec4f, extra: vec4f };
struct Viewport { size: vec2f, padding: vec2f };
@group(0) @binding(0) var<storage, read> instances: array<Instance>;
@group(0) @binding(1) var<uniform> viewport: Viewport;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlasSampler: sampler;
@group(0) @binding(4) var<storage, read> clips: array<Clip>;
struct VertexOut { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) color: vec4f, @location(2) uv: vec2f, @location(3) size: vec2f, @location(4) @interpolate(flat) extra: vec4f, @location(5) world: vec2f };
@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOut {
 let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let unit = corners[vertexIndex]; let instance = instances[instanceIndex]; let pixel = instance.bounds.xy + unit * instance.bounds.zw;
 var out: VertexOut;
 out.position = vec4f(pixel.x / viewport.size.x * 2 - 1, 1 - pixel.y / viewport.size.y * 2, 0, 1);
 out.local = unit * instance.bounds.zw; out.size = instance.bounds.zw; out.color = instance.color;
 out.uv = instance.uv.xy + unit * instance.uv.zw; out.extra = instance.extra; out.world = pixel;
 return out;
}
fn edgeAlpha(point: vec2f, size: vec2f, requestedRadius: f32) -> f32 {
 let radius = min(requestedRadius, min(size.x, size.y) * 0.5);
 let q = abs(point - size * 0.5) - (size * 0.5 - radius);
 let distance = length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - radius;
 return 1 - smoothstep(-0.5, 0.5, distance);
}
@fragment fn fragment(in: VertexOut) -> @location(0) vec4f {
 let sampled = textureSample(atlas, atlasSampler, in.uv);
 var alpha = in.color.a * select(edgeAlpha(in.local, in.size, in.extra.x), sampled.a, in.extra.y > 0.5);
 for (var i = 0u; i < u32(in.extra.w); i++) {
   let clip = clips[u32(in.extra.z) + i];
   alpha *= edgeAlpha(in.world - clip.bounds.xy, clip.bounds.zw, clip.extra.x);
 }
 return vec4f(select(in.color.rgb, sampled.rgb, in.extra.y > 0.5), alpha);
}`;

/** Return only changed aligned spans, coalescing nearby changes to bound command overhead. */
export function dirtyBufferRanges(previous, current, stride = 16) {
  if (!previous || previous.length !== current.length) return current.length ? [{offset: 0, length: current.length}] : [];
  const ranges = []; let first = -1, last = -1;
  for (let index = 0; index < current.length; index += stride) {
    let changed = false;
    for (let offset = index; offset < Math.min(index + stride, current.length); offset++) if (previous[offset] !== current[offset]) { changed = true; break; }
    if (!changed) continue;
    if (first < 0) first = index;
    else if (index - last > stride * 4) { ranges.push({offset: first, length: last + stride - first}); first = index; }
    last = index;
  }
  if (first >= 0) ranges.push({offset: first, length: Math.min(current.length, last + stride) - first});
  return ranges;
}

/** Paged LRU cache of full browser-shaped runs and images; no per-codepoint text shaping. */
export class RunAtlas {
  constructor({size = 2048, maxPages = 8, createCanvas = () => document.createElement('canvas')} = {}) {
    this.size = size; this.maxPages = maxPages; this.createCanvas = createCanvas;
    this.pages = []; this.entries = new Map(); this.measurements = new Map(); this.images = new WeakMap(); this.nextImage = 1; this.frame = 0; this.hits = 0; this.misses = 0;
    this.measureCanvas = createCanvas(); this.measureContext = this.measureCanvas.getContext('2d', {alpha: true});
  }
  beginFrame() { this.frame++; this.hits = 0; this.misses = 0; }
  clear() { this.entries.clear(); this.measurements.clear(); for (const page of this.pages) this.reset(page); }
  reset(page) { page.context.clearRect(0, 0, page.size, page.size); page.x = 2; page.y = 2; page.row = 0; page.dirty = [{x: 0, y: 0, width: page.size, height: page.size}]; page.generation++; }
  pageFor(width, height) {
    if (width + 4 > this.size || height + 4 > this.size) throw new Error('A raster run exceeds the configured atlas page size');
    for (const page of this.pages) {
      if (page.x + width + 2 <= page.size && page.y + height + 2 <= page.size) return page;
      if (page.y + page.row + 4 + height <= page.size) { page.x = 2; page.y += page.row + 2; page.row = 0; return page; }
    }
    if (this.pages.length < this.maxPages) {
      const canvas = this.createCanvas(); canvas.width = canvas.height = this.size;
      const page = {index: this.pages.length, size: this.size, canvas, context: canvas.getContext('2d', {alpha: true}), generation: 0, used: -1}; this.reset(page); this.pages.push(page); return page;
    }
    const page = this.pages.filter(value => value.used !== this.frame).sort((a, b) => a.used - b.used)[0];
    if (!page) throw new Error('The visible scene exceeds the bounded raster cache');
    this.reset(page);
    for (const [key, entry] of this.entries) if (entry.page === page.index) this.entries.delete(key);
    return page;
  }
  cached(key) {
    const entry = this.entries.get(key);
    if (entry && this.pages[entry.page].generation === entry.generation) { this.pages[entry.page].used = this.frame; this.hits++; return entry; }
    this.misses++; return null;
  }
  allocate(key, width, height, draw, properties = {}) {
    const page = this.pageFor(width, height), x = page.x, y = page.y;
    draw(page.context, x, y);
    const value = {...properties, page: page.index, generation: page.generation, u: x / page.size, v: y / page.size, uw: width / page.size, vh: height / page.size};
    page.dirty.push({x, y, width, height}); page.x += width + 2; page.row = Math.max(page.row, height); page.used = this.frame;
    this.entries.set(key, value); return value;
  }
  image(source, width, height, dpr, revision = 0) {
    if (!this.images.has(source)) this.images.set(source, this.nextImage++);
    const w = Math.max(1, Math.ceil(width * dpr)), h = Math.max(1, Math.ceil(height * dpr));
    const key = `image:${this.images.get(source)}:${w}:${h}:${revision}`;
    return this.cached(key) || this.allocate(key, w, h, (context, x, y) => context.drawImage(source, x, y, w, h));
  }
  text(text, item, dpr) {
    const key = JSON.stringify(['text', text, item.fontFamily, item.fontSize, item.fontWeight, item.fontStyle, item.fontKerning, item.fontStretch, item.fontVariantCaps, item.direction, item.lang, item.letterSpacing, item.wordSpacing, cssColor(item.color), dpr]);
    const old = this.cached(key); if (old) return old;
    const context = this.measureContext, physicalSize = (item.fontSize || 14) * dpr;
    configureText(context, item, dpr);
    const measure = context.measureText(text), left = Math.ceil(measure.actualBoundingBoxLeft ?? 0), right = Math.ceil(measure.actualBoundingBoxRight ?? measure.width), ascent = Math.ceil(measure.actualBoundingBoxAscent ?? physicalSize * .8), descent = Math.ceil(measure.actualBoundingBoxDescent ?? physicalSize * .2);
    const width = Math.max(1, left + right + 4), height = Math.max(1, ascent + descent + 4);
    return this.allocate(key, width, height, (target, x, y) => {
      target.save(); configureText(target, item, dpr); target.fillStyle = cssColor(item.color); target.fillText(text, x + left + 2, y + ascent + 2); target.restore();
    }, {width: width / dpr, height: height / dpr, left: (left + 2) / dpr, ascent: (ascent + 2) / dpr, advance: measure.width / dpr});
  }
  textTiles(text, item, dpr) {
    const metricKey = JSON.stringify([text, item.fontFamily, item.fontSize, item.fontWeight, item.fontStyle, item.fontKerning, item.fontStretch, item.fontVariantCaps, item.direction, item.lang, item.letterSpacing, item.wordSpacing, dpr]);
    let measure = this.measurements.get(metricKey);
    if (!measure) { configureText(this.measureContext, item, dpr); measure = this.measureContext.measureText(text); this.measurements.set(metricKey, measure); if (this.measurements.size > 4096) this.measurements.delete(this.measurements.keys().next().value); }
    const size = (item.fontSize || 14) * dpr;
    const left = Math.ceil(measure.actualBoundingBoxLeft ?? 0), ascent = Math.ceil(measure.actualBoundingBoxAscent ?? size * .8);
    const width = Math.max(1, left + Math.ceil(measure.actualBoundingBoxRight ?? measure.width) + 4), height = Math.max(1, ascent + Math.ceil(measure.actualBoundingBoxDescent ?? size * .2) + 4);
    if (width + 4 <= this.size && height + 4 <= this.size) return [this.text(text, item, dpr)];
    // Shape the entire line once before tiling its pixels, preserving joins across tile edges.
    if (width > 32768 || height > 32768 || width * height > 33554432) throw new Error('Text raster exceeds the bounded 32-megapixel preparation surface');
    const key = JSON.stringify(['tile', text, item.fontFamily, item.fontSize, item.fontWeight, item.fontStyle, item.fontKerning, item.fontStretch, item.fontVariantCaps, item.direction, item.lang, item.letterSpacing, item.wordSpacing, cssColor(item.color), dpr]);
    const tiles = [], step = this.size - 8; let surface;
    for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
      const tileKey = `${key}:${x}:${y}`, cached = this.cached(tileKey);
      if (cached) { tiles.push(cached); continue; }
      if (!surface) {
        surface = this.createCanvas(); surface.width = width; surface.height = height;
        const context = surface.getContext('2d'); configureText(context, item, dpr); context.fillStyle = cssColor(item.color); context.fillText(text, left + 2, ascent + 2);
      }
      const tileWidth = Math.min(step, width - x), tileHeight = Math.min(step, height - y);
      const value = this.allocate(tileKey, tileWidth + 2, tileHeight + 2, (context, dx, dy) => {
        const sx = Math.max(0, x - 1), sy = Math.max(0, y - 1), sw = Math.min(width, x + tileWidth + 1) - sx, sh = Math.min(height, y + tileHeight + 1) - sy;
        context.drawImage(surface, sx, sy, sw, sh, dx + (sx === x ? 1 : 0), dy + (sy === y ? 1 : 0), sw, sh);
      }, {width: tileWidth / dpr, height: tileHeight / dpr, left: (left + 2 - x) / dpr, ascent: (ascent + 2 - y) / dpr, advance: measure.width / dpr});
      value.u += 1 / this.size; value.v += 1 / this.size; value.uw = tileWidth / this.size; value.vh = tileHeight / this.size; tiles.push(value);
    }
    return tiles;
  }
}

export class WorkspaceRenderer {
  constructor(canvas, {onStatus = () => {}, maxDpr = 3, atlasSize = 2048, maxAtlasPages = 8} = {}) {
    this.canvas = canvas; this.activeCanvas = canvas; this.onStatus = onStatus; this.maxDpr = maxDpr; this.atlasSize = atlasSize; this.maxAtlasPages = maxAtlasPages;
    this.backend = 'initializing'; this.scene = null; this.disposed = false; this.capacity = 0; this.clipCapacity = 0; this.lastMetrics = null; this.textures = []; this.groups = [];
    this.onFontsChanged = () => this.invalidate(); globalThis.document?.fonts?.addEventListener('loadingdone', this.onFontsChanged);
  }
  async init() {
    try {
      if (!globalThis.navigator?.gpu) throw new Error('WebGPU is unavailable');
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      if (!adapter) throw new Error('No WebGPU adapter');
      this.device = await adapter.requestDevice();
      if (this.disposed) { this.device.destroy(); return this; }
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('WebGPU canvas unavailable');
      this.format = navigator.gpu.getPreferredCanvasFormat(); this.context.configure({device: this.device, format: this.format, alphaMode: 'premultiplied'});
      const shaderModule = this.device.createShaderModule({code: workspaceShader});
      this.pipeline = await this.device.createRenderPipelineAsync({layout: 'auto', vertex: {module: shaderModule, entryPoint: 'vertex'}, fragment: {module: shaderModule, entryPoint: 'fragment', targets: [{format: this.format, blend: {color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'}, alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'}}}]}, primitive: {topology: 'triangle-list'}});
      if (this.disposed) { this.device.destroy(); return this; }
      this.atlas = new RunAtlas({size: Math.min(this.atlasSize, this.device.limits.maxTextureDimension2D), maxPages: this.maxAtlasPages});
      this.sampler = this.device.createSampler({magFilter: 'linear', minFilter: 'linear'});
      this.uniform = this.device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
      this.backend = 'webgpu';
      this.device.lost.then(info => { if (!this.disposed) { this.fallback('GPU device lost: ' + info.message); if (this.scene) this.render(this.scene); } });
      this.device.addEventListener('uncapturederror', event => { if (!this.disposed && this.backend === 'webgpu') { this.fallback(event.error.message); if (this.scene) this.render(this.scene); } });
      this.onStatus({backend: this.backend});
    } catch (cause) { if (!this.disposed) this.fallback(cause.message); }
    return this;
  }
  invalidate() { this.atlas?.clear(); this.previousData = null; if (this.scene && !this.disposed) this.render(this.scene); }
  fallback(reason) {
    if (this.backend === 'canvas2d') return;
    let context; try { context = this.canvas.getContext('2d'); } catch { /* Canvas contexts are immutable. */ }
    if (!context) {
      const fallback = document.createElement('canvas'); fallback.className = this.canvas.className; fallback.style.cssText = this.canvas.style.cssText; fallback.setAttribute('aria-hidden', 'true');
      this.canvas.insertAdjacentElement('afterend', fallback); this.canvas.hidden = true; this.activeCanvas = fallback; context = fallback.getContext('2d');
    }
    if (!context) throw new Error('Canvas 2D rendering is unavailable');
    this.context2d = context; this.backend = 'canvas2d'; this.onStatus({backend: this.backend, reason});
  }
  resize(scene) {
    const dpr = Math.min(this.maxDpr, Math.max(1, scene.dpr || globalThis.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(scene.width * dpr)), height = Math.max(1, Math.round(scene.height * dpr));
    if (this.activeCanvas.width !== width) this.activeCanvas.width = width;
    if (this.activeCanvas.height !== height) this.activeCanvas.height = height;
    this.activeCanvas.style.width = scene.width + 'px'; this.activeCanvas.style.height = scene.height + 'px'; return dpr;
  }
  buildInstances(scene, dpr) {
    const packed = [], batches = [], clips = []; let lastKey = '';
    this.atlas.beginFrame();
    const add = (item, bounds, uv, radius, textured, page = 0) => {
      const color = textured ? [1, 1, 1, item.opacity ?? 1] : colorChannels(item.color); if (!textured) color[3] *= item.opacity ?? 1;
      const clip = item.clip, key = `${page}:${clip.x}:${clip.y}:${clip.width}:${clip.height}`;
      if (key !== lastKey) { batches.push({clip, page, first: packed.length / 16, count: 0}); lastKey = key; }
      batches.at(-1).count++;
      const clipStart = clips.length / 8;
      for (const shape of item.clipShapes || []) clips.push(shape.x, shape.y, shape.width, shape.height, shape.radius || 0, 0, 0, 0);
      packed.push(...bounds, ...color, ...uv, radius, textured ? 1 : 0, clipStart, clips.length / 8 - clipStart);
    };
    for (const item of scene.items) {
      if (!visibleItem(item)) continue;
      if (item.type === 'image') {
        if (!item.image || !item.width || !item.height) continue;
        const image = this.atlas.image(item.image, item.width, item.height, dpr, item.imageRevision || 0);
        add(item, [item.x, item.y, item.width, item.height], [image.u, image.v, image.uw, image.vh], 0, true, image.page);
      } else if (item.type === 'text') {
        const size = item.fontSize || 14;
        String(item.text || '').split('\n').forEach((line, index) => {
          if (!line.trim()) return;
          for (const run of this.atlas.textTiles(line, item, dpr)) {
            const x = item.x + textOffset(item, run.advance), baseline = item.y + (item.baseline ?? size) + index * (item.lineHeight || size * 1.4);
            add(item, [x - run.left, baseline - run.ascent, run.width, run.height], [run.u, run.v, run.uw, run.vh], 0, true, run.page);
          }
        });
      } else if (item.width && item.height) add(item, [item.x, item.y, item.width, item.height], [0, 0, 0, 0], item.radius || 0, false);
    }
    if (!this.atlas.pages.length) this.atlas.pageFor(1, 1);
    return {data: new Float32Array(packed), clipData: new Float32Array(clips), batches};
  }
  ensureBuffer(name, capacityName, data) {
    if (data.byteLength <= this[capacityName] && this[name]) return false;
    this[name]?.destroy(); this[capacityName] = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, data.byteLength))));
    this[name] = this.device.createBuffer({size: this[capacityName], usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}); this.groups = []; return true;
  }
  uploadAtlas() {
    let bytes = 0;
    for (const page of this.atlas.pages) {
      if (!this.textures[page.index]) this.textures[page.index] = this.device.createTexture({size: [page.size, page.size], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
      // Merge uploads into one bounding region per page, preserving origin and alpha semantics.
      if (page.dirty.length) {
        const x = Math.min(...page.dirty.map(r => r.x)), y = Math.min(...page.dirty.map(r => r.y));
        const w = Math.max(...page.dirty.map(r => r.x + r.width)) - x, h = Math.max(...page.dirty.map(r => r.y + r.height)) - y;
        this.device.queue.copyExternalImageToTexture({source: page.canvas, origin: [x, y]}, {texture: this.textures[page.index], origin: [x, y], premultipliedAlpha: false}, [w, h]); bytes += w * h * 4; page.dirty = [];
      }
      if (!this.groups[page.index]) this.groups[page.index] = this.device.createBindGroup({layout: this.pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: this.instances}}, {binding: 1, resource: {buffer: this.uniform}}, {binding: 2, resource: this.textures[page.index].createView()}, {binding: 3, resource: this.sampler}, {binding: 4, resource: {buffer: this.clipBuffer}}]});
    }
    return bytes;
  }
  render(scene = this.scene) {
    if (this.disposed || !scene) return null;
    const started = performance.now(); this.scene = normalizeScene(scene);
    if (this.backend === 'initializing') return null;
    const dpr = this.resize(this.scene);
    try {
      if (this.backend === 'canvas2d') return this.render2d(this.scene, dpr, started);
      const {data, clipData, batches} = this.buildInstances(this.scene, dpr), device = this.device;
      const replaced = this.ensureBuffer('instances', 'capacity', data), replacedClips = this.ensureBuffer('clipBuffer', 'clipCapacity', clipData);
      let uploadedBytes = 0;
      for (const range of dirtyBufferRanges(replaced ? null : this.previousData, data)) { device.queue.writeBuffer(this.instances, range.offset * 4, data, range.offset, range.length); uploadedBytes += range.length * 4; }
      for (const range of dirtyBufferRanges(replacedClips ? null : this.previousClips, clipData, 8)) { device.queue.writeBuffer(this.clipBuffer, range.offset * 4, clipData, range.offset, range.length); uploadedBytes += range.length * 4; }
      this.previousData = data; this.previousClips = clipData;
      const viewportKey = this.scene.width + ':' + this.scene.height;
      if (this.viewportKey !== viewportKey) { device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.scene.width, this.scene.height, 0, 0])); this.viewportKey = viewportKey; uploadedBytes += 16; }
      const textureBytes = this.uploadAtlas(), encoder = device.createCommandEncoder(), background = colorChannels(this.scene.background || '#ffffff');
      const pass = encoder.beginRenderPass({colorAttachments: [{view: this.context.getCurrentTexture().createView(), clearValue: {r: background[0] * background[3], g: background[1] * background[3], b: background[2] * background[3], a: background[3]}, loadOp: 'clear', storeOp: 'store'}]});
      pass.setPipeline(this.pipeline);
      for (const batch of batches) {
        const x = Math.max(0, Math.floor(batch.clip.x * dpr)), y = Math.max(0, Math.floor(batch.clip.y * dpr)), right = Math.min(this.activeCanvas.width, Math.ceil((batch.clip.x + batch.clip.width) * dpr)), bottom = Math.min(this.activeCanvas.height, Math.ceil((batch.clip.y + batch.clip.height) * dpr));
        if (right <= x || bottom <= y) continue;
        pass.setBindGroup(0, this.groups[batch.page]); pass.setScissorRect(x, y, right - x, bottom - y); pass.draw(6, batch.count, 0, batch.first);
      }
      pass.end(); device.queue.submit([encoder.finish()]);
      const submitted = performance.now(), metrics = {backend: 'webgpu', cpuMs: submitted - started, queueMs: null, drawCalls: batches.length, primitives: data.length / 16, items: this.scene.items.length, dpr, uploadedBytes, textureBytes, atlasPages: this.atlas.pages.length, cacheHits: this.atlas.hits, cacheMisses: this.atlas.misses};
      metrics.queueDone = device.queue.onSubmittedWorkDone().then(() => { metrics.queueMs = performance.now() - submitted; return metrics.queueMs; }).catch(() => null);
      this.lastMetrics = metrics; return metrics;
    } catch (cause) {
      if (this.backend === 'canvas2d') { this.onStatus({backend: 'canvas2d', error: cause.message}); throw cause; }
      this.fallback(cause.message); return this.render(this.scene);
    }
  }
  render2d(scene, dpr, started) {
    const context = this.context2d; context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, scene.width, scene.height);
    context.fillStyle = cssColor(scene.background || '#ffffff'); context.fillRect(0, 0, scene.width, scene.height);
    let painted = 0;
    for (const item of scene.items) {
      if (!visibleItem(item)) continue;
      painted++; context.save(); context.beginPath(); context.rect(item.clip.x, item.clip.y, item.clip.width, item.clip.height); context.clip(); context.globalAlpha = item.opacity ?? 1;
      for (const shape of item.clipShapes || []) { context.beginPath(); roundedPath(context, shape); context.clip(); }
      context.fillStyle = cssColor(item.color);
      if (item.type === 'image') {
        if (item.image && item.width && item.height) context.drawImage(item.image, item.x, item.y, item.width, item.height);
      } else if (item.type === 'text') {
        configureText(context, item); const size = item.fontSize || 14;
        String(item.text || '').split('\n').forEach((line, index) => context.fillText(line, item.x + textOffset(item, context.measureText(line).width), item.y + (item.baseline ?? size) + index * (item.lineHeight || size * 1.4)));
      } else { context.beginPath(); roundedPath(context, item); context.fill(); }
      context.restore();
    }
    this.lastMetrics = {backend: 'canvas2d', cpuMs: performance.now() - started, queueMs: null, queueDone: Promise.resolve(null), drawCalls: painted, primitives: painted, items: scene.items.length, dpr, uploadedBytes: 0, textureBytes: 0, atlasPages: 0, cacheHits: 0, cacheMisses: 0}; return this.lastMetrics;
  }
  hitTest(x, y) { return hitTestScene(this.scene, x, y); }
  dispose() {
    this.disposed = true; this.instances?.destroy(); this.clipBuffer?.destroy(); this.uniform?.destroy(); for (const texture of this.textures) texture.destroy(); this.device?.destroy();
    globalThis.document?.fonts?.removeEventListener('loadingdone', this.onFontsChanged);
    if (this.activeCanvas !== this.canvas) { this.activeCanvas.remove(); this.canvas.hidden = false; }
    this.atlas?.entries.clear(); this.scene = null;
  }
}
function roundedPath(context, rectangle) {
  if (context.roundRect) context.roundRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height, Math.min(rectangle.radius || 0, rectangle.width / 2, rectangle.height / 2));
  else context.rect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
}
function textOffset(item, advance) {
  const align = item.textAlign || 'left';
  if (align === 'center') return ((item.width || advance) - advance) / 2;
  if (align === 'right' || align === 'end' && item.direction !== 'rtl' || align === 'start' && item.direction === 'rtl') return (item.width || advance) - advance;
  return 0;
}

function visibleItem(item) {
  if (item.type === 'text' && (!item.width || !item.height)) return true;
  return item.x + item.width > item.clip.x && item.y + item.height > item.clip.y && item.x < item.clip.x + item.clip.width && item.y < item.clip.y + item.clip.height;
}
