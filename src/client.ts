import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code';
import { glyphs } from '../vendor/uinlay/index';
import { current, ids, reducer } from './model';
import { renderRound } from './view';
import type { Chrome, Detail, Layout } from './view';
import type { InterviewAction, InterviewBatch, InterviewItem, InterviewProps, InterviewRound } from './types';

// The interview card's surface module. It owns no truth: it replays its own
// unacknowledged actions over the host's round and posts them until acked.
// The host gives it the card's whole height and scrolls the site itself, so
// the module never scrolls; a hover only repaints lines already laid out.

interface Local { paint: number }
interface Instance {
  host: InterviewRound; state: InterviewRound; epoch: string; seq: number; pending: InterviewItem[];
  layout: Layout; hover: string; cursors: Record<string, number>; paint: number; started: boolean;
  pointer: { x: number; y: number } | null; chrome: Chrome; detail: Detail;
  /** Whether this client holds the keyboard; only then is its focus cue drawn. */
  keyboard: boolean; hostKeyboard: boolean;
}
const instances = new WeakMap<object, Instance>();

/** What pressing (Enter, Space or a click) a control id does. */
export function activate(state: InterviewRound, id: string): InterviewAction[] {
  const [kind = '', a = '', b = ''] = id.split(':');
  const n = state.cards.length;
  switch (kind) {
    case 'opt': return [{ type: 'choose', card: a, answer: { kind: 'option', option: b } }];
    case 'esc': return b === 'none' || b === 'decide' || b === 'do' ? [{ type: 'choose', card: a, answer: { kind: b } }] : [];
    case 'why': return [{ type: 'why', card: a }];
    case 'ctx': return [{ type: 'toggle', card: a }];
    case 'pv': return [{ type: 'toggle', card: a, part: 'preview' }];
    case 'reply': return [{ type: 'focus', id }];
    case 'clear': return [{ type: 'clear', card: a }, { type: 'focus', id: ids.option(a, state.cards.find(card => card.id === a)?.options[0]?.id ?? '') }];
    case 'confirm': return [{ type: 'confirm', card: a, message: Number(b) }];
    case 'reject': return [{ type: 'reject', card: a, message: Number(b) }];
    case 'goto': return [{ type: 'go', index: Number(a) }];
    case 'nav':
      if (a === 'prev') return n > 1 ? [{ type: 'go', index: (state.at - 1 + n) % n }] : [];
      if (a === 'next') return n > 1 ? [{ type: 'go', index: (state.at + 1) % n }] : [];
      if (a === 'accept') return [{ type: 'accept-rest' }];
      if (a === 'send') return [{ type: 'send' }];
      if (a === 'cancel') return [{ type: 'cancel' }];
      if (a === 'dismiss') return [{ type: 'dismiss' }];
      return [];
    default: return [];
  }
}

export function keyActions(state: InterviewRound, key: ClientKeyEvent, layout: Layout, cursors: Record<string, number> = {}): InterviewAction[] {
  const k = key.key;
  const controls = layout.controls.filter(control => !control.disabled && control.kind !== 'scroll');
  const move = (direction: number): InterviewAction[] => {
    const at = controls.findIndex(control => control.id === state.focus);
    const index = at < 0 ? (direction > 0 ? 0 : controls.length - 1) : (at + direction + controls.length) % Math.max(1, controls.length);
    const next = controls[index];
    return next ? [{ type: 'focus', id: next.id }] : [];
  };
  if (k === 'tab') return move(key.shift ? -1 : 1);
  const card = current(state);

  // Typing in the reply box.
  if (state.status === 'open' && state.focus === ids.reply(card.id)) {
    const value = state.drafts[card.id] ?? '';
    const gs = glyphs(value);
    const id = state.focus;
    const cursor = Math.max(0, Math.min(gs.length, cursors[id] ?? gs.length));
    const edit = (next: string[], at: number): InterviewAction[] => { cursors[id] = at; return [{ type: 'draft', card: card.id, value: next.join('') }]; };
    if (key.ctrl && k.toLowerCase() === 'u') return edit([], 0);
    if (key.ctrl && k.toLowerCase() === 'k') return edit(gs.slice(0, cursor), cursor);
    if (k === 'left') { cursors[id] = Math.max(0, cursor - 1); return []; }
    if (k === 'right') { cursors[id] = Math.min(gs.length, cursor + 1); return []; }
    if (k === 'home') { cursors[id] = 0; return []; }
    if (k === 'end') { cursors[id] = gs.length; return []; }
    if (k === 'backspace') return cursor ? edit([...gs.slice(0, cursor - 1), ...gs.slice(cursor)], cursor - 1) : [];
    if (k === 'delete') return edit([...gs.slice(0, cursor), ...gs.slice(cursor + 1)], cursor);
    if (k === 'return' || k === 'enter') { cursors[id] = 0; return value.trim() ? [{ type: 'say', card: card.id }] : []; }
    if (k === 'up' || k === 'down') return move(k === 'up' ? -1 : 1);
    if (!key.ctrl && !key.meta && !/^(pageup|pagedown|escape|f\d+)$/.test(k)) {
      const typed = glyphs((k === 'space' ? ' ' : k).replace(/[\u0000-\u001f\u007f-\u009f]/g, ''));
      const next = [...gs.slice(0, cursor), ...typed, ...gs.slice(cursor)];
      return next.join('').length <= 4_000 ? edit(next, cursor + typed.length) : [];
    }
  }
  if (key.ctrl || key.meta) return [];
  // Only a card taller than the most rows it may draw scrolls inside itself.
  if (layout.contentHeight > layout.bodyRows && (k === 'pageup' || k === 'pagedown' || k === 'home' || k === 'end')) {
    const max = layout.contentHeight - layout.bodyRows;
    const offset = k === 'home' ? 0 : k === 'end' ? max : Math.max(0, Math.min(max, layout.scroll + (k === 'pageup' ? -layout.bodyRows : layout.bodyRows)));
    return [{ type: 'scroll', offset }];
  }
  if (k === 'up' || k === 'down') return move(k === 'up' ? -1 : 1);
  if (k === 'return' || k === 'enter' || k === 'space' || k === ' ') return controls.some(control => control.id === state.focus) ? activate(state, state.focus) : [];
  if (state.status !== 'open') return [];
  const n = state.cards.length;
  if (k === 'left' && n > 1) return [{ type: 'go', index: (state.at - 1 + n) % n }];
  if (k === 'right' && n > 1) return [{ type: 'go', index: (state.at + 1) % n }];
  if (/^[1-9]$/.test(k)) {
    const option = card.options[Number(k) - 1];
    return option ? [{ type: 'focus', id: ids.option(card.id, option.id) }, { type: 'choose', card: card.id, answer: { kind: 'option', option: option.id } }] : [];
  }
  // The host keeps '?' for itself; it never reaches a Client. 'w' is the key.
  if (k === 'w' || k === '?') return [{ type: 'why', card: card.id }];
  if (k === 'r') return [{ type: 'focus', id: ids.reply(card.id) }];
  if (k === 'c' && card.context) return [{ type: 'toggle', card: card.id }];
  if (k === 'p' && card.options.some(option => option.preview)) return [{ type: 'toggle', card: card.id, part: 'preview' }];
  return [];
}

function draw(f: Instance, surface: ClientSurface<Local>): Layout {
  return renderRound(f.state, surface.columns || 100, surface.rows || 18, {
    keyboard: f.keyboard, chrome: f.chrome, detail: f.detail, cursor: f.cursors[f.state.focus], hover: f.hover,
  });
}

export function interviewBatch(generation: string, epoch: string, pending: readonly InterviewItem[]): InterviewBatch | undefined {
  const items = pending.slice(0, 32);
  while (items.length && JSON.stringify({ generation, epoch, items }).length > 80_000) items.pop();
  return items.length ? { generation, epoch, items } : undefined;
}

function post(surface: ClientSurface<Local>, f: Instance): void {
  const batch = interviewBatch(f.state.generation, f.epoch, f.pending);
  if (batch) surface.post(JSON.parse(JSON.stringify(batch)));
}

/** Apply one action optimistically and queue it for the host; the caller repaints once. */
function dispatch(surface: ClientSurface<Local>, action: InterviewAction): boolean {
  const f = instances.get(surface)!;
  if (f.pending.length >= 128) return false;
  const next = reducer(f.state, action);
  if (next === f.state) return false;
  f.pending.push({ seq: ++f.seq, action });
  f.state = next;
  return true;
}

function repaint(surface: ClientSurface<Local>, f: Instance): void {
  surface.setState({ paint: ++f.paint });
}

/** Tell the host this client holds the keyboard, once per host release. */
function claimKeyboard(surface: ClientSurface<Local>, f: Instance): void {
  if (f.hostKeyboard) return;
  surface.post({ generation: f.state.generation, keyboard: true });
}

function pointerEvent(surface: ClientSurface<Local>, event: ClientPointerEvent): void {
  const f = instances.get(surface)!;
  f.pointer = event.type === 'leave' ? null : { x: event.x, y: event.y };
  // What is under the pointer comes from what is on screen now: no layout.
  const hit = f.pointer ? f.layout.frame.hitAt(f.pointer.x, f.pointer.y) : undefined;
  if (event.type !== 'down') {
    const hover = hit?.id ?? '';
    if (hover !== f.hover) { f.hover = hover; repaint(surface, f); }
    return;
  }
  claimKeyboard(surface, f);
  f.keyboard = true;
  if (event.button !== 'right' && hit && !hit.disabled) {
    if (f.layout.controls.some(control => control.id === hit.id && !control.disabled)) dispatch(surface, { type: 'focus', id: hit.id });
    for (const action of activate(f.state, hit.id)) dispatch(surface, action);
    post(surface, f);
  }
  repaint(surface, f);
}

const InterviewClient: ClientModule<any, Local> = (raw, surface) => {
  const props = raw as InterviewProps;
  let f = instances.get(surface);
  if (!f || f.state.generation !== props.round.generation) {
    const round = props.round;
    f = {
      host: round, state: round, epoch: round.ack.epoch || Math.random().toString(36).slice(2), seq: round.ack.seq, pending: [],
      layout: renderRound(round, surface.columns || 100, surface.rows || 18, { chrome: props.chrome, detail: props.detail }), hover: '', cursors: {},
      paint: f?.paint ?? 0, started: f?.started ?? false, pointer: null, chrome: props.chrome, detail: props.detail ?? 'full',
      keyboard: props.keyboard, hostKeyboard: props.keyboard,
    };
    instances.set(surface, f);
  } else if (props.round.serial >= f.host.serial) {
    const ack = props.round.ack;
    if (ack.epoch === f.epoch) f.pending = f.pending.filter(item => item.seq > ack.seq);
    f.host = props.round;
    f.state = f.pending.reduce((state, item) => reducer(state, item.action), f.host);
  }
  if (!f.started) {
    f.started = true;
    surface.onKey(key => {
      const held = instances.get(surface)!;
      claimKeyboard(surface, held);
      held.keyboard = true;
      let changed = false;
      for (const action of keyActions(held.state, key, held.layout, held.cursors)) changed = dispatch(surface, action) || changed;
      if (changed) post(surface, held);
      repaint(surface, held);
    });
    surface.onPointer(pointer => pointerEvent(surface, pointer));
    surface.every(250, () => {
      const held = instances.get(surface)!;
      if (held.pending.length) post(surface, held);
    });
  }
  // A host-observed release (the prompt was edited) hides the focus cue; the
  // focus id is kept, so the next key or click shows it where it was.
  if (f.hostKeyboard && !props.keyboard) f.keyboard = false;
  f.hostKeyboard = props.keyboard;
  f.chrome = props.chrome;
  f.detail = props.detail ?? 'full';
  f.layout = draw(f, surface);
  return f.layout.frame.toTree(surface.elements);
};
export default InterviewClient;
