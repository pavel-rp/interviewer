import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateAsk, validateCard, validateReading } from '../src/card';
import { DEMO, DEMO_PREVIOUS, fixtureReply } from '../src/fixtures';
import { acceptable, applyBatch, createRound, decisionsFrom, echo, ids, interrupted, markEvent, newlyQueued, parseBatch, reducer, reply, withdraw } from '../src/model';
import type { InterviewAction, InterviewCard, InterviewRound } from '../src/types';

const card = (id: string, extra: Partial<InterviewCard> = {}): InterviewCard => ({
  id, question: `Pick ${id}?`, why: 'Needed to continue.', evidence: [{ source: 'spec.md', asOf: 'read 10:00' }],
  options: [
    { id: 'a', label: 'Option A', consequence: 'Does A.', by: 'claude' },
    { id: 'b', label: 'Option B', consequence: 'Does B.', by: 'you' },
  ],
  recommended: { option: 'a', reason: 'A is safer.' },
  ...extra,
});

function round(cards: InterviewCard[] = [card('q1'), card('q2'), card('q3')], fixture = false): InterviewRound {
  return createRound({ title: 'Test', cards }, 'iv-test', { fixture });
}

const run = (state: InterviewRound, ...actions: InterviewAction[]) => actions.reduce(reducer, state);

// --- card rules ---------------------------------------------------------------

test('a card needs why, evidence (or a stated reason it is unverified) and a consequence per option', () => {
  const bare = { id: 'x', question: 'Do it?', options: [{ id: 'a', label: 'A', by: 'claude' }, { id: 'b', label: 'B', consequence: 'b', by: 'you' }] };
  const result = validateAsk({ title: 't', cards: [bare] });
  assert.equal(result.ok, false);
  const paths = result.ok ? [] : result.errors.map(error => error.path);
  assert.ok(paths.includes('cards[0].why'));
  assert.ok(paths.includes('cards[0].evidence'));
  assert.ok(paths.includes('cards[0].options[0].consequence'));

  const empty = validateAsk({ title: 't', cards: [card('x', { evidence: [] })] });
  assert.equal(empty.ok, false);
  assert.match(JSON.stringify(empty), /unverified/);
  assert.equal(validateAsk({ title: 't', cards: [card('x', { evidence: [], unverified: 'Tracker unreachable.' })] }).ok, true);
});

test('one decision per card: a compound question is refused', () => {
  const result = validateAsk({ title: 't', cards: [card('x', { question: 'Commit it? And re-run the audit?' })] });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /split compound questions/);
});

test('escape hatches belong to the interviewer, not to the author', () => {
  const none = card('x', { options: [{ id: 'a', label: 'Option A', consequence: 'A', by: 'claude' }, { id: 'n', label: 'None', consequence: 'Nothing', by: 'claude' }] });
  const result = validateAsk({ title: 't', cards: [none] });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /already offers None/);
});

test('the recommendation must name an option, and unknown fields are refused', () => {
  assert.equal(validateAsk({ title: 't', cards: [card('x', { recommended: { option: 'zzz', reason: 'r' } })] }).ok, false);
  assert.equal(validateAsk({ title: 't', cards: [{ ...card('x'), callback: 'x' }] }).ok, false);
});

test('a decided key cannot be asked again unless the card says what changed', () => {
  const decided = { 'db.engine': { key: 'db.engine', question: 'Which DB?', answer: 'Postgres', at: '2026-10-01T10:00:00Z', round: 'r' } };
  const again = validateAsk({ title: 't', cards: [card('x', { key: 'db.engine' })] }, decided);
  assert.equal(again.ok, false);
  assert.match(again.ok ? '' : again.errors[0]!.message, /already decided "Postgres" on 2026-10-01/);
  assert.equal(validateAsk({ title: 't', cards: [card('x', { key: 'db.engine', changed: 'The host dropped Postgres support.' })] }, decided).ok, true);
});

test('the demo round passes its own rules', () => {
  assert.equal(validateAsk(DEMO, DEMO_PREVIOUS).ok, true);
});

test('a reading names one of the card options or carries text', () => {
  const c = card('x');
  assert.deepEqual(validateReading({ option: 'b' }, c), { ok: true, value: { option: 'b' } });
  assert.equal(validateReading({ option: 'nope' }, c).ok, false);
  assert.equal(validateReading({ option: 'a', text: 'both' }, c).ok, false);
  assert.equal(validateCard({ ...c, question: 'no mark' }).ok, false);
});

// --- the queue ----------------------------------------------------------------

test('choosing records the answer and moves to the next unanswered card', () => {
  const state = run(round(), { type: 'choose', card: 'q1', answer: { kind: 'option', option: 'b' } });
  assert.deepEqual(state.answers.q1, { kind: 'option', option: 'b' });
  assert.equal(state.at, 1);
  assert.equal(state.focus, ids.option('q2', 'a'));
  const all = run(state, { type: 'choose', card: 'q2', answer: { kind: 'none' } }, { type: 'choose', card: 'q3', answer: { kind: 'do' } });
  assert.equal(all.focus, ids.send);
  assert.equal(all.events.length, 0, 'nothing is sent until Send');
});

test('typed words never become an answer without the operator confirming a reading', () => {
  let state = run(round(), { type: 'draft', card: 'q1', value: 'are these nits?' }, { type: 'say', card: 'q1' });
  assert.equal(state.answers.q1, undefined);
  assert.equal(state.threads.q1?.[0]?.kind, 'question');
  assert.equal(state.events.length, 1);
  assert.match(state.events[0]!.text, /"kind":"question"/);
  assert.match(state.events[0]!.text, /This is not an answer/);
  assert.equal(state.drafts.q1, '');

  // A client cannot smuggle a text answer through choose.
  state = run(state, { type: 'choose', card: 'q1', answer: { kind: 'text', text: 'yes' } });
  assert.equal(state.answers.q1, undefined);

  state = reply(state, 'q1', 'Style-only; no requirement needs them.', { option: 'b' });
  assert.equal(state.answers.q1, undefined, 'a reading is only a proposal');
  state = run(state, { type: 'confirm', card: 'q1', message: 2 });
  assert.deepEqual(state.answers.q1, { kind: 'option', option: 'b' });
  assert.equal(run(state, { type: 'confirm', card: 'q1', message: 2 }), state, 'a reading settles once');
});

test('a statement is a note, a question is a question; why is asked once until Claude replies', () => {
  const note = run(round(), { type: 'draft', card: 'q1', value: 'use the PR url instead' }, { type: 'say', card: 'q1' });
  assert.equal(note.threads.q1?.[0]?.kind, 'note');
  const why = run(round(), { type: 'why', card: 'q1' });
  assert.equal(run(why, { type: 'why', card: 'q1' }), why);
  const answered = reply(why, 'q1', 'Because AC 3 needs it.');
  assert.equal(run(answered, { type: 'why', card: 'q1' }).events.length, 2);
});

test('rejecting a reading sends the focus to the reply box and records nothing', () => {
  const state = run(reply(round(), 'q1', 'I read that as A.', { option: 'a' }), { type: 'reject', card: 'q1', message: 1 });
  assert.equal(state.answers.q1, undefined);
  assert.equal(state.focus, ids.reply('q1'));
  assert.equal(state.threads.q1?.[0]?.settled, 'rejected');
});

test('accept recommended skips gates and cards without a recommendation', () => {
  const state = round([card('q1'), card('q2', { gate: true }), card('q3', { recommended: undefined })]);
  assert.deepEqual(acceptable(state).map(item => item.id), ['q1']);
  const after = run(state, { type: 'accept-rest' });
  assert.deepEqual(Object.keys(after.answers), ['q1']);
});

test('send delivers every answer once, lists unanswered cards as open, and closes the round', () => {
  const state = run(round(), { type: 'send' });
  assert.equal(state.status, 'open', 'nothing answered: send does nothing');
  const sent = run(round(), { type: 'choose', card: 'q1', answer: { kind: 'decide' } }, { type: 'choose', card: 'q2', answer: { kind: 'option', option: 'b' } }, { type: 'send' });
  assert.equal(sent.status, 'sent');
  const event = sent.events.at(-1)!;
  assert.equal(event.kind, 'answers');
  assert.equal(event.delivery, 'queued');
  const payload = JSON.parse(event.text.split('\n')[1]!);
  assert.deepEqual(payload.open, ['q3']);
  assert.equal(payload.answers[0].label, 'You decide (recommended: Option A)');
  assert.equal(payload.answers[1].by, 'you');
  assert.equal(run(sent, { type: 'choose', card: 'q3', answer: { kind: 'none' } }), sent, 'a sent round takes no more answers');
});

test('cancel is its own fact, distinct from an answer', () => {
  const cancelled = run(round(), { type: 'choose', card: 'q1', answer: { kind: 'none' } }, { type: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.events.at(-1)?.kind, 'cancelled');
  assert.doesNotMatch(cancelled.events.at(-1)!.text, /"answers"/);
});

test('the echo is built from the card itself, including what it does not decide', () => {
  const c = card('q1', { leaves: 'whether old rows are backfilled' });
  assert.equal(echo(c, { kind: 'option', option: 'a' }), 'Option A → Does A. · does not decide: whether old rows are backfilled');
  assert.notEqual(echo(c, { kind: 'option', option: 'a' }), echo(c, { kind: 'option', option: 'b' }));
});

test('batches apply contiguously once; replays and gaps are ignored', () => {
  const state = round();
  const choose = { type: 'choose' as const, card: 'q1', answer: { kind: 'option' as const, option: 'a' } };
  const once = applyBatch(state, { generation: state.generation, epoch: 'e1', items: [{ seq: 1, action: choose }] });
  assert.deepEqual(once.ack, { epoch: 'e1', seq: 1 });
  assert.equal(applyBatch(once, { generation: state.generation, epoch: 'e1', items: [{ seq: 1, action: choose }] }), once);
  const gap = applyBatch(once, { generation: state.generation, epoch: 'e1', items: [{ seq: 3, action: { type: 'send' } }] });
  assert.equal(gap.status, 'open');
  assert.equal(applyBatch(once, { generation: 'other', epoch: 'e1', items: [{ seq: 2, action: { type: 'send' } }] }), once);
  assert.equal(parseBatch({ generation: 'g', epoch: 'e', items: [{ seq: 1, action: { type: 'choose', card: 'q', answer: { kind: 'text', text: 'x' } } }] }), undefined);
});

test('a revision replaces the card and drops an answer whose option it removed', () => {
  const state = run(round(), { type: 'choose', card: 'q1', answer: { kind: 'option', option: 'b' } });
  const revised = reply(state, 'q1', 'The ticket was stale; corrected.', undefined, card('q1', { options: [{ id: 'a', label: 'Option A', consequence: 'A', by: 'claude' }, { id: 'c', label: 'Option C', consequence: 'C', by: 'claude' }] }));
  assert.equal(revised.answers.q1, undefined);
  assert.equal(revised.cards[0]!.options[1]!.id, 'c');
});

test('delivery is tracked per event, never replayed, and a reload marks the queued ones failed', () => {
  const state = run(round(), { type: 'why', card: 'q1' });
  assert.equal(newlyQueued(null, state).length, 1);
  assert.equal(newlyQueued(state, state).length, 0);
  const sent = markEvent(state, state.events[0]!.id, 'sent');
  assert.equal(markEvent(sent, state.events[0]!.id, 'failed'), sent);
  const reloaded = interrupted(state);
  assert.equal(reloaded.events[0]!.delivery, 'failed');
  assert.match(reloaded.events[0]!.error!, /reload/);
});

test('fixture rounds keep their events local and canned replies propose readings', () => {
  const fixture = run(round(undefined, true), { type: 'why', card: 'q1' });
  assert.equal(fixture.events[0]!.delivery, 'local');
  const c = DEMO.cards[1]!;
  assert.deepEqual(fixtureReply(c, { id: 1, from: 'you', kind: 'note', text: 'just commit' }).reading, { option: 'commit' });
  assert.deepEqual(fixtureReply(DEMO.cards[2]!, { id: 1, from: 'you', kind: 'note', text: 'run it' }).reading, { option: 'run' });
  assert.equal(fixtureReply(c, { id: 1, from: 'you', kind: 'question', text: 'what does push do?' }).reading, undefined);
});

test('withdraw closes an open round without an event; decisions come from keyed answers', () => {
  assert.equal(withdraw(round()).status, 'withdrawn');
  assert.equal(withdraw(round()).events.length, 0);
  const keyed = run(round([card('q1', { key: 'k1' }), card('q2')]), { type: 'choose', card: 'q1', answer: { kind: 'option', option: 'a' } });
  assert.deepEqual(decisionsFrom(keyed, '2026-10-16T00:00:00Z').map(item => [item.key, item.answer]), [['k1', 'Option A']]);
});

// --- review fixes -------------------------------------------------------------

test('inherited names cannot be card ids or decision keys, in an ask or a revision', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(validateAsk({ title: 't', cards: [card(name)] }).ok, false, `id ${name}`);
    assert.equal(validateAsk({ title: 't', cards: [card('x', { key: name })] }, {}).ok, false, `key ${name}`);
    assert.equal(validateCard(card(name)).ok, false, `revised id ${name}`);
  }
});

test('a revision onto a settled key must say what changed, as an ask must', () => {
  const decided = { 'db.engine': { key: 'db.engine', question: 'Which DB?', answer: 'Postgres', at: '2026-10-01T10:00:00Z', round: 'r' } };
  const refused = validateCard(card('x', { key: 'db.engine' }), 'revise', decided);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.errors[0]!.message, /already decided "Postgres"/);
  assert.equal(validateCard(card('x', { key: 'db.engine', changed: 'The host dropped it.' }), 'revise', decided).ok, true);
});

test('a reading for an option a revision removed cannot be confirmed', () => {
  let state = reply(round(), 'q1', 'I read that as B.', { option: 'b' });
  state = reply(state, 'q1', 'Corrected.', undefined, card('q1', { options: [{ id: 'a', label: 'Option A', consequence: 'A', by: 'claude' }, { id: 'c', label: 'Option C', consequence: 'C', by: 'claude' }] }));
  assert.equal(run(state, { type: 'confirm', card: 'q1', message: 1 }), state);
  assert.equal(state.answers.q1, undefined);
});

test('a revision always asks again, even when the option ids survive', () => {
  const state = run(round(), { type: 'choose', card: 'q1', answer: { kind: 'option', option: 'a' } }, { type: 'choose', card: 'q2', answer: { kind: 'none' } });
  const revised = reply(state, 'q1', 'Option A now also pushes.', undefined, card('q1', { options: [{ id: 'a', label: 'Commit and push', consequence: 'Pushes', by: 'claude' }, { id: 'b', label: 'Option B', consequence: 'B', by: 'you' }] }));
  assert.equal(revised.answers.q1, undefined);
  assert.deepEqual(revised.answers.q2, { kind: 'none' }, 'other cards keep their answers');
});
