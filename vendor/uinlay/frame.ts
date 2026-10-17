import type { ClientElements, RenderElement } from 'claude-code';

export interface Style { fg?: string; bg?: string; bold?: boolean; underline?: boolean; inverse?: boolean }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Hit extends Rect { id: string; disabled?: boolean }
export interface Run { text: string; style: Style }

// A deliberately small terminal-cell compositor, adapted from the read-only
// Fleet Console prototype. Later paints win; later hit regions win too.
export class Frame {
  readonly width: number;
  readonly height: number;
  private cells: { text: string; style: Style; continuation?: boolean }[];
  readonly hits: Hit[] = [];
  constructor(width: number, height: number, base: Style = {}) {
    this.width = Math.max(1, Math.min(180, Math.floor(width)));
    this.height = Math.max(1, Math.min(64, Math.floor(height)));
    this.cells = Array.from({ length: this.width * this.height }, () => ({ text: ' ', style: base }));
  }
  fill(r: Rect, style: Style, text = ' '): void {
    for (let y = Math.max(0, r.y); y < Math.min(this.height, r.y + r.h); y++)
      for (let x = Math.max(0, r.x); x < Math.min(this.width, r.x + r.w); x++)
        this.cells[y * this.width + x] = { text, style };
  }
  put(x: number, y: number, text: string, style: Style = {}, maxWidth = this.width - x): void {
    if (y < 0 || y >= this.height) return;
    const end = Math.min(this.width, x + Math.max(0, maxWidth));
    for (const glyph of glyphs(text)) {
      const size = glyphWidth(glyph);
      if (x + size > end) break;
      if (x >= 0) {
        const index = y * this.width + x;
        const previous = this.cells[index];
        // Clear both halves when overwriting a double-width glyph.
        if (previous.continuation && x > 0) this.cells[index - 1] = { text: ' ', style: previous.style };
        if (glyphWidth(previous.text) === 2 && x + 1 < this.width) this.cells[index + 1] = { text: ' ', style: previous.style };
        const merged = { ...style, bg: style.bg ?? previous.style.bg };
        this.cells[index] = { text: glyph, style: merged };
        if (size === 2) this.cells[index + 1] = { text: '', style: merged, continuation: true };
      }
      x += size;
    }
  }
  hit(id: string, rect: Rect, disabled = false): void { this.hits.push({ id, ...rect, disabled }); }
  hitAt(x: number, y: number): Hit | undefined {
    return [...this.hits].reverse().find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }
  runs(y: number): Run[] {
    const runs: Run[] = [];
    for (const cell of this.cells.slice(y * this.width, (y + 1) * this.width)) {
      const last = runs[runs.length - 1];
      if (last && sameStyle(last.style, cell.style)) last.text += cell.text;
      else runs.push({ text: cell.text, style: cell.style });
    }
    return runs;
  }
  plain(): string { return Array.from({ length: this.height }, (_, y) => this.runs(y).map(r => r.text).join('').trimEnd()).join('\n'); }
  toTree(elements: ClientElements): RenderElement {
    const rows = Array.from({ length: this.height }, (_, y) => elements.Text({
      wrap: 'truncate-end', children: this.runs(y).map(r => elements.Text({
        children: r.text, color: r.style.fg, backgroundColor: r.style.bg,
        bold: r.style.bold, underline: r.style.underline, inverse: r.style.inverse,
      })),
    }));
    return elements.Box({ flexDirection: 'column', width: this.width, height: this.height, children: rows });
  }
}
function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.underline === !!b.underline && !!a.inverse === !!b.inverse;
}
// No Intl/DOM/Node dependency in the mod runtime. Joining combining marks and
// emoji sequences prevents slicing a user's text through a surrogate or accent.
export function glyphs(value: string): string[] {
  const out: string[] = [];
  for (const ch of value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').normalize('NFC')) {
    const prior = out[out.length - 1];
    if (prior && (/\p{Mark}|[︎️‍\u{1F3FB}-\u{1F3FF}]/u.test(ch) || prior.endsWith('‍'))) out[out.length - 1] += ch;
    else if (prior && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(prior) && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}
export function glyphWidth(glyph: string): number {
  const n = glyph.codePointAt(0) ?? 32;
  if (glyph.includes('️') || n >= 0x1f000 ||
    n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0xffe0 && n <= 0xffe6 || n >= 0x20000)) return 2;
  return 1;
}
export function textWidth(value: string): number { return glyphs(value).reduce((n, g) => n + glyphWidth(g), 0); }
export function clip(value: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  const all = glyphs(value);
  if (all.reduce((n, g) => n + glyphWidth(g), 0) <= width) return all.join('');
  let result = '', used = 0;
  for (const g of all) { if (used + glyphWidth(g) > width - textWidth(ellipsis)) break; result += g; used += glyphWidth(g); }
  return result + ellipsis;
}
export function pad(value: string, width: number): string {
  const cut = clip(value, width); return cut + ' '.repeat(Math.max(0, width - textWidth(cut)));
}
// Linear in the text: the line's width is carried along, never re-measured.
export function wrap(value: string, width: number): string[] {
  if (width < 1) return [];
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    let line = '', used = 0;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && used + textWidth(' ' + word) > width) { lines.push(line); line = ''; used = 0; }
      for (const g of glyphs((line ? ' ' : '') + word)) {
        const size = glyphWidth(g);
        if (used + size > width) { lines.push(line); line = ''; used = 0; }
        line += g;
        used += size;
      }
    }
    lines.push(line);
  }
  return lines;
}
