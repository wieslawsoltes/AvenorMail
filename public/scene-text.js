/** Browser-shaped text runs, reusable by Canvas/WebGPU and the standalone layout engine. */
export function fontString(style = {}, scale = 1) {
  return `${style.fontStyle || 'normal'} ${style.fontWeight || 'normal'} ${(style.fontSize || 14) * scale}px ${style.fontFamily || 'system-ui, sans-serif'}`;
}

export function configureText(context, style = {}, scale = 1) {
  context.font = fontString(style, scale);
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.direction = style.direction === 'rtl' ? 'rtl' : 'ltr';
  context.fontKerning = style.fontKerning || 'normal';
  context.fontStretch = style.fontStretch || 'normal';
  context.fontVariantCaps = style.fontVariantCaps || 'normal';
  context.textRendering = 'optimizeLegibility';
  if ('letterSpacing' in context) context.letterSpacing = `${(parseFloat(style.letterSpacing) || 0) * scale}px`;
  if ('wordSpacing' in context) context.wordSpacing = `${(parseFloat(style.wordSpacing) || 0) * scale}px`;
  if ('lang' in context && style.lang) context.lang = style.lang;
}

export function measureTextRun(context, text, style = {}) {
  configureText(context, style);
  const metrics = context.measureText(String(text));
  const size = style.fontSize || 14;
  return {width: metrics.width, ascent: metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? size * .8,
    descent: metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? size * .2,
    left: metrics.actualBoundingBoxLeft ?? 0, right: metrics.actualBoundingBoxRight ?? metrics.width};
}

const segmenters = new Map();
export function textSegments(text, granularity = 'grapheme', locale) {
  if (typeof Intl.Segmenter !== 'function') return granularity === 'grapheme' ? Array.from(text) : text.match(/\s+|\S+/gu) || [];
  const key = `${locale || ''}:${granularity}`;
  if (!segmenters.has(key)) segmenters.set(key, new Intl.Segmenter(locale || undefined, {granularity}));
  return [...segmenters.get(key).segment(text)].map(value => value.segment);
}

/** Wrap complete shaped runs; grapheme fallback never splits a combining/emoji cluster. */
export function flowText(text, {width = Infinity, maxLines = Infinity, ellipsis = '…', whiteSpace = 'normal', ...style} = {}, measure) {
  if (typeof measure !== 'function') throw new TypeError('flowText requires a text measurement function');
  width = Math.max(0, Number(width));
  const lines = [], preserve = /^(pre|pre-wrap)$/.test(whiteSpace), wrap = !/^(pre|nowrap)$/.test(whiteSpace);
  text = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!preserve) text = text.replace(/[^\S\n]+/gu, ' ');
  const emit = value => lines.push({text: value, ...measure(value, style)});
  for (const paragraph of text.split('\n')) {
    if (!wrap || !Number.isFinite(width)) { emit(paragraph); continue; }
    let current = '';
    for (const token of textSegments(paragraph, 'word', style.lang)) {
      const candidate = current + token;
      if (measure(candidate, style).width <= width || !candidate.trim()) { current = candidate; continue; }
      if (current.trim()) { emit(preserve ? current : current.trimEnd()); current = ''; }
      let remaining = !preserve ? token.trimStart() : token;
      if (measure(remaining, style).width <= width) { current = remaining; continue; }
      // Measure the growing shaped substring, never a sum of individual character widths.
      for (const grapheme of textSegments(remaining, 'grapheme', style.lang)) {
        if (current && measure(current + grapheme, style).width > width) { emit(current); current = ''; }
        current += grapheme;
      }
    }
    emit(preserve ? current : current.trimEnd());
  }
  const overflow = lines.length > maxLines;
  if (overflow) {
    lines.length = Math.max(0, maxLines);
    if (lines.length) {
      const clusters = textSegments(lines.at(-1).text, 'grapheme', style.lang);
      while (clusters.length && measure(clusters.join('') + ellipsis, style).width > width) clusters.pop();
      const last = clusters.join('') + (measure(ellipsis, style).width <= width ? ellipsis : '');
      lines[lines.length - 1] = {text: last, ...measure(last, style)};
    }
  }
  const lineHeight = style.lineHeight || (style.fontSize || 14) * 1.4;
  let y = 0;
  for (const line of lines) {
    line.x = style.textAlign === 'center' ? Math.max(0, (width - line.width) / 2)
      : style.textAlign === 'right' || style.textAlign === 'end' && style.direction !== 'rtl' || style.textAlign === 'start' && style.direction === 'rtl' ? Math.max(0, width - line.width) : 0;
    line.y = y;
    line.baseline = (lineHeight - line.ascent - line.descent) / 2 + line.ascent;
    line.height = lineHeight; y += lineHeight;
  }
  return {lines, width: Math.max(0, ...lines.map(line => line.width)), height: y, overflow};
}

/** Bounded reusable measurement cache; clear when loaded fonts change. */
export class TextMeasurer {
  constructor({context, limit = 4096} = {}) {
    this.context = context || globalThis.document?.createElement('canvas').getContext('2d');
    if (!this.context) throw new Error('Text measurement needs a Canvas 2D context');
    this.limit = limit; this.cache = new Map();
  }
  measure = (text, style = {}) => {
    const key = JSON.stringify([String(text), fontString(style), style.direction, style.letterSpacing, style.wordSpacing, style.fontKerning, style.fontStretch, style.fontVariantCaps, style.lang]);
    if (this.cache.has(key)) { const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); return value; }
    const value = measureTextRun(this.context, text, style); this.cache.set(key, value);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    return value;
  };
  clear() { this.cache.clear(); }
}
