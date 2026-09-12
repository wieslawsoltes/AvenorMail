/** Optional retained canvas read layer. Keep accessible content and native controls in the DOM. */
export function intersectClip(a, b) {
  if (!a) return b ? {...b} : null;
  if (!b) return {...a};
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)};
}
export function normalizeScene(scene = {}) {
  const width = Math.max(1, Number(scene.width) || 1), height = Math.max(1, Number(scene.height) || 1);
  const viewport = {x: 0, y: 0, width, height};
  return {...scene, width, height, items: (scene.items || []).map(item => ({...item, x: Number(item.x) || 0, y: Number(item.y) || 0, width: Math.max(0, Number(item.width) || 0), height: Math.max(0, Number(item.height) || 0), radius: Math.max(0, Number(item.radius) || 0), clip: intersectClip(viewport, item.clip)})).filter(item => item.clip.width > 0 && item.clip.height > 0)};
}
export function hitTestScene(scene, x, y) {
  const inside = rectangle => x >= rectangle.x && y >= rectangle.y && x < rectangle.x + rectangle.width && y < rectangle.y + rectangle.height;
  for (let i = (scene?.items?.length || 0) - 1; i >= 0; i--) {
    const item = scene.items[i];
    if (item.id !== undefined && item.interactive !== false && inside(item) && (!item.clip || inside(item.clip))) return item;
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
const cssColor = value => { const [r, g, b, a] = colorChannels(value); return `rgba(${r * 255},${g * 255},${b * 255},${a})`; };
const shader = `
struct Instance { bounds: vec4f, color: vec4f, uv: vec4f, extra: vec4f };
struct Viewport { size: vec2f, padding: vec2f };
@group(0) @binding(0) var<storage, read> instances: array<Instance>;
@group(0) @binding(1) var<uniform> viewport: Viewport;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlasSampler: sampler;
struct VertexOut { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) color: vec4f, @location(2) uv: vec2f, @location(3) size: vec2f, @location(4) extra: vec2f };
@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOut {
 let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let unit = corners[vertexIndex]; let instance = instances[instanceIndex]; let pixel = instance.bounds.xy + unit * instance.bounds.zw;
 var out: VertexOut;
 out.position = vec4f(pixel.x / viewport.size.x * 2 - 1, 1 - pixel.y / viewport.size.y * 2, 0, 1);
 out.local = unit * instance.bounds.zw; out.size = instance.bounds.zw; out.color = instance.color;
 out.uv = instance.uv.xy + unit * instance.uv.zw; out.extra = instance.extra.xy;
 return out;
}
@fragment fn fragment(in: VertexOut) -> @location(0) vec4f {
 let radius = min(in.extra.x, min(in.size.x, in.size.y) * 0.5);
 let q = abs(in.local - in.size * 0.5) - (in.size * 0.5 - radius);
 let distance = length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - radius;
 let edge = 1 - smoothstep(-0.75, 0.75, distance);
 let sampled = textureSample(atlas, atlasSampler, in.uv);
 let alpha = in.color.a * select(edge, sampled.a, in.extra.y > 0.5);
 return vec4f(select(in.color.rgb, sampled.rgb, in.extra.y > 1.5), alpha);
}`;

class GlyphAtlas {
  constructor(size = 2048) {
    this.size = size;
    this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = size;
    this.context = this.canvas.getContext('2d', {alpha: true});
    this.context.fillStyle = '#fff';
    this.entries = new Map(); this.images = new WeakMap(); this.x = 2; this.y = 2; this.rowHeight = 0; this.dirty = true;
  }
  image(source, width, height, dpr) {
    let sizes = this.images.get(source);
    if (!sizes) { sizes = new Map(); this.images.set(source, sizes); }
    const pixelWidth = Math.max(1, Math.ceil(width * dpr)), pixelHeight = Math.max(1, Math.ceil(height * dpr));
    const key = pixelWidth + ':' + pixelHeight;
    if (sizes.has(key)) return sizes.get(key);
    if (pixelWidth + 4 > this.size || pixelHeight + 4 > this.size) throw new Error('Image exceeds the GPU atlas; switching to Canvas 2D.');
    if (this.x + pixelWidth + 2 > this.size) { this.x = 2; this.y += this.rowHeight + 2; this.rowHeight = 0; }
    if (this.y + pixelHeight + 2 > this.size) throw new Error('Image atlas is full; switching to Canvas 2D.');
    this.context.drawImage(source, this.x, this.y, pixelWidth, pixelHeight);
    const entry = {u: this.x / this.size, v: this.y / this.size, uw: pixelWidth / this.size, vh: pixelHeight / this.size};
    sizes.set(key, entry); this.x += pixelWidth + 2; this.rowHeight = Math.max(this.rowHeight, pixelHeight); this.dirty = true;
    return entry;
  }
  glyph(character, font, size, dpr, weight = 'normal', style = 'normal') {
    const key = [character, font, size, dpr, weight, style].join('|');
    if (this.entries.has(key)) return this.entries.get(key);
    const context = this.context, physicalSize = Math.max(1, size * dpr);
    context.font = `${style} ${weight} ${physicalSize}px ${font}`;
    context.textBaseline = 'alphabetic';
    const measure = context.measureText(character), left = Math.ceil(measure.actualBoundingBoxLeft || 0), right = Math.ceil(measure.actualBoundingBoxRight || measure.width), ascent = Math.ceil(measure.actualBoundingBoxAscent || physicalSize * .8), descent = Math.ceil(measure.actualBoundingBoxDescent || physicalSize * .2);
    const width = Math.max(1, left + right + 4), height = Math.max(1, ascent + descent + 4);
    if (this.x + width > this.size) { this.x = 2; this.y += this.rowHeight + 2; this.rowHeight = 0; }
    if (this.y + height > this.size) throw new Error('Glyph atlas is full; switching to Canvas 2D.');
    context.fillText(character, this.x + left + 2, this.y + ascent + 2);
    const glyph = {u: this.x / this.size, v: this.y / this.size, uw: width / this.size, vh: height / this.size, width: width / dpr, height: height / dpr, left: (left + 2) / dpr, ascent: (ascent + 2) / dpr, advance: measure.width / dpr};
    this.entries.set(key, glyph); this.x += width + 2; this.rowHeight = Math.max(this.rowHeight, height); this.dirty = true;
    return glyph;
  }
}

export class WorkspaceRenderer {
  constructor(canvas, {onStatus = () => {}, maxDpr = 2} = {}) {
    this.canvas = canvas; this.activeCanvas = canvas; this.onStatus = onStatus; this.maxDpr = maxDpr;
    this.backend = 'initializing'; this.scene = null; this.disposed = false; this.capacity = 0; this.lastMetrics = null;
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
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({device: this.device, format: this.format, alphaMode: 'premultiplied'});
      const shaderModule = this.device.createShaderModule({code: shader});
      this.pipeline = await this.device.createRenderPipelineAsync({layout: 'auto', vertex: {module: shaderModule, entryPoint: 'vertex'}, fragment: {module: shaderModule, entryPoint: 'fragment', targets: [{format: this.format, blend: {color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'}, alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'}}}]}, primitive: {topology: 'triangle-list'}});
      if (this.disposed) { this.device.destroy(); return this; }
      this.atlas = new GlyphAtlas();
      this.texture = this.device.createTexture({size: [this.atlas.size, this.atlas.size], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
      this.sampler = this.device.createSampler({magFilter: 'linear', minFilter: 'linear'});
      this.uniform = this.device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
      this.backend = 'webgpu';
      this.device.lost.then(info => { if (!this.disposed) { this.fallback('GPU device lost: ' + info.message); if (this.scene) this.render(this.scene); } });
      this.device.addEventListener('uncapturederror', event => { if (!this.disposed && this.backend === 'webgpu') { this.fallback(event.error.message); if (this.scene) this.render(this.scene); } });
      this.onStatus({backend: this.backend});
    } catch (cause) { if (!this.disposed) this.fallback(cause.message); }
    return this;
  }
  fallback(reason) {
    if (this.backend === 'canvas2d') return;
    let context;
    try { context = this.canvas.getContext('2d'); } catch { /* Context type cannot change once WebGPU is selected. */ }
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
    this.activeCanvas.style.width = scene.width + 'px'; this.activeCanvas.style.height = scene.height + 'px';
    return dpr;
  }
  buildInstances(scene, dpr) {
    const packed = [], batches = [];
    let lastKey = '';
    const add = (item, bounds, uv, extras) => {
      const color = colorChannels(item.color), clip = item.clip, key = `${clip.x}:${clip.y}:${clip.width}:${clip.height}`;
      if (key !== lastKey) { batches.push({clip, first: packed.length / 16, count: 0}); lastKey = key; }
      batches[batches.length - 1].count++;
      packed.push(...bounds, ...color, ...uv, ...extras, 0, 0);
    };
    for (const item of scene.items) {
      if (item.type === 'image') {
        if (!item.image || !item.width || !item.height) continue;
        const image = this.atlas.image(item.image, item.width, item.height, dpr);
        add({...item, color: [1, 1, 1, item.opacity ?? 1]}, [item.x, item.y, item.width, item.height], [image.u, image.v, image.uw, image.vh], [0, 2]);
      } else if (item.type === 'text') {
        const size = item.fontSize || 14, font = item.fontFamily || 'system-ui, sans-serif';
        let x = item.x, baseline = item.y + size;
        for (const character of String(item.text || '')) {
          if (character === '\n') { x = item.x; baseline += item.lineHeight || size * 1.4; continue; }
          const glyph = this.atlas.glyph(character, font, size, dpr, item.fontWeight, item.fontStyle);
          if (character !== ' ') add(item, [x - glyph.left, baseline - glyph.ascent, glyph.width, glyph.height], [glyph.u, glyph.v, glyph.uw, glyph.vh], [0, 1]);
          x += glyph.advance;
        }
      } else if (item.width && item.height) add(item, [item.x, item.y, item.width, item.height], [0, 0, 0, 0], [item.radius || 0, 0]);
    }
    return {data: new Float32Array(packed), batches};
  }
  render(scene = this.scene) {
    if (this.disposed || !scene) return null;
    const started = performance.now();
    this.scene = normalizeScene(scene);
    if (this.backend === 'initializing') return null;
    const dpr = this.resize(this.scene);
    try {
      if (this.backend === 'canvas2d') return this.render2d(this.scene, dpr, started);
      const {data, batches} = this.buildInstances(this.scene, dpr), device = this.device;
      if (data.byteLength > this.capacity || !this.instances) {
        this.instances?.destroy(); this.capacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, data.byteLength))));
        this.instances = device.createBuffer({size: this.capacity, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
        this.bindGroup = device.createBindGroup({layout: this.pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: this.instances}}, {binding: 1, resource: {buffer: this.uniform}}, {binding: 2, resource: this.texture.createView()}, {binding: 3, resource: this.sampler}]});
      }
      if (data.length) device.queue.writeBuffer(this.instances, 0, data);
      device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.scene.width, this.scene.height, 0, 0]));
      if (this.atlas.dirty) { device.queue.copyExternalImageToTexture({source: this.atlas.canvas}, {texture: this.texture}, [this.atlas.size, this.atlas.size]); this.atlas.dirty = false; }
      const encoder = device.createCommandEncoder(), background = colorChannels(this.scene.background || '#ffffff');
      const pass = encoder.beginRenderPass({colorAttachments: [{view: this.context.getCurrentTexture().createView(), clearValue: {r: background[0], g: background[1], b: background[2], a: background[3]}, loadOp: 'clear', storeOp: 'store'}]});
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bindGroup);
      for (const batch of batches) {
        const x = Math.max(0, Math.floor(batch.clip.x * dpr)), y = Math.max(0, Math.floor(batch.clip.y * dpr));
        const right = Math.min(this.activeCanvas.width, Math.ceil((batch.clip.x + batch.clip.width) * dpr)), bottom = Math.min(this.activeCanvas.height, Math.ceil((batch.clip.y + batch.clip.height) * dpr));
        if (right <= x || bottom <= y) continue;
        pass.setScissorRect(x, y, right - x, bottom - y); pass.draw(6, batch.count, 0, batch.first);
      }
      pass.end(); device.queue.submit([encoder.finish()]);
      const submitted = performance.now(), metrics = {backend: 'webgpu', cpuMs: submitted - started, queueMs: null, drawCalls: batches.length, primitives: data.length / 16, items: this.scene.items.length, dpr};
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
    for (const item of scene.items) {
      context.save(); context.beginPath(); context.rect(item.clip.x, item.clip.y, item.clip.width, item.clip.height); context.clip(); context.fillStyle = cssColor(item.color);
      if (item.type === 'image') {
        if (item.image && item.width && item.height) { context.globalAlpha = item.opacity ?? 1; context.drawImage(item.image, item.x, item.y, item.width, item.height); }
      } else if (item.type === 'text') {
        const size = item.fontSize || 14; context.font = `${item.fontStyle || 'normal'} ${item.fontWeight || 'normal'} ${size}px ${item.fontFamily || 'system-ui, sans-serif'}`; context.textBaseline = 'alphabetic';
        String(item.text || '').split('\n').forEach((line, index) => context.fillText(line, item.x, item.y + size + index * (item.lineHeight || size * 1.4)));
      } else { context.beginPath(); if (context.roundRect) context.roundRect(item.x, item.y, item.width, item.height, Math.min(item.radius || 0, item.width / 2, item.height / 2)); else context.rect(item.x, item.y, item.width, item.height); context.fill(); }
      context.restore();
    }
    this.lastMetrics = {backend: 'canvas2d', cpuMs: performance.now() - started, queueMs: null, queueDone: Promise.resolve(null), drawCalls: scene.items.length, primitives: scene.items.length, items: scene.items.length, dpr};
    return this.lastMetrics;
  }
  hitTest(x, y) { return hitTestScene(this.scene, x, y); }
  dispose() {
    this.disposed = true; this.instances?.destroy(); this.uniform?.destroy(); this.texture?.destroy(); this.device?.destroy();
    if (this.activeCanvas !== this.canvas) { this.activeCanvas.remove(); this.canvas.hidden = false; }
    this.scene = null;
  }
}
