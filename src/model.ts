import { LIMITS } from './card';
import type { AskInput } from './card';
import type {
  InterviewAction, InterviewAnswer, InterviewBatch, InterviewCard, InterviewDecision, InterviewEvent, InterviewMessage,
  InterviewReading, InterviewRound,
} from './types';

// The interview's one state machine. The client replays it optimistically and
// the host applies it authoritatively, so both derive the same events.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const WHY_TEXT = 'Why ask this, and why that recommendation?';

// --- Control ids, shared by the view, the client and the reducer ------------
export const ids = {
  option: (card: string, option: string) => `opt:${card}:${option}`,
  escape: (card: string, kind: 'none' | 'decide' | 'do') => `esc:${card}:${kind}`,
  why: (card: string) => `why:${card}`,
  context: (card: string) => `ctx:${card}`,
  preview: (card: string) => `pv:${card}`,
  reply: (card: string) => `reply:${card}`,
  clear: (card: string) => `clear:${card}`,
  confirm: (card: string, message: number) => `confirm:${card}:${message}`,
  reject: (card: string, message: number) => `reject:${card}:${message}`,
  prev: 'nav:prev', next: 'nav:next', accept: 'nav:accept', send: 'nav:send', cancel: 'nav:cancel', scroll: 'scroll',
} as const;

export function createRound(input: AskInput, generation: string, options: { fixture?: boolean; previous?: Record<string, InterviewDecision>; location?: 'band' | 'pane' } = {}): InterviewRound {
  const first = input.cards[0]!;
  return {
    id: generation, title: input.title, generation, status: 'open', cards: input.cards, previous: options.previous ?? {},
    at: 0, answers: {}, threads: {}, drafts: {}, expanded: {}, focus: firstFocus(first), scroll: 0, events: [],
    serial: 1, ack: { epoch: '', seq: 0 }, fixture: options.fixture ?? false, location: options.location ?? 'band', dismissed: false,
  };
}

/** Where a card's expanded parts are remembered: the card id for its context. */
export function expandKey(card: string, part: 'context' | 'preview' = 'context'): string {
  return part === 'preview' ? `${card}:preview` : card;
}

export function firstFocus(card: InterviewCard): string {
  return ids.option(card.id, card.recommended?.option ?? card.options[0]!.id);
}

export function current(round: InterviewRound): InterviewCard {
  return round.cards[Math.max(0, Math.min(round.cards.length - 1, round.at))]!;
}

export function findCard(round: InterviewRound, id: string): InterviewCard | undefined {
  return round.cards.find(card => card.id === id);
}

/** The operator spoke last on this card and Claude has not answered yet. */
export function waiting(round: InterviewRound, card: string): boolean {
  const thread = round.threads[card] ?? [];
  return thread.length > 0 && thread[thread.length - 1]!.from === 'you';
}

/** A reading that names an option a revision has since removed. */
export function staleReading(card: InterviewCard, reading: InterviewReading): boolean {
  return 'option' in reading && !card.options.some(option => option.id === reading.option);
}

export function answeredCount(round: InterviewRound): number {
  return round.cards.filter(card => round.answers[card.id]).length;
}

/** Cards "accept recommended" would answer: unanswered, recommended, and not a gate. */
export function acceptable(round: InterviewRound): InterviewCard[] {
  return round.cards.filter(card => !round.answers[card.id] && card.recommended && !card.gate);
}

export function answerLabel(card: InterviewCard, answer: InterviewAnswer): string {
  switch (answer.kind) {
    case 'option': return card.options.find(option => option.id === answer.option)?.label ?? answer.option;
    case 'none': return 'None (leave it)';
    case 'decide': {
      const recommended = card.recommended && card.options.find(option => option.id === card.recommended!.option);
      return recommended ? `You decide (recommended: ${recommended.label})` : 'You decide';
    }
    case 'do': return 'You do it';
    case 'text': return `"${answer.text}"`;
  }
}

/** "You chose X → this changes Y · does not decide Z", from the card's own words. */
export function echo(card: InterviewCard, answer: InterviewAnswer): string {
  const option = answer.kind === 'option' ? card.options.find(item => item.id === answer.option)
    : answer.kind === 'decide' && card.recommended ? card.options.find(item => item.id === card.recommended!.option) : undefined;
  const effect = option ? option.consequence
    : answer.kind === 'none' ? 'nothing is done for this'
      : answer.kind === 'do' ? 'Claude performs the step itself'
        : answer.kind === 'text' ? 'your own words, as confirmed' : 'Claude chooses and says which';
  return `${answerLabel(card, answer)} → ${effect}${card.leaves ? ` · does not decide: ${card.leaves}` : ''}`;
}

// --- Continuations ------------------------------------------------------------

function describe(card: InterviewCard, answer: InterviewAnswer): Record<string, unknown> {
  const base = { card: card.id, question: card.question, answer: answer.kind, label: answerLabel(card, answer), ...(card.leaves ? { leaves: card.leaves } : {}) };
  if (answer.kind === 'option') {
    const option = card.options.find(item => item.id === answer.option);
    return { ...base, option: answer.option, by: option?.by, consequence: option?.consequence };
  }
  if (answer.kind === 'decide') return { ...base, recommended: card.recommended?.option ?? null };
  if (answer.kind === 'text') return { ...base, text: answer.text };
  return base;
}

function escalationText(round: InterviewRound, card: InterviewCard, message: InterviewMessage): string {
  const event = { type: 'interviewer.escalation', round: round.id, card: card.id, kind: message.kind, text: message.text, question: card.question };
  const asked = message.kind === 'why'
    ? 'The operator asked why this card is asked and why its recommendation.'
    : 'The operator replied to this card in their own words. This is not an answer.';
  const reading = message.kind === 'why' ? '' : ' If their words read as a choice or a directive, add reading {option} or {text}: the operator confirms it in the card; never record it yourself.';
  return `Interviewer event:\n${JSON.stringify(event)}\n${asked} Respond with mcp__interviewer__reply {round, card, text} in plain language.${reading} Pass revise with a corrected card (same id) if the question or its premise was wrong. Decide nothing for this card yet; the other cards stay open. End your turn after replying.`;
}

function answersText(round: InterviewRound): string {
  const answers = round.cards.flatMap(card => round.answers[card.id] ? [describe(card, round.answers[card.id]!)] : []);
  const open = round.cards.filter(card => !round.answers[card.id]).map(card => card.id);
  const event = { type: 'interviewer.answers', round: round.id, title: round.title, answers, open };
  return `Interviewer answers:\n${JSON.stringify(event)}\nApply them together now, then say in one line per card what changed. "decide": take your recommendation and say which. "do": perform the step yourself. "none": leave it. A card in open was not answered: decide nothing for it. Do nothing beyond what each answer covers; "leaves" says what it does not decide.`;
}

function cancelledText(round: InterviewRound): string {
  const event = { type: 'interviewer.cancelled', round: round.id, title: round.title };
  return `Interviewer event:\n${JSON.stringify(event)}\nThe operator cancelled this round. Nothing in it was answered; decide none of its cards from it.`;
}

function queue(round: InterviewRound, event: Omit<InterviewEvent, 'id' | 'delivery'>): InterviewRound {
  // Deterministic, so the client's optimistic copy names the same event.
  const id = `${round.id}:${round.events.length + 1}`;
  return { ...round, events: [...round.events, { ...event, id, delivery: round.fixture ? 'local' : 'queued' }] };
}

// --- Operator actions -------------------------------------------------------

function advance(round: InterviewRound, from: number): InterviewRound {
  for (let step = 1; step <= round.cards.length; step++) {
    const index = (from + step) % round.cards.length;
    const card = round.cards[index]!;
    if (!round.answers[card.id]) return { ...round, at: index, focus: firstFocus(card), scroll: 0 };
  }
  return { ...round, focus: ids.send };
}

function record(round: InterviewRound, card: InterviewCard, answer: InterviewAnswer): InterviewRound {
  const index = round.cards.indexOf(card);
  return advance({ ...round, answers: { ...round.answers, [card.id]: answer } }, index);
}

function speak(round: InterviewRound, card: InterviewCard, kind: InterviewMessage['kind'], text: string): InterviewRound {
  const thread = round.threads[card.id] ?? [];
  const message: InterviewMessage = { id: thread.length + 1, from: 'you', kind, text };
  const spoken = { ...round, threads: { ...round.threads, [card.id]: [...thread, message] } };
  return queue(spoken, { kind: 'escalation', card: card.id, text: escalationText(round, card, message) });
}

function operate(round: InterviewRound, action: InterviewAction): InterviewRound {
  const open = round.status === 'open';
  switch (action.type) {
    case 'focus': return action.id === round.focus ? round : { ...round, focus: action.id };
    case 'scroll': {
      const offset = Math.max(0, Math.min(10_000, Math.trunc(action.offset)));
      return offset === round.scroll ? round : { ...round, scroll: offset };
    }
    case 'go': {
      if (!Number.isSafeInteger(action.index) || action.index < 0 || action.index >= round.cards.length || action.index === round.at) return round;
      return { ...round, at: action.index, focus: firstFocus(round.cards[action.index]!), scroll: 0 };
    }
    case 'toggle': {
      if (!findCard(round, action.card)) return round;
      const key = expandKey(action.card, action.part);
      return { ...round, expanded: { ...round.expanded, [key]: !round.expanded[key] } };
    }
    case 'dismiss': return round.status !== 'open' && !round.dismissed ? { ...round, dismissed: true } : round;
    default: break;
  }
  if (!open) return round;
  switch (action.type) {
    case 'choose': {
      const card = findCard(round, action.card);
      const answer = action.answer;
      if (!card || !isRecord(answer)) return round;
      // A typed reply only becomes an answer through confirm.
      if (answer.kind === 'option') return card.options.some(option => option.id === answer.option) ? record(round, card, { kind: 'option', option: answer.option }) : round;
      if (answer.kind === 'none' || answer.kind === 'decide' || answer.kind === 'do') return record(round, card, { kind: answer.kind });
      return round;
    }
    case 'clear': {
      if (!round.answers[action.card]) return round;
      const { [action.card]: _, ...answers } = round.answers;
      return { ...round, answers };
    }
    case 'draft': {
      if (!findCard(round, action.card) || typeof action.value !== 'string' || action.value.length > LIMITS.reply) return round;
      return (round.drafts[action.card] ?? '') === action.value ? round : { ...round, drafts: { ...round.drafts, [action.card]: action.value } };
    }
    case 'say': {
      const card = findCard(round, action.card);
      const text = (round.drafts[action.card] ?? '').trim();
      if (!card || !text) return round;
      const spoken = speak(round, card, /\?\s*$/.test(text) ? 'question' : 'note', text);
      return { ...spoken, drafts: { ...spoken.drafts, [card.id]: '' } };
    }
    case 'why': {
      const card = findCard(round, action.card);
      const thread = round.threads[action.card] ?? [];
      if (!card || (waiting(round, action.card) && thread[thread.length - 1]!.kind === 'why')) return round;
      return speak(round, card, 'why', WHY_TEXT);
    }
    case 'confirm':
    case 'reject': {
      const card = findCard(round, action.card);
      const thread = round.threads[action.card] ?? [];
      const message = thread.find(item => item.id === action.message);
      if (!card || !message || message.from !== 'claude' || !message.reading || message.settled) return round;
      const settled = thread.map(item => item === message ? { ...item, settled: action.type === 'confirm' ? 'confirmed' as const : 'rejected' as const } : item);
      const after = { ...round, threads: { ...round.threads, [card.id]: settled } };
      if (action.type === 'reject') return { ...after, focus: ids.reply(card.id) };
      const reading = message.reading;
      if (staleReading(card, reading)) return round;
      return record(after, card, 'option' in reading ? { kind: 'option', option: reading.option } : { kind: 'text', text: reading.text });
    }
    case 'accept-rest': {
      const cards = acceptable(round);
      if (!cards.length) return round;
      const answers = { ...round.answers };
      for (const card of cards) answers[card.id] = { kind: 'option', option: card.recommended!.option };
      return { ...round, answers, focus: ids.send };
    }
    case 'send': {
      if (!answeredCount(round)) return round;
      const sent = { ...round, status: 'sent' as const, focus: '', scroll: 0 };
      return queue(sent, { kind: 'answers', text: answersText(sent) });
    }
    case 'cancel': {
      const cancelled = { ...round, status: 'cancelled' as const, focus: '', scroll: 0 };
      return queue(cancelled, { kind: 'cancelled', text: cancelledText(cancelled) });
    }
    default: return round;
  }
}

/** One operator action; the same object back when it changes nothing. */
export function reducer(round: InterviewRound, action: InterviewAction): InterviewRound {
  const after = operate(round, action);
  return after === round ? round : { ...after, serial: round.serial + 1 };
}

/**
 * Apply a client batch: items after the acknowledged seq, contiguously, once.
 * A replayed or out-of-order item is ignored, never applied twice.
 */
export function applyBatch(round: InterviewRound, batch: InterviewBatch): InterviewRound {
  if (batch.generation !== round.generation) return round;
  let state = round;
  let { epoch, seq } = round.ack;
  if (batch.epoch !== epoch) { epoch = batch.epoch; seq = 0; }
  for (const item of batch.items) {
    if (item.seq <= seq) continue;
    if (item.seq !== seq + 1) break;
    state = reducer(state, item.action);
    seq = item.seq;
  }
  if (epoch === round.ack.epoch && seq === round.ack.seq) return round;
  return { ...state, ack: { epoch, seq }, serial: state.serial + 1 };
}

// --- Host transitions (Claude, delivery) -------------------------------------

export function reply(round: InterviewRound, cardId: string, text: string, reading?: InterviewReading, revise?: InterviewCard): InterviewRound {
  const card = findCard(round, cardId);
  if (!card) return round;
  const thread = round.threads[cardId] ?? [];
  const message: InterviewMessage = { id: thread.length + 1, from: 'claude', kind: 'reply', text, ...(reading ? { reading } : {}) };
  let after: InterviewRound = { ...round, threads: { ...round.threads, [cardId]: [...thread, message] }, serial: round.serial + 1 };
  if (revise) {
    // The operator answered the old card; a revised one is asked again.
    const { [cardId]: _, ...answers } = after.answers;
    after = { ...after, cards: round.cards.map(item => item.id === cardId ? revise : item), answers };
  }
  return after;
}

export function withdraw(round: InterviewRound): InterviewRound {
  return round.status === 'open' ? { ...round, status: 'withdrawn', focus: '', serial: round.serial + 1 } : round;
}

export function markEvent(round: InterviewRound, id: string, delivery: 'sent' | 'failed', error = ''): InterviewRound {
  const event = round.events.find(item => item.id === id);
  if (!event || event.delivery !== 'queued') return round;
  const events = round.events.map(item => item === event ? { ...item, delivery, ...(delivery === 'failed' ? { error } : {}) } : item);
  return { ...round, events, serial: round.serial + 1 };
}

/** Events the host has not yet scheduled: queued in `after` and absent from `before`. */
export function newlyQueued(before: InterviewRound | null, after: InterviewRound): InterviewEvent[] {
  const known = new Set(before?.generation === after.generation ? before.events.map(event => event.id) : []);
  return after.events.filter(event => event.delivery === 'queued' && !known.has(event.id));
}

/** A plugin reload drops scheduled deliveries; say so instead of leaving them queued. */
export function interrupted(round: InterviewRound): InterviewRound {
  if (!round.events.some(event => event.delivery === 'queued')) return round;
  const error = 'Delivery was interrupted by a plugin reload; it may or may not have reached Claude.';
  return { ...round, events: round.events.map(event => event.delivery === 'queued' ? { ...event, delivery: 'failed', error } : event), serial: round.serial + 1 };
}

export function decisionsFrom(round: InterviewRound, at: string): InterviewDecision[] {
  return round.cards.flatMap(card => {
    const answer = round.answers[card.id];
    return card.key && answer ? [{ key: card.key, question: card.question, answer: answerLabel(card, answer), at, round: round.id }] : [];
  });
}

export function publicRound(round: InterviewRound): Record<string, unknown> {
  return {
    round: round.id, title: round.title, status: round.status, fixture: round.fixture, location: round.location, dismissed: round.dismissed,
    current: current(round).id,
    cards: round.cards.map(card => ({
      card: card.id, question: card.question,
      answer: round.answers[card.id] ? answerLabel(card, round.answers[card.id]!) : null,
      waitingForYou: waiting(round, card.id),
      thread: (round.threads[card.id] ?? []).slice(-4).map(message => ({ from: message.from === 'you' ? 'operator' : 'claude', kind: message.kind, text: message.text, ...(message.settled ? { settled: message.settled } : {}) })),
    })),
    events: round.events.map(event => ({ id: event.id, kind: event.kind, ...(event.card ? { card: event.card } : {}), delivery: event.delivery, ...(event.error ? { error: event.error } : {}) })),
  };
}

// --- Client batch parsing (untrusted) -----------------------------------------

const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function parseAction(value: unknown): InterviewAction | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  switch (value.type) {
    case 'focus': return text(value.id, 200) ? { type: 'focus', id: value.id } : undefined;
    case 'scroll': return typeof value.offset === 'number' && Number.isFinite(value.offset) ? { type: 'scroll', offset: value.offset } : undefined;
    case 'go': return Number.isSafeInteger(value.index) ? { type: 'go', index: value.index as number } : undefined;
    case 'choose': {
      const answer = value.answer;
      if (!text(value.card) || !isRecord(answer)) return undefined;
      if (answer.kind === 'option' && text(answer.option)) return { type: 'choose', card: value.card, answer: { kind: 'option', option: answer.option } };
      if (answer.kind === 'none' || answer.kind === 'decide' || answer.kind === 'do') return { type: 'choose', card: value.card, answer: { kind: answer.kind } };
      return undefined;
    }
    case 'draft': return text(value.card) && typeof value.value === 'string' && value.value.length <= LIMITS.reply ? { type: 'draft', card: value.card, value: value.value } : undefined;
    case 'confirm':
    case 'reject': return text(value.card) && Number.isSafeInteger(value.message) ? { type: value.type, card: value.card, message: value.message as number } : undefined;
    case 'toggle':
      if (!text(value.card) || (value.part !== undefined && value.part !== 'context' && value.part !== 'preview')) return undefined;
      return { type: 'toggle', card: value.card, ...(value.part ? { part: value.part } : {}) };
    case 'clear':
    case 'say':
    case 'why': return text(value.card) ? { type: value.type, card: value.card } : undefined;
    case 'accept-rest':
    case 'send':
    case 'cancel':
    case 'dismiss': return { type: value.type };
    default: return undefined;
  }
}

export function parseBatch(value: unknown): InterviewBatch | undefined {
  if (!isRecord(value) || !text(value.generation) || !text(value.epoch) || !Array.isArray(value.items) || value.items.length > 64) return undefined;
  const items = [];
  for (const item of value.items) {
    if (!isRecord(item) || !Number.isSafeInteger(item.seq) || (item.seq as number) < 1) return undefined;
    const action = parseAction(item.action);
    if (!action) return undefined;
    items.push({ seq: item.seq as number, action });
  }
  return { generation: value.generation, epoch: value.epoch, items };
}
