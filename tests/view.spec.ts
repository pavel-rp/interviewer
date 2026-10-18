import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activate, keyActions } from '../src/client';
import { DEMO, DEMO_PREVIOUS } from '../src/fixtures';
import { createRound, ids, reducer, reply } from '../src/model';
import { CARD_COLUMNS, CARD_ROWS, fitDetail, naturalRows, renderRound } from '../src/view';
import type { InterviewAction, InterviewRound } from '../src/types';

const demo = (): InterviewRound => createRound(DEMO, 'iv-demo', { fixture: true, previous: DEMO_PREVIOUS });
const run = (state: InterviewRound, ...actions: InterviewAction[]) => actions.reduce(reducer, state);
const go = (state: InterviewRound, index: number) => run(state, { type: 'go', index });

test('a card shows the question, why, evidence, options with consequences, the recommendation and the escapes', () => {
  const state = demo();
  const plain = renderRound(state, 100, 60, { chrome: 'pane' }).frame.plain();
  assert.match(plain, /INTERVIEW · Rerank spec gaps \(demo\) · fixture/);
  assert.match(plain, /Q1 of 5 · 0 recorded/);
  assert.match(plain, /How should Model and Provider be filled on each rerank item\?/);
  assert.match(plain, /Why\s+AC 3\.2 requires both fields/);
  assert.match(plain, /Checked\s+01_spec\.md AC 3\.2 \(read 14:02\)/);
  assert.match(plain, /1 {2}○ Copy from the request.*Recommended · Claude does it/);
  assert.match(plain, /Because\s+It is the only option/);
  assert.match(plain, /Why\? \(w\).*None — leave it.*You decide.*You do it/);
  assert.match(plain, /Reply:/);
  assert.match(plain, /Preview · Copy from the request/);
  assert.match(plain, /"provider": "cohere"/);
});

test('the preview follows the focused option', () => {
  const state = run(demo(), { type: 'focus', id: ids.option('rerank-fields', 'from-config') });
  assert.match(renderRound(state, 100, 60, { chrome: 'pane' }).frame.plain(), /Preview · Read from settings/);
});

test('unverified premises, gates and earlier decisions are called out on the card', () => {
  assert.match(renderRound(go(demo(), 3), 100, 40, { chrome: 'pane' }).frame.plain(), /! Unverified\s+Azure DevOps is unreachable/);
  assert.match(renderRound(go(demo(), 2), 100, 40, { chrome: 'pane' }).frame.plain(), /◆ Gate\s+Outward-facing or paid/);
  assert.match(renderRound(go(demo(), 4), 100, 40, { chrome: 'pane' }).frame.plain(), /Decided before\s+"Remove Chroma" on 2026-09-30/);
});

test('a frame shorter than the card keeps the header and footer and shows a scrollbar', () => {
  const layout = renderRound(demo(), 80, 12, { chrome: 'band' });
  assert.ok(layout.contentHeight > layout.bodyRows);
  const plain = layout.frame.plain().split('\n');
  assert.match(plain[0]!, /INTERVIEW/);
  assert.match(plain.at(-1)!, /Send 0\/5/);
  assert.match(layout.frame.plain(), /┃/);
  assert.ok(naturalRows(demo(), 80, 'band') > 12);
});

test('the thread shows replies, a proposed reading with Confirm, and the waiting state', () => {
  let state = run(demo(), { type: 'draft', card: 'rerank-fields', value: 'are these nits?' }, { type: 'say', card: 'rerank-fields' });
  assert.match(renderRound(state, 100, 80, { chrome: 'pane' }).frame.plain(), /Waiting for Claude…/);
  state = reply(state, 'rerank-fields', 'No: AC 3.2 requires them.', { option: 'from-request' });
  const plain = renderRound(state, 100, 80, { chrome: 'pane' }).frame.plain();
  assert.match(plain, /You\s+are these nits\?/);
  assert.match(plain, /Claude\s+No: AC 3\.2 requires them\./);
  assert.match(plain, /Reads your reply as\s+Copy from the request/);
  assert.match(plain, /Confirm.*Not quite/);
  const rows = plain.split('\n');
  assert.ok(rows.findIndex(row => row.includes('Not quite')) < rows.findIndex(row => row.includes('Reply:')), 'the thread reads down into the reply box');
});

test('recorded answers echo their consequence, and a sent round shows a summary', () => {
  let state = run(demo(), { type: 'choose', card: 'rerank-fields', answer: { kind: 'option', option: 'from-request' } });
  assert.match(renderRound(state, 100, 80, { chrome: 'pane' }).frame.plain(), /Q1\s+Copy from the request → Every item gets/);
  state = run(state, { type: 'send' });
  const plain = renderRound(state, 100, 40, { chrome: 'pane' }).frame.plain();
  assert.match(plain, /Sent: 1 answered, 4 left open\./);
  assert.match(plain, /Fixture: kept here, never sent to Claude\./);
  assert.match(plain, /left open: Claude decides nothing for it/);
  assert.match(plain, /Dismiss/);
});

test('narrow widths still draw every footer action', () => {
  const plain = renderRound(demo(), 48, 14, { chrome: 'band' }).frame.plain();
  assert.match(plain, /◀/);
  assert.match(plain, /Send 0\/5/);
});

// --- keys ---------------------------------------------------------------------

test('digits choose, arrows move between cards, w asks why, r opens the reply box', () => {
  const state = demo();
  const layout = renderRound(state, 100, 40, { chrome: 'pane' });
  assert.deepEqual(keyActions(state, { key: '2' }, layout).at(-1), { type: 'choose', card: 'rerank-fields', answer: { kind: 'option', option: 'from-config' } });
  assert.deepEqual(keyActions(state, { key: 'right' }, layout), [{ type: 'go', index: 1 }]);
  assert.deepEqual(keyActions(state, { key: 'left' }, layout), [{ type: 'go', index: 4 }]);
  assert.deepEqual(keyActions(state, { key: 'w' }, layout), [{ type: 'why', card: 'rerank-fields' }]);
  assert.deepEqual(keyActions(state, { key: 'r' }, layout), [{ type: 'focus', id: ids.reply('rerank-fields') }]);
});

test('in the reply box keys type, and Enter sends the words to Claude rather than choosing', () => {
  let state = run(demo(), { type: 'focus', id: ids.reply('rerank-fields') });
  const cursors: Record<string, number> = {};
  for (const key of ['1', ' ', 'o', 'k', '?']) {
    for (const action of keyActions(state, { key }, renderRound(state, 100, 40), cursors)) state = reducer(state, action);
  }
  assert.equal(state.drafts['rerank-fields'], '1 ok?');
  assert.equal(state.answers['rerank-fields'], undefined);
  assert.deepEqual(keyActions(state, { key: 'return' }, renderRound(state, 100, 40), cursors), [{ type: 'say', card: 'rerank-fields' }]);
});

test('every drawn control id activates something', () => {
  const state = reply(demo(), 'rerank-fields', 'Reading.', { option: 'from-config' });
  const layout = renderRound(state, 100, 80, { chrome: 'pane' });
  for (const control of layout.controls) {
    if (control.kind === 'scroll' || control.kind === 'input') continue;
    assert.ok(activate(state, control.id).length > 0, `${control.id} does nothing`);
  }
});

test('the card keeps a readable measure on a wide terminal', () => {
  const layout = renderRound(demo(), 160, 40, { chrome: 'pane' });
  assert.equal(layout.frame.width, CARD_COLUMNS);
});

test('compact detail fits a short band: whole focused option, one line for the rest, toggles for context and preview', () => {
  const state = demo();
  assert.ok(naturalRows(state, 100, 'band', 'full') > 18);
  assert.ok(naturalRows(state, 100, 'band', 'compact') <= 16, `compact needs ${naturalRows(state, 100, 'band', 'compact')} rows`);
  assert.equal(fitDetail(state, 100, 18, 'band'), 'compact');
  assert.equal(fitDetail(state, 100, 60, 'band'), 'full');
  const plain = renderRound(state, 100, 16, { chrome: 'band', detail: 'compact' }).frame.plain();
  assert.match(plain, /One small change in\s*\n\s*rerank\.py\./, 'the focused option wraps whole');
  assert.match(plain, /2 {2}○ Read from settings — Values come from the app settings.*…/, 'the others take one line, consequence inline');
  assert.match(plain, /▸ Context \(c\).*▸ Preview \(p\)/);
  assert.doesNotMatch(plain, /Preview · /);
  assert.match(plain, /Send 0\/5/);
  const focused = run(state, { type: 'focus', id: ids.option('rerank-fields', 'from-config') });
  assert.match(renderRound(focused, 100, 30, { chrome: 'band', detail: 'compact' }).frame.plain(), /overrides the\s*\n\s*model\./, 'focus moves the whole consequence');
  const layout = renderRound(state, 100, 16, { chrome: 'band', detail: 'compact' });
  assert.deepEqual(keyActions(state, { key: 'p' }, layout), [{ type: 'toggle', card: 'rerank-fields', part: 'preview' }]);
  assert.deepEqual(activate(state, ids.preview('rerank-fields')), [{ type: 'toggle', card: 'rerank-fields', part: 'preview' }]);
});

test('an opened preview is capped in compact detail and points at the full card', () => {
  const big = createRound({ title: 'Big', cards: [{ ...DEMO.cards[0]!, options: DEMO.cards[0]!.options.map(option => ({ ...option, preview: Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n') })) }] }, 'iv-big');
  assert.doesNotMatch(renderRound(big, 100, 60, { chrome: 'band', detail: 'compact' }).frame.plain(), /line 0/);
  const opened = run(big, { type: 'toggle', card: 'rerank-fields', part: 'preview' });
  const plain = renderRound(opened, 100, 60, { chrome: 'band', detail: 'compact' }).frame.plain();
  assert.match(plain, /line 5/);
  assert.doesNotMatch(plain, /line 6/);
  assert.match(plain, /… 14 more lines: f opens the full card/);
  assert.match(renderRound(big, 100, 80, { chrome: 'pane' }).frame.plain(), /line 19/);
});

// --- review fixes -------------------------------------------------------------

const tall = (lines: number) => createRound({ title: 'Tall', cards: [{ ...DEMO.cards[0]!, options: DEMO.cards[0]!.options.map((option, index) => index ? option : { ...option, preview: Array.from({ length: lines }, (_, row) => `line ${row}`).join('\n') }) }] }, 'iv-tall');

test('a card taller than one frame is drawn whole in stacked frames, hits included', () => {
  const state = tall(60);
  const rows = naturalRows(state, 100, 'pane');
  assert.ok(rows > 64, `needs ${rows} rows`);
  const layout = renderRound(state, 100, rows, { chrome: 'pane' });
  assert.equal(layout.frame.frames.length, 2);
  const plain = layout.frame.plain();
  assert.match(plain, /line 59/);
  assert.match(plain.split('\n').at(-2)!, /Send 0\/1/);
  assert.equal(layout.contentHeight, layout.bodyRows, 'nothing left to scroll inside');
  const sendRow = plain.split('\n').findIndex(row => row.includes('Send 0/1'));
  const hit = layout.frame.hitAt(plain.split('\n')[sendRow]!.indexOf('Send') + 1, sendRow);
  assert.equal(hit?.id, ids.send);
  assert.equal(hit?.y, sendRow);
});

test('the drawn tree of the tallest card stays well inside the host\'s bounds for a Client', () => {
  const huge = createRound({ title: 'Huge', cards: [{ ...DEMO.cards[0]!, context: 'context '.repeat(480), options: DEMO.cards[0]!.options.map(option => ({ ...option, consequence: 'consequence '.repeat(33), preview: Array.from({ length: 60 }, (_, row) => `${row} ${'x'.repeat(60)}`).join('\n') })) }] }, 'iv-huge');
  const opened = run(huge, { type: 'toggle', card: 'rerank-fields' });
  const layout = renderRound(opened, 40, naturalRows(opened, 40, 'pane'), { chrome: 'pane' });
  assert.equal(layout.frame.height, CARD_ROWS);
  const element = (type: string) => (props: Record<string, unknown>) => ({ type, props });
  const tree = JSON.stringify(layout.frame.toTree({ Text: element('Text'), Box: element('Box') } as any));
  assert.ok(tree.length < 70_000, `tree is ${tree.length} characters`);
});

test('a narrow card wraps its footer instead of dropping Send and Cancel', () => {
  const state = createRound({ title: 'Narrow', cards: DEMO.cards.slice(0, 3) }, 'iv-narrow');
  const layout = renderRound(state, 40, 40, { chrome: 'band' });
  for (const id of [ids.prev, ids.next, ids.accept, ids.send, ids.cancel]) assert.ok(layout.controls.some(control => control.id === id), `${id} is reachable`);
  const plain = layout.frame.plain();
  assert.match(plain, /Send 0\/3/);
  assert.match(plain, /Cancel/);
  assert.ok(naturalRows(state, 40, 'band') > naturalRows(state, 100, 'band') - 30, 'footer rows are counted');
});

test('a stale reading shows why it cannot be confirmed instead of a Confirm button', () => {
  let state = reply(demo(), 'rerank-fields', 'Reads as settings.', { option: 'from-config' });
  state = reply(state, 'rerank-fields', 'Corrected.', undefined, { ...DEMO.cards[0]!, options: DEMO.cards[0]!.options.filter(option => option.id !== 'from-config') });
  const plain = renderRound(state, 100, 80, { chrome: 'pane' }).frame.plain();
  assert.match(plain, /That option was revised away/);
  assert.doesNotMatch(plain, /Confirm {3,}Not quite/);
});
