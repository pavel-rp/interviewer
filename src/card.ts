import type { InterviewCard, InterviewDecision, InterviewEvidence, InterviewOption, InterviewProblem, InterviewReading } from './types';

// The card schema is where the interview's rules live: a card that leaves out
// why it is asked, what was checked, or what each option costs is refused here,
// before anything is drawn.

export const LIMITS = {
  cards: 12, options: 4, evidence: 8, id: 64, title: 80, question: 240, why: 400, source: 200, asOf: 60,
  unverified: 300, context: 4_000, label: 60, consequence: 400, preview: 4_000, previewLines: 60, reason: 300,
  leaves: 300, key: 100, changed: 300, reply: 4_000, round: 60_000,
} as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The interviewer supplies these on every card; an author option repeating one is refused.
const RESERVED_LABELS = /^(none|other|skip|nothing|you decide|i don'?t know|you do it|leave it)\b/i;

export type Valid<T> = { ok: true; value: T } | { ok: false; errors: InterviewProblem[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class Check {
  errors: InterviewProblem[] = [];
  fail(path: string, message: string): void { if (this.errors.length < 40) this.errors.push({ path, message }); }
  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.fail(`${path}.${key}`, 'unknown field');
  }
  text(value: unknown, path: string, max: number, required = true): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim()) { this.fail(path, required ? 'required non-empty text' : 'must be non-empty text when given'); return undefined; }
    if (value.length > max) { this.fail(path, `at most ${max} characters`); return undefined; }
    return value;
  }
  id(value: unknown, path: string): string | undefined {
    const id = this.text(value, path, LIMITS.id);
    if (id !== undefined && !ID.test(id)) { this.fail(path, 'letters, digits, dot, underscore or hyphen, starting with a letter or digit'); return undefined; }
    return id;
  }
}

function evidence(check: Check, value: unknown, path: string): InterviewEvidence[] {
  if (!Array.isArray(value)) { check.fail(path, 'required list of {source, asOf}; may be empty only with unverified'); return []; }
  if (value.length > LIMITS.evidence) check.fail(path, `at most ${LIMITS.evidence} entries`);
  return value.slice(0, LIMITS.evidence).flatMap((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) { check.fail(at, 'must be {source, asOf}'); return []; }
    check.keys(entry, at, ['source', 'asOf']);
    const source = check.text(entry.source, `${at}.source`, LIMITS.source);
    const asOf = check.text(entry.asOf, `${at}.asOf`, LIMITS.asOf);
    return source && asOf ? [{ source, asOf }] : [];
  });
}

function option(check: Check, value: unknown, path: string): InterviewOption | undefined {
  if (!isRecord(value)) { check.fail(path, 'must be an option object'); return undefined; }
  check.keys(value, path, ['id', 'label', 'consequence', 'by', 'preview']);
  const id = check.id(value.id, `${path}.id`);
  const label = check.text(value.label, `${path}.label`, LIMITS.label);
  if (label && RESERVED_LABELS.test(label.trim())) check.fail(`${path}.label`, 'the interviewer already offers None, You decide, You do it and a free reply on every card; give a real alternative');
  const consequence = check.text(value.consequence, `${path}.consequence`, LIMITS.consequence);
  if (value.by !== 'claude' && value.by !== 'you') check.fail(`${path}.by`, 'who performs this option: claude or you');
  const preview = check.text(value.preview, `${path}.preview`, LIMITS.preview, false);
  if (preview && preview.split('\n').length > LIMITS.previewLines) check.fail(`${path}.preview`, `at most ${LIMITS.previewLines} lines`);
  if (!id || !label || !consequence || (value.by !== 'claude' && value.by !== 'you')) return undefined;
  return { id, label, consequence, by: value.by, ...(preview ? { preview } : {}) };
}

function card(check: Check, value: unknown, path: string): InterviewCard | undefined {
  if (!isRecord(value)) { check.fail(path, 'must be a card object'); return undefined; }
  check.keys(value, path, ['id', 'question', 'why', 'evidence', 'unverified', 'context', 'options', 'recommended', 'leaves', 'key', 'changed', 'gate']);
  const before = check.errors.length;
  const id = check.id(value.id, `${path}.id`);
  const question = check.text(value.question, `${path}.question`, LIMITS.question);
  if (question) {
    if (!question.trim().endsWith('?')) check.fail(`${path}.question`, 'one question, ending in a question mark');
    else if ((question.match(/\?/g) ?? []).length > 1) check.fail(`${path}.question`, 'one decision per card: split compound questions into separate cards');
  }
  const why = check.text(value.why, `${path}.why`, LIMITS.why);
  const found = evidence(check, value.evidence, `${path}.evidence`);
  const unverified = check.text(value.unverified, `${path}.unverified`, LIMITS.unverified, false);
  if (Array.isArray(value.evidence) && !value.evidence.length && !unverified) check.fail(`${path}.evidence`, 'say what you checked and as of when (file, ticket revision, branch state), or give unverified with the reason it could not be checked');
  const context = check.text(value.context, `${path}.context`, LIMITS.context, false);
  const options: InterviewOption[] = [];
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > LIMITS.options) check.fail(`${path}.options`, `2 to ${LIMITS.options} options`);
  else value.options.forEach((entry, index) => { const parsed = option(check, entry, `${path}.options[${index}]`); if (parsed) options.push(parsed); });
  const ids = options.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) check.fail(`${path}.options`, 'option ids must be unique');
  let recommended: InterviewCard['recommended'];
  if (value.recommended !== undefined) {
    if (!isRecord(value.recommended)) check.fail(`${path}.recommended`, 'must be {option, reason}');
    else {
      check.keys(value.recommended, `${path}.recommended`, ['option', 'reason']);
      const reason = check.text(value.recommended.reason, `${path}.recommended.reason`, LIMITS.reason);
      const chosen = value.recommended.option;
      if (typeof chosen !== 'string' || !ids.includes(chosen)) check.fail(`${path}.recommended.option`, 'must name one of this card\'s option ids');
      else if (reason) recommended = { option: chosen, reason };
    }
  }
  const leaves = check.text(value.leaves, `${path}.leaves`, LIMITS.leaves, false);
  const key = check.text(value.key, `${path}.key`, LIMITS.key, false);
  const changed = check.text(value.changed, `${path}.changed`, LIMITS.changed, false);
  if (value.gate !== undefined && typeof value.gate !== 'boolean') check.fail(`${path}.gate`, 'must be true or false');
  if (check.errors.length !== before || !id || !question || !why) return undefined;
  return {
    id, question, why, evidence: found, ...(unverified ? { unverified } : {}), ...(context ? { context } : {}), options,
    ...(recommended ? { recommended } : {}), ...(leaves ? { leaves } : {}), ...(key ? { key } : {}), ...(changed ? { changed } : {}),
    ...(value.gate === true ? { gate: true } : {}),
  };
}

export interface AskInput { title: string; cards: InterviewCard[] }

/**
 * Validate an ask. `decided` is the decision log: a card whose key is already
 * decided must say what changed, or it is a re-ask of a settled matter.
 */
export function validateAsk(value: unknown, decided: Record<string, InterviewDecision> = {}): Valid<AskInput> {
  const check = new Check();
  if (!isRecord(value)) return { ok: false, errors: [{ path: '', message: 'must be {title, cards}' }] };
  if (JSON.stringify(value).length > LIMITS.round) return { ok: false, errors: [{ path: '', message: `at most ${LIMITS.round} serialized characters` }] };
  const title = check.text(value.title, 'title', LIMITS.title);
  const cards: InterviewCard[] = [];
  if (!Array.isArray(value.cards) || !value.cards.length || value.cards.length > LIMITS.cards) check.fail('cards', `1 to ${LIMITS.cards} cards; they are asked one at a time`);
  else value.cards.forEach((entry, index) => { const parsed = card(check, entry, `cards[${index}]`); if (parsed) cards.push(parsed); });
  const ids = cards.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) check.fail('cards', 'card ids must be unique');
  cards.forEach((entry, index) => {
    const prior = entry.key ? decided[entry.key] : undefined;
    if (prior && !entry.changed) check.fail(`cards[${index}].key`, `already decided "${prior.answer}" on ${prior.at.slice(0, 10)} ("${prior.question}"). Drop the card, or pass changed with what is different now.`);
  });
  if (check.errors.length || !title) return { ok: false, errors: check.errors };
  return { ok: true, value: { title, cards } };
}

export function validateReading(value: unknown, entry: InterviewCard): Valid<InterviewReading | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.option === 'string') {
    return entry.options.some(item => item.id === value.option)
      ? { ok: true, value: { option: value.option } }
      : { ok: false, errors: [{ path: 'reading.option', message: 'must name one of the card\'s option ids' }] };
  }
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.text === 'string' && value.text.trim() && value.text.length <= LIMITS.reply) {
    return { ok: true, value: { text: value.text } };
  }
  return { ok: false, errors: [{ path: 'reading', message: 'must be {option} or {text}' }] };
}

export function validateCard(value: unknown, path = 'revise'): Valid<InterviewCard> {
  const check = new Check();
  const parsed = card(check, value, path);
  return parsed && !check.errors.length ? { ok: true, value: parsed } : { ok: false, errors: check.errors };
}

const evidenceSchema = {
  type: 'array', maxItems: LIMITS.evidence,
  description: 'What you checked before asking and as of when: file, ticket revision, branch and its behind/ahead count, sibling repo. Empty only with unverified.',
  items: { type: 'object', additionalProperties: false, required: ['source', 'asOf'], properties: { source: { type: 'string', maxLength: LIMITS.source }, asOf: { type: 'string', maxLength: LIMITS.asOf } } },
};

export const CARD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'question', 'why', 'evidence', 'options'],
  properties: {
    id: { type: 'string', maxLength: LIMITS.id },
    question: { type: 'string', maxLength: LIMITS.question, description: 'One decision, one question mark, plain language, no undefined ids or jargon.' },
    why: { type: 'string', maxLength: LIMITS.why, description: 'Why this needs the operator now: the requirement, finding or gap it comes from.' },
    evidence: evidenceSchema,
    unverified: { type: 'string', maxLength: LIMITS.unverified, description: 'Only when a premise could not be checked: say why.' },
    context: { type: 'string', maxLength: LIMITS.context, description: 'Quote the text the question rests on (lines, AC wording); do not point at earlier scrollback.' },
    options: {
      type: 'array', minItems: 2, maxItems: LIMITS.options,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'label', 'consequence', 'by'],
        properties: {
          id: { type: 'string', maxLength: LIMITS.id },
          label: { type: 'string', maxLength: LIMITS.label },
          consequence: { type: 'string', maxLength: LIMITS.consequence, description: 'What choosing it changes or costs, for the operator.' },
          by: { enum: ['claude', 'you'], description: 'Who performs the step this option implies: claude when you can do it in this session, you when the operator must act by hand (a tracker edit, a deploy, a manual check).' },
          preview: { type: 'string', maxLength: LIMITS.preview, description: 'The exact diff, command (with cost), table or worked example. Drawn verbatim.' },
        },
      },
    },
    recommended: { type: 'object', additionalProperties: false, required: ['option', 'reason'], properties: { option: { type: 'string' }, reason: { type: 'string', maxLength: LIMITS.reason } } },
    leaves: { type: 'string', maxLength: LIMITS.leaves, description: 'What answering this does NOT decide.' },
    key: { type: 'string', maxLength: LIMITS.key, description: 'Stable decision key; logged across sessions once answered.' },
    changed: { type: 'string', maxLength: LIMITS.changed, description: 'Required to re-ask a key that is already decided: what is different now.' },
    gate: { type: 'boolean', description: 'True for outward-facing writes or paid runs: never bulk-accepted.' },
  },
} as const;

export const ASK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'cards'],
  properties: {
    title: { type: 'string', maxLength: LIMITS.title },
    cards: { type: 'array', minItems: 1, maxItems: LIMITS.cards, items: CARD_SCHEMA },
  },
} as const;
