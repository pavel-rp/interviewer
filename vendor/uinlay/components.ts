import { Frame, clip, pad, textWidth, wrap, glyphs } from './frame';
import type { Rect, Style } from './frame';
import type { Theme, Density } from './theme';
import { densityTokens } from './theme';

export interface Control { id: string; kind: 'button' | 'input' | 'table' | 'scroll'; disabled: boolean }
export interface Context {
  frame: Frame; theme: Theme; density: Density; focus: string; hover?: string;
  plain: boolean; controls: Control[];
}
export function context(frame: Frame, theme: Theme, options: Partial<Omit<Context, 'frame' | 'theme' | 'controls'>> = {}): Context {
  return { frame, theme, density: 'comfortable', focus: '', plain: false, ...options, controls: [] };
}
function chrome(c: Context, value: string): string {
  if (!c.plain) return value;
  const ascii: Record<string, string> = { '◈': '+', '◉': '*', '○': 'o', '◐': '~', '◓': '~', '◑': '~', '◒': '~', '▸': '>', '▏': '|', '✓': '+', '↑': '^', '↓': 'v', '←': '<', '→': '>', '─': '-', '━': '-', '┃': '|', '│': '|', '●': '*', '·': '.', '•': '*', '×': 'x', '–': '-', '—': '-', '…': '.' };
  return value.replace(/[◈◉○◐◓◑◒▸▏✓↑↓←→─━┃│●·•×–—…]/g, glyph => ascii[glyph]);
}
export function text(c: Context, x: number, y: number, value: string, width: number, role: 'text' | 'secondary' | 'muted' | 'accent' | 'accentInk' = 'text', bold = false): void {
  c.frame.put(x, y, clip(chrome(c, value), width, c.plain ? '.' : '…'), { fg: c.theme[role], bold }, width);
}
export function paragraph(c: Context, r: Rect, value: string, role: 'text' | 'secondary' | 'muted' | 'accentInk' = 'secondary', offset = 0, bold = false): number {
  const lines = wrap(value, r.w);
  lines.slice(offset, offset + r.h).forEach((line, i) => text(c, r.x, r.y + i, line, r.w, role, bold));
  return lines.length;
}
export function panel(c: Context, r: Rect, title?: string, raised = false): void {
  const T = c.theme;
  c.frame.fill(r, { fg: T.text, bg: raised ? T.raised : T.surface });
  if (title) { text(c, r.x + 2, r.y + 1, title, r.w - 4, 'secondary', true); rule(c, { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: 1 }); }
}
export function rule(c: Context, r: Rect): void {
  c.frame.put(r.x, r.y, (c.plain ? '-' : '─').repeat(Math.max(0, r.w)), { fg: c.theme.border }, r.w);
}
function control(c: Context, id: string, r: Rect, kind: Control['kind'] = 'button', disabled = false): void {
  c.frame.hit(id, r, disabled);
  if (!c.controls.some(item => item.id === id)) c.controls.push({ id, kind, disabled });
}

/** Fixed cells reserved on each side of a content-sized Button label. */
export const BUTTON_HORIZONTAL_PADDING = 2;

export interface ButtonMeasurement {
  /** Natural terminal-cell width, including fixed padding and the focus-cue slot. */
  width: number;
  /** Terminal-cell width of the label's supported glyph clusters. */
  labelWidth: number;
  /** Smallest width that can show every supported glyph cluster without splitting one. */
  minimumWidth: number;
}

/**
 * Measure a Button independently of its current interaction state. The reserved
 * left padding contains the non-colour focus cue, so focus never relayouts it.
 */
export function measureButton(label: string): ButtonMeasurement {
  const clusters = glyphs(label);
  const labelWidth = clusters.reduce((width, glyph) => width + textWidth(glyph), 0);
  const widestCluster = Math.max(1, ...clusters.map(glyph => textWidth(glyph)));
  return {
    width: labelWidth + BUTTON_HORIZONTAL_PADDING * 2,
    labelWidth,
    minimumWidth: widestCluster + BUTTON_HORIZONTAL_PADDING * 2,
  };
}

/**
 * Wrap a label only when each supported glyph cluster can fit in the usable
 * label area. Undefined is an explicit unavailable state, never a split glyph.
 */
export function buttonLabelLines(label: string, width: number): string[] | undefined {
  const available = Math.max(0, width - BUTTON_HORIZONTAL_PADDING * 2);
  if (!available || glyphs(label).some(glyph => textWidth(glyph) > available)) return undefined;
  return wrap(label, available);
}

export function button(c: Context, r: Rect, options: { id: string; label: string; variant?: 'primary' | 'quiet' | 'danger'; selected?: boolean; disabled?: boolean; multiline?: boolean }): void {
  const { id, label, variant = 'quiet', selected = false, multiline = false } = options;
  const wrappedLines = multiline ? buttonLabelLines(label, r.w) : undefined;
  const lines = wrappedLines ?? [chrome(c, label)];
  // Only the composition renderer asks to make a label multiline. Existing
  // rectangle consumers keep their one-row clipping contract; a composition
  // allocation too narrow for a supported cluster is visibly unavailable.
  const unavailable = multiline && !wrappedLines;
  const disabled = !!options.disabled || unavailable;
  const T = c.theme, focused = !disabled && c.focus === id, hovered = !disabled && c.hover === id;
  // An explicitly subordinate Button keeps its variant while focused: the cue
  // is the marker and underline, never the primary fill.
  const subordinateFocus = focused && options.variant !== undefined && variant !== 'primary';
  const bg = disabled ? T.surface : subordinateFocus ? T.selected : focused ? T.accent : selected ? T.selected : hovered ? T.raised : variant === 'primary' ? T.accent : T.surface;
  const fg = disabled ? T.muted : bg === T.accent ? T.accentInk : variant === 'danger' ? T.danger : T.text;
  c.frame.fill(r, { fg, bg });
  if (unavailable) {
    c.frame.put(r.x, r.y, '!', { fg, bg, bold: true }, Math.max(0, r.w));
    control(c, id, r, 'button', true);
    return;
  }
  const marker = focused ? '>' : !disabled && selected ? (c.plain ? '*' : '▸') : ' ';
  for (let row = 0; row < Math.min(r.h, lines.length); row++) {
    const cue = multiline ? row === 0 ? marker : ' ' : marker;
    const value = multiline ? `${cue} ${lines[row]}` : cue + ' ' + lines[row];
    c.frame.put(r.x, r.y + row, pad(value, r.w), { fg, bg, bold: !disabled && (focused || selected || variant === 'primary'), underline: focused }, r.w);
  }
  control(c, id, r, 'button', disabled);
}
export function field(c: Context, r: Rect, options: { id: string; label: string; value: string; placeholder?: string; disabled?: boolean; cursor?: number }): void {
  const { id, label, value, placeholder = '', disabled = false } = options;
  const focused = c.focus === id;
  const T = c.theme;
  c.frame.fill(r, { bg: focused ? T.selected : T.raised, fg: T.text });
  const prefix = `${focused ? '>' : ' '} ${label}: `;
  c.frame.put(r.x, r.y, prefix, { fg: focused ? T.accent : T.secondary, bold: focused }, r.w);
  const room = Math.max(0, r.w - textWidth(prefix) - 1);
  const gs = glyphs(value);
  const cursor = Math.max(0, Math.min(gs.length, options.cursor ?? gs.length));
  let start = 0;
  if (focused) {
    // Drop clusters from the left until the cursor fits, carrying the width.
    let before = textWidth(gs.slice(0, cursor).join(''));
    while (start < cursor && before >= room - 1) before -= textWidth(gs[start++]);
  }
  const shown = value ? gs.slice(start).join('') : placeholder;
  const x = r.x + textWidth(prefix);
  c.frame.put(x, r.y, clip(shown, room), { fg: value ? T.text : T.muted }, room);
  if (focused && !disabled && room > 0) {
    const at = x + textWidth(gs.slice(start, cursor).join(''));
    c.frame.put(at, r.y, gs[cursor] ?? (c.plain ? '_' : '▏'), { fg: T.accent, underline: true, inverse: cursor < gs.length }, Math.max(0, x + room - at));
  }
  control(c, id, r, 'input', disabled);
}
export interface Tab { id: string; label: string }
export function tabs(c: Context, r: Rect, items: Tab[], selected: string, prefix: string): void {
  const width = Math.floor(r.w / Math.max(1, items.length));
  items.forEach((item, i) => button(c, { x: r.x + i * width, y: r.y, w: i === items.length - 1 ? r.w - i * width : width, h: 1 }, { id: prefix + item.id, label: item.label, selected: item.id === selected }));
}
export function badge(c: Context, x: number, y: number, label: string, status: 'queued' | 'running' | 'blocked' | 'done', width = 12): void {
  const T = c.theme;
  const icons = c.plain ? { queued: '.', running: '>', blocked: '!', done: '+' } : { queued: '○', running: '◉', blocked: '!', done: '✓' };
  const colors = { queued: T.muted, running: T.accent, blocked: T.warning, done: T.good };
  c.frame.put(x, y, clip(`${icons[status]} ${label}`, width), { fg: colors[status], bold: true }, width);
}
export function progress(c: Context, r: Rect, value: number): void {
  const percentage = Math.round(Math.max(0, Math.min(100, value)));
  const width = Math.max(0, r.w - 6), done = Math.round(width * percentage / 100);
  c.frame.put(r.x, r.y, (c.plain ? '#' : '━').repeat(done), { fg: c.theme.accent }, width);
  c.frame.put(r.x + done, r.y, (c.plain ? '.' : '─').repeat(width - done), { fg: c.theme.border }, width - done);
  c.frame.put(r.x + width + 1, r.y, `${percentage}%`, { fg: c.theme.text }, 5);
}
export function checkbox(c: Context, r: Rect, id: string, label: string, checked: boolean, disabled = false): void {
  button(c, r, { id, label: `${checked ? '[x]' : '[ ]'} ${label}`, selected: checked, disabled });
}
export function choice(c: Context, r: Rect, options: { id: string; label: string; description: string; selected: boolean; disabled?: boolean }): void {
  button(c, r, { ...options, label: `${options.selected ? '(●)' : '( )'} ${options.label}`.replace('●', c.plain ? '*' : '●') });
  if (r.h > 1) paragraph(c, { x: r.x + 3, y: r.y + 1, w: r.w - 5, h: r.h - 1 }, options.description, c.focus === options.id && !options.disabled ? 'accentInk' : options.selected ? 'secondary' : 'muted');
}
export function emptyState(c: Context, r: Rect, options: { title: string; description: string; action?: { id: string; label: string }; kind?: 'empty' | 'loading' | 'error'; phase?: number }): void {
  panel(c, r);
  const y = r.y + Math.max(1, Math.floor(r.h / 2) - 2);
  const icon = options.kind === 'error' ? '!' : options.kind === 'loading' ? c.plain ? '~' : ['◐', '◓', '◑', '◒'][(options.phase ?? 0) % 4] : c.plain ? '+' : '◇';
  text(c, r.x + 2, y, `${icon}  ${options.title}`, r.w - 4, 'text', true);
  paragraph(c, { x: r.x + 2, y: y + 2, w: r.w - 4, h: 2 }, options.description);
  if (options.action && y + 5 < r.y + r.h) button(c, { x: r.x + 2, y: y + 5, w: Math.min(r.w - 4, 26), h: 1 }, options.action);
}
export interface Column<T> { key: string; label: string; width: number; sortable?: boolean; value: (row: T) => string; style?: (row: T) => Style }
export function table<T extends { id: string }>(c: Context, r: Rect, options: {
  id: string; rows: T[]; columns: Column<T>[]; selectedId: string | null; offset: number; sort?: string; descending?: boolean; controlPrefix?: string;
}): { pageSize: number; offset: number } {
  const { id, rows, columns, selectedId } = options;
  const prefix = options.controlPrefix ?? '';
  const rowHeight = densityTokens[c.density].rowHeight;
  const pageSize = Math.max(1, Math.floor((r.h - 2) / rowHeight));
  const selectedIndex = rows.findIndex(row => row.id === selectedId);
  let offset = Math.min(Math.max(0, options.offset), Math.max(0, rows.length - pageSize));
  if (selectedIndex >= 0 && (selectedIndex < offset || selectedIndex >= offset + pageSize)) offset = Math.max(0, selectedIndex - pageSize + 1);
  panel(c, r);
  let x = r.x + 2;
  for (const col of columns) {
    const width = Math.min(col.width - 1, r.x + r.w - 1 - x);
    const key = `${prefix}sort:${col.key}`, focused = col.sortable === true && c.focus === key;
    const hovered = col.sortable === true && c.hover === key;
    const arrow = col.key === options.sort ? options.descending ? '↓' : '↑' : '';
    const label = `${focused ? '>' : ''}${col.label}${arrow ? focused ? arrow : ' ' + arrow : ''}`;
    if (focused || hovered) c.frame.fill({ x, y: r.y, w: width, h: 1 }, { bg: focused ? c.theme.accent : c.theme.raised });
    c.frame.put(x, r.y, clip(chrome(c, label), width, c.plain ? '.' : '…'), { fg: focused ? c.theme.accentInk : c.theme.muted, bold: true, underline: focused }, width);
    if (col.sortable) control(c, key, { x, y: r.y, w: width, h: 1 });
    x += col.width;
  }
  rule(c, { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: 1 });
  control(c, id, { ...r, y: r.y + 2, h: r.h - 2 }, 'table');
  rows.slice(offset, offset + pageSize).forEach((row, i) => {
    const y = r.y + 2 + i * rowHeight, selected = row.id === selectedId, hovered = c.hover === `${prefix}row:${row.id}`;
    const visibleHeight = Math.max(0, Math.min(rowHeight, r.y + r.h - y));
    if (!visibleHeight) return;
    if (selected || hovered) c.frame.fill({ x: r.x, y, w: r.w - 1, h: visibleHeight }, { fg: c.theme.text, bg: selected ? c.theme.selected : c.theme.raised });
    c.frame.put(r.x, y, selected ? '>' : ' ', { fg: c.theme.accent, bold: true }, 1);
    let cx = r.x + 2;
    for (const col of columns) {
      c.frame.put(cx, y, clip(col.value(row), Math.min(col.width - 1, r.x + r.w - 2 - cx)), { fg: c.theme.text, bold: selected, underline: selected && c.focus === id, ...col.style?.(row) }, Math.min(col.width - 1, r.x + r.w - 2 - cx));
      cx += col.width;
    }
    c.frame.hit(`${prefix}row:${row.id}`, { x: r.x, y, w: r.w - 1, h: visibleHeight });
  });
  scrollbar(c, { x: r.x + r.w - 1, y: r.y + 2, w: 1, h: r.h - 2 }, rows.length, pageSize, offset, `${prefix}table-scroll`);
  return { pageSize, offset };
}
export function scrollbar(c: Context, r: Rect, total: number, page: number, offset: number, id: string): void {
  if (total <= page || r.h < 2) return;
  const thumb = Math.max(1, Math.floor(r.h * page / total));
  const start = Math.round((r.h - thumb) * Math.min(1, offset / Math.max(1, total - page)));
  for (let i = 0; i < r.h; i++) c.frame.put(r.x, r.y + i, c.plain ? i >= start && i < start + thumb ? '#' : ':' : i >= start && i < start + thumb ? '┃' : '│', { fg: i >= start && i < start + thumb ? c.theme.accent : c.theme.border }, 1);
  control(c, id, r, 'scroll');
}
