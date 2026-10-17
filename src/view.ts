import { Frame, button, clip, context, field, measureButton, scrollbar, textWidth, themes, wrap } from '../vendor/uinlay/index';
import type { Context, Rect } from '../vendor/uinlay/index';
import { acceptable, answeredCount, current, echo, expandKey, ids, waiting } from './model';
import type { InterviewCard, InterviewEvent, InterviewRound } from './types';

// One card at a time: a fixed header (where you are), a scrolling body (the
// card, its thread and preview), a fixed footer (moving and sending).
// `full` shows every option's consequence and the whole preview; `compact`
// keeps the focused option whole and the rest to a line, to fit the band.

export type Chrome = 'band' | 'pane';
export type Detail = 'full' | 'compact';
/** A readable measure: wider sites leave the rest of the row empty. */
export const CARD_COLUMNS = 100;
const COMPACT_PREVIEW = 6;
const COMPACT_THREAD = 3;
export interface ControlInfo { id: string; kind: 'button' | 'input' | 'scroll'; disabled: boolean }
export interface Layout {
  frame: Frame;
  /** Every control in focus order, including ones scrolled out of view. */
  controls: ControlInfo[];
  /** Body line of each body control's first row; header/footer controls are absent. */
  lineOf: Record<string, number>;
  top: number;
  bodyRows: number;
  contentHeight: number;
  scroll: number;
}
export interface ViewOptions { hover?: string; keyboard?: boolean; cursor?: number; chrome?: Chrome; detail?: Detail }

type Paint = (c: Context, x: number, y: number, w: number) => void;
interface Line { paint: Paint; controls?: ControlInfo[] }

const BY = { claude: 'Claude does it', you: 'you do it' } as const;
const theme = themes.ink;

function put(c: Context, x: number, y: number, value: string, width: number, fg: string, bold = false): void {
  c.frame.put(x, y, clip(value, width), { fg, bold }, width);
}

/** Wrapped text as lines; the first line may carry a label in another color. */
function prose(value: string, width: number, fg: string, options: { label?: string; labelFg?: string; indent?: number; bold?: boolean; hit?: string } = {}): Line[] {
  const label = options.label ? `${options.label}  ` : '';
  const indent = options.indent ?? 0;
  const hanging = textWidth(label);
  const lines = wrap(value, Math.max(8, width - indent - hanging));
  return lines.map((line, index) => ({
    paint: (c, x, y, w) => {
      if (index === 0 && label) put(c, x + indent, y, label, w - indent, options.labelFg ?? theme.muted, true);
      put(c, x + indent + hanging, y, line, w - indent - hanging, fg, options.bold);
      if (options.hit) c.frame.hit(options.hit, { x, y, w, h: 1 });
    },
  }));
}

const blank: Line = { paint: () => undefined };

/** One line at most: the text clipped to the room beside its label. */
function line(value: string, width: number, fg: string, options: { label?: string; labelFg?: string; indent?: number; hit?: string } = {}): Line[] {
  const room = width - (options.indent ?? 0) - (options.label ? textWidth(options.label) + 2 : 0);
  return prose(clip(value.replace(/\s+/g, ' '), Math.max(8, room)), width, fg, options).slice(0, 1);
}

/** A row of buttons, wrapped onto further rows when the width runs out. */
function buttonRows(items: { id: string; label: string; selected?: boolean; disabled?: boolean; variant?: 'primary' | 'quiet' | 'danger' }[], width: number, indent = 0): Line[] {
  const rows: { item: typeof items[number]; x: number; w: number }[][] = [[]];
  let x = indent;
  for (const item of items) {
    const w = Math.min(width - indent, measureButton(item.label).width);
    if (x > indent && x + w > width) { rows.push([]); x = indent; }
    rows[rows.length - 1]!.push({ item, x, w });
    x += w + 1;
  }
  return rows.map(row => ({
    controls: row.map(({ item }) => ({ id: item.id, kind: 'button' as const, disabled: !!item.disabled })),
    paint: (c, x0, y) => {
      for (const { item, x: dx, w } of row) button(c, { x: x0 + dx, y, w, h: 1 }, { id: item.id, label: item.label, selected: item.selected, disabled: item.disabled, variant: item.variant ?? 'quiet' });
    },
  }));
}

function deliveryText(event: InterviewEvent | undefined): { text: string; fg: string } | undefined {
  if (!event) return undefined;
  switch (event.delivery) {
    case 'queued': return { text: 'Sending to Claude…', fg: theme.muted };
    case 'sent': return { text: 'Delivered to the session (Claude has not necessarily acted yet).', fg: theme.good };
    case 'failed': return { text: `! Not delivered: ${event.error ?? 'unknown error'}`, fg: theme.danger };
    case 'local': return { text: 'Fixture: kept here, never sent to Claude.', fg: theme.muted };
  }
}

function previewOf(round: InterviewRound, card: InterviewCard) {
  const focused = card.options.find(option => round.focus === ids.option(card.id, option.id));
  const recommended = card.recommended && card.options.find(option => option.id === card.recommended!.option);
  return [focused, recommended, ...card.options].find(option => option?.preview);
}

/** The option shown whole in compact detail: the focused one, else the recommendation. */
function spotlight(round: InterviewRound, card: InterviewCard): string | undefined {
  return card.options.find(option => round.focus === ids.option(card.id, option.id))?.id ?? card.recommended?.option;
}

function cardLines(round: InterviewRound, card: InterviewCard, width: number, cursor: number | undefined, detail: Detail): Line[] {
  const open = round.status === 'open';
  const compact = detail === 'compact';
  const note = compact ? line : prose;
  const lines: Line[] = [];
  lines.push(...prose(card.question, width, theme.text, { bold: true }));
  lines.push(...prose(card.why, width, theme.secondary, { label: 'Why' }));
  if (card.evidence.length) lines.push(...note(card.evidence.map(item => `${item.source} (${item.asOf})`).join(' · '), width, theme.muted, { label: 'Checked' }));
  if (card.unverified) lines.push(...note(card.unverified, width, theme.warning, { label: '! Unverified', labelFg: theme.warning }));
  const prior = card.key ? round.previous[card.key] : undefined;
  if (prior) lines.push(...note(`"${prior.answer}" on ${prior.at.slice(0, 10)}. What changed: ${card.changed ?? 'not stated'}`, width, theme.warning, { label: 'Decided before', labelFg: theme.warning }));
  if (card.gate) lines.push(...note('Outward-facing or paid: answer this one yourself; "Accept recommended" skips it.', width, theme.warning, { label: '◆ Gate', labelFg: theme.warning }));
  // Compact detail moves the context and preview toggles into the action row.
  const contextOpen = !!round.expanded[expandKey(card.id)];
  const previewOpen = !compact || !!round.expanded[expandKey(card.id, 'preview')];
  const toggle = (id: string, open: boolean, name: string) => ({ id, label: `${open ? '▾' : '▸'} ${name}` });
  if (card.context && !compact) lines.push(...buttonRows([toggle(ids.context(card.id), contextOpen, 'Context (c)')], width));
  if (card.context && contextOpen) lines.push(...prose(card.context, width, theme.secondary, { indent: 2 }));
  if (!compact) lines.push(blank);

  const answer = round.answers[card.id];
  const whole = spotlight(round, card);
  card.options.forEach((option, index) => {
    const id = ids.option(card.id, option.id);
    const chosen = answer?.kind === 'option' && answer.option === option.id;
    const recommended = card.recommended?.option === option.id;
    const tags = `${recommended ? 'Recommended · ' : ''}${BY[option.by]}`;
    const control: ControlInfo = { id, kind: 'button', disabled: !open };
    const shownWhole = !compact || option.id === whole;
    const label = `${index + 1}  ${chosen ? '●' : '○'} ${option.label}`;
    lines.push({
      controls: [control],
      paint: (c, x, y, w) => {
        const room = Math.max(4, w - textWidth(tags) - 3);
        button(c, { x, y, w, h: 1 }, { id, label: clip(label, room - 2), selected: chosen, disabled: !open });
        // On the accent focus bar the tags and inline consequence take the bar's ink.
        const onBar = c.focus === id && open;
        const tagX = x + w - textWidth(tags) - 1;
        if (tagX > x + room) c.frame.put(tagX, y, tags, { fg: onBar ? theme.accentInk : recommended ? theme.accent : theme.muted }, textWidth(tags));
        // Compact detail gives an option out of focus one line: its consequence follows the label.
        const after = x + 2 + textWidth(label) + 1;
        if (!shownWhole && room - (after - x) > 8) c.frame.put(after, y, clip(`— ${option.consequence}`, room - (after - x)), { fg: onBar ? theme.accentInk : theme.muted }, room - (after - x));
      },
    });
    if (shownWhole) lines.push(...prose(option.consequence, width, theme.secondary, { indent: 5, hit: id }));
    if (recommended && shownWhole) lines.push(...note(card.recommended!.reason, width, theme.accent, { indent: 5, label: 'Because', labelFg: theme.accent, hit: id }));
  });
  if (!compact) lines.push(blank);

  const escape = (kind: 'none' | 'decide' | 'do', label: string) => ({ id: ids.escape(card.id, kind), label, selected: answer?.kind === kind, disabled: !open });
  const preview = previewOf(round, card);
  lines.push(...buttonRows([
    { id: ids.why(card.id), label: 'Why? (w)', disabled: !open },
    escape('none', compact ? 'None' : 'None — leave it'), escape('decide', 'You decide'), escape('do', 'You do it'),
    ...(compact && card.context ? [toggle(ids.context(card.id), contextOpen, 'Context (c)')] : []),
    ...(compact && preview ? [toggle(ids.preview(card.id), previewOpen, 'Preview (p)')] : []),
  ], width));

  // The conversation about this card reads top to bottom into the reply box,
  // so revealing the reply box always shows the latest exchange above it.
  const thread = round.threads[card.id] ?? [];
  const escalations = round.events.filter(event => event.kind === 'escalation' && event.card === card.id);
  for (const message of compact ? thread.slice(-COMPACT_THREAD) : thread) {
    if (message.from === 'you') {
      lines.push(...prose(message.kind === 'why' ? 'Why ask this, and why that recommendation?' : message.text, width, theme.muted, { label: 'You', labelFg: theme.muted }));
      continue;
    }
    lines.push(...prose(message.text, width, theme.text, { label: 'Claude', labelFg: theme.accent }));
    if (!message.reading) continue;
    const reading = 'option' in message.reading
      ? card.options.find(option => option.id === (message.reading as { option: string }).option)?.label ?? message.reading.option
      : `"${message.reading.text}"`;
    lines.push(...prose(reading, width, theme.accent, { label: 'Reads your reply as', labelFg: theme.accent, indent: 2 }));
    if (message.settled) lines.push(...prose(message.settled === 'confirmed' ? 'You confirmed it.' : 'You said not quite.', width, theme.muted, { indent: 2 }));
    else if (open) lines.push(...buttonRows([
      { id: ids.confirm(card.id, message.id), label: 'Confirm', variant: 'primary' },
      { id: ids.reject(card.id, message.id), label: 'Not quite' },
    ], width, 2));
  }
  if (waiting(round, card.id)) {
    const last = deliveryText(escalations[escalations.length - 1]);
    lines.push(...prose(last?.fg === theme.danger ? last.text : 'Waiting for Claude… the other cards stay answerable.', width, last?.fg === theme.danger ? theme.danger : theme.muted, { indent: 2 }));
  }
  if (open) {
    const replyId = ids.reply(card.id);
    lines.push({
      controls: [{ id: replyId, kind: 'input', disabled: false }],
      paint: (c, x, y, w) => field(c, { x, y, w, h: 1 }, { id: replyId, label: 'Reply', value: round.drafts[card.id] ?? '', placeholder: 'ask back, correct, or answer in your words — Enter sends it to Claude', cursor }),
    });
  }

  if (answer) {
    lines.push(blank);
    lines.push(...prose(echo(card, answer), width, theme.good, { label: 'Recorded', labelFg: theme.good }));
    if (open) lines.push(...buttonRows([{ id: ids.clear(card.id), label: 'Change answer' }], width));
  }

  if (preview?.preview && previewOpen) {
    if (!compact) lines.push(blank);
    const rows = preview.preview.split('\n');
    const shown = compact ? rows.slice(0, COMPACT_PREVIEW) : rows;
    lines.push({ paint: (c, x, y, w) => put(c, x, y, `Preview · ${preview.label}`, w, theme.muted, true) });
    for (const row of shown) {
      lines.push({ paint: (c, x, y, w) => {
        c.frame.fill({ x, y, w, h: 1 }, { bg: theme.raised });
        c.frame.put(x + 1, y, clip(row.replace(/\t/g, '  '), w - 2), { fg: theme.text, bg: theme.raised }, w - 2);
      } });
    }
    if (shown.length < rows.length) lines.push(...line(`… ${rows.length - shown.length} more lines: f opens the full card`, width, theme.muted, { indent: 1 }));
  }

  const others = round.cards.filter(other => other !== card && round.answers[other.id]);
  if (others.length && !compact) {
    lines.push(blank);
    lines.push({ paint: (c, x, y, w) => put(c, x, y, 'Recorded so far', w, theme.muted, true) });
    for (const other of others) lines.push(...prose(echo(other, round.answers[other.id]!), width, theme.secondary, { label: `Q${round.cards.indexOf(other) + 1}`, labelFg: theme.muted, hit: `goto:${round.cards.indexOf(other)}` }));
  }
  return lines;
}

function settledLines(round: InterviewRound, width: number): Line[] {
  const lines: Line[] = [];
  const answered = answeredCount(round);
  const open = round.cards.length - answered;
  const headline = round.status === 'sent' ? { text: `Sent: ${answered} answered${open ? `, ${open} left open` : ''}.`, fg: theme.good }
    : round.status === 'cancelled' ? { text: 'Cancelled: nothing was answered.', fg: theme.warning }
      : { text: 'Withdrawn by Claude.', fg: theme.muted };
  lines.push(...prose(headline.text, width, headline.fg, { bold: true }));
  const delivery = deliveryText([...round.events].reverse().find(event => event.kind !== 'escalation'));
  if (delivery) lines.push(...prose(delivery.text, width, delivery.fg));
  if (round.status !== 'sent') return lines;
  lines.push(blank);
  round.cards.forEach((card, index) => {
    const answer = round.answers[card.id];
    lines.push(...prose(card.question, width, theme.text, { label: `Q${index + 1}`, labelFg: theme.muted }));
    lines.push(...prose(answer ? echo(card, answer) : 'left open: Claude decides nothing for it', width, answer ? theme.secondary : theme.muted, { indent: 4 }));
  });
  return lines;
}

function headerRows(chrome: Chrome): number { return chrome === 'pane' ? 2 : 1; }
function footerRows(round: InterviewRound, chrome: Chrome): number { return round.status === 'open' && chrome === 'pane' ? 2 : 1; }
const innerWidth = (columns: number) => Math.max(24, columns - 4);

// Lines are built once per round state: a hover or any other repaint only
// paints them again. Rounds are immutable, so the object is the key.
const built = new WeakMap<InterviewRound, Map<string, Line[]>>();

function bodyLines(round: InterviewRound, columns: number, cursor: number | undefined, detail: Detail): Line[] {
  const key = `${columns}|${cursor ?? ''}|${detail}`;
  let byRound = built.get(round);
  if (!byRound) built.set(round, byRound = new Map());
  let lines = byRound.get(key);
  if (!lines) {
    // One column is kept free for the scrollbar.
    const width = innerWidth(columns) - 1;
    lines = round.status === 'open' ? cardLines(round, current(round), width, cursor, detail) : settledLines(round, width);
    byRound.set(key, lines);
  }
  return lines;
}

export function naturalRows(round: InterviewRound, columns: number, chrome: Chrome, detail: Detail = 'full'): number {
  return headerRows(chrome) + bodyLines(round, Math.min(columns, CARD_COLUMNS), undefined, detail).length + footerRows(round, chrome);
}

/** Full detail when it fits the rows, else compact. */
export function fitDetail(round: InterviewRound, columns: number, rows: number, chrome: Chrome): Detail {
  return naturalRows(round, columns, chrome, 'full') <= rows ? 'full' : 'compact';
}

function footerButtons(round: InterviewRound, compact: boolean) {
  if (round.status !== 'open') return [{ id: 'nav:dismiss', label: 'Dismiss', variant: 'quiet' as const }];
  const answered = answeredCount(round);
  const rest = acceptable(round).length;
  return [
    { id: ids.prev, label: compact ? '◀' : '◀ Prev', disabled: round.cards.length < 2 },
    { id: ids.next, label: compact ? '▶' : 'Next ▶', disabled: round.cards.length < 2 },
    ...(rest ? [{ id: ids.accept, label: compact ? `Accept rec. (${rest})` : `Accept recommended (${rest})` }] : []),
    { id: ids.send, label: `Send ${answered}/${round.cards.length}`, variant: 'primary' as const, disabled: !answered },
    { id: ids.cancel, label: 'Cancel', variant: 'danger' as const },
  ];
}

export function renderRound(round: InterviewRound, columns: number, rows: number, options: ViewOptions = {}): Layout {
  const chrome = options.chrome ?? 'band';
  const width = Math.max(28, Math.min(CARD_COLUMNS, Math.floor(columns)));
  const height = Math.max(4, Math.min(64, Math.floor(rows)));
  const frame = new Frame(width, height, { fg: theme.text, bg: theme.canvas });
  const c = context(frame, theme, { focus: options.keyboard === false ? '' : round.focus, hover: options.hover ?? '' });
  const x = 2, w = innerWidth(width);
  const controls: ControlInfo[] = [];
  const lineOf: Record<string, number> = {};

  // Header: where you are.
  const waitingCount = round.cards.filter(item => waiting(round, item.id)).length;
  const position = round.status === 'open'
    ? `Q${round.at + 1} of ${round.cards.length} · ${answeredCount(round)} recorded${waitingCount ? ` · ${waitingCount} waiting on Claude` : ''}`
    : round.status;
  const title = `INTERVIEW · ${round.title}${round.fixture ? ' · fixture' : ''}`;
  put(c, x, 0, title, Math.max(0, w - textWidth(position) - 2), theme.accent, true);
  put(c, x + w - Math.min(w, textWidth(position)), 0, position, Math.min(w, textWidth(position)), theme.muted);
  if (chrome === 'pane') frame.put(x, 1, '─'.repeat(w), { fg: theme.border }, w);

  // Body: the current card, scrolled.
  const top = headerRows(chrome);
  const bottom = footerRows(round, chrome);
  const bodyRows = Math.max(1, height - top - bottom);
  const lines = bodyLines(round, width, options.cursor, options.detail ?? 'full');
  const contentHeight = lines.length;
  const scroll = Math.max(0, Math.min(round.scroll, contentHeight - bodyRows));
  lines.forEach((line, index) => {
    for (const control of line.controls ?? []) {
      if (lineOf[control.id] === undefined) { lineOf[control.id] = index; controls.push(control); }
    }
    const y = top + index - scroll;
    if (y >= top && y < top + bodyRows) line.paint(c, x, y, w - 1);
  });
  if (contentHeight > bodyRows) {
    scrollbar(c, { x: width - 2, y: top, w: 1, h: bodyRows }, contentHeight, bodyRows, scroll, ids.scroll);
    controls.push({ id: ids.scroll, kind: 'scroll', disabled: false });
  }

  // Footer: moving and sending.
  const fy = height - bottom;
  const footer = buttonRows(footerButtons(round, w < 70), w)[0]!;
  footer.paint(c, x, fy, w);
  controls.push(...(footer.controls ?? []));
  if (bottom === 2) put(c, x, fy + 1, '1–4 choose · ←/→ card · w why · r reply · c context · wheel scrolls', w, theme.muted);
  return { frame, controls, lineOf, top, bodyRows, contentHeight, scroll };
}

export type { Rect };
