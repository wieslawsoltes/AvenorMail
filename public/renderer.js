import {WorkspaceRenderer} from './gpu-workspace.js';

/** Calendar compatibility adapter. Event labels and controls remain semantic HTML. */
export class CalendarRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.mode = 'Initializing'; this.rects = []; this.ready = false; this.destroyed = false;
    this.originalStyle = {width: canvas.style.width, height: canvas.style.height, visibility: canvas.style.visibility};
    this.renderer = new WorkspaceRenderer(canvas, {onStatus: status => {
      this.mode = status.backend === 'webgpu' ? 'WebGPU' : 'Canvas 2D';
      this.fallbackReason = status.reason || null;
      if (this.ready && !this.destroyed && status.reason && !status.error) queueMicrotask(() => this.paint());
    }});
    this.observer = new ResizeObserver(() => this.paint());
    this.observer.observe(canvas);
    if (canvas.parentElement) this.observer.observe(canvas.parentElement);
  }
  async initialize() {
    await this.renderer.init();
    if (!this.destroyed) { this.ready = true; this.paint(); }
    return this.mode;
  }
  draw(rects) {
    if (this.destroyed) return;
    this.rects = rects.map(rectangle => ({...rectangle}));
    this.referenceWidth = Math.max(1, this.renderer.activeCanvas.clientWidth || this.canvas.clientWidth);
    this.paint();
  }
  paint() {
    if (!this.ready || this.destroyed) return;
    const active = this.renderer.activeCanvas;
    const width = Math.max(1, active.clientWidth || this.canvas.clientWidth), height = Math.max(1, active.clientHeight || this.canvas.clientHeight);
    const scale = width / (this.referenceWidth || width);
    this.renderer.render({width, height, background: '#00000000', items: this.rects.map(rectangle => ({type: 'rect', x: rectangle.x * scale, y: rectangle.y, width: rectangle.w * scale, height: rectangle.h, color: rectangle.color, radius: rectangle.radius || 0}))});
    // Restore CSS sizing after backing-store sizing, so the calendar remains responsive.
    const rendered = this.renderer.activeCanvas;
    rendered.style.width = this.originalStyle.width;
    rendered.style.height = this.originalStyle.height;
    if (rendered !== this.canvas) {
      // Preserve the original element's layout metrics for existing calendar callers.
      this.canvas.hidden = false; this.canvas.style.visibility = 'hidden';
      rendered.style.visibility = this.originalStyle.visibility;
    }
  }
  destroy() {
    this.destroyed = true; this.observer.disconnect(); this.renderer.dispose();
    Object.assign(this.canvas.style, this.originalStyle);
  }
}
