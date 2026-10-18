import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEMO } from '../src/fixtures'

const VIEWPORT = { columns: 120, rows: 40, isFullscreen: true }
const BAND = {
  plugin: 'interviewer',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  requestId: 'above-prompt',
  viewport: VIEWPORT,
}
const PANE = {
  plugin: 'interviewer',
  component: 'Pane' as const,
  props: { title: 'Interview', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 34 }, view: {} },
  requestId: 'interviewer-pane',
  viewport: { columns: 100, rows: 36, isFullscreen: true },
}
const BAND_KEY = 'interviewer-band'

type On = Parameters<typeof mock.store>[0]

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, question: `Pick ${id}?`, why: 'Needed to continue.', evidence: [{ source: 'spec.md', asOf: 'read 10:00' }],
  options: [
    { id: 'a', label: 'Option A', consequence: 'Does A.', by: 'claude' },
    { id: 'b', label: 'Option B', consequence: 'Does B.', by: 'you' },
  ],
  recommended: { option: 'a', reason: 'A is safer.' },
  ...extra,
})

// Most tests run where the surface declines an unasked pane, so the card is in the band.
function baselines(on: On, prompts: string[] = [], opened: string[] = [], placed = false, closed: string[] = []): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  mock.store(on)
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'terminal narrower than 144 columns' } } })
  on('ui.close', (_$, e) => { closed.push(e.id); return { value: undefined } })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__interviewer__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: 'engine dialog' }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
}

async function start($: Engine, interactive = true): Promise<void> {
  await $.session.start({ cwd: '/workspace/interviewer', surface: interactive ? 'terminal' : null, isInteractive: interactive })
}

async function call($: Engine, tool: string, input: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const outcome = await $.tool.call({ tool, ...input })
  if ('deny' in outcome) throw new Error(typeof outcome.deny === 'string' ? outcome.deny : 'tool denied')
  if (!('result' in outcome) || typeof outcome.result !== 'string') throw new Error(`${tool} did not return JSON`)
  return JSON.parse(outcome.result) as Record<string, any>
}

async function denied($: Engine, tool: string, input: Record<string, unknown>): Promise<string> {
  const outcome = await $.tool.call({ tool, ...input })
  if (!('deny' in outcome)) throw new Error(`${tool} was not refused`)
  return String(outcome.deny)
}

async function command($: Engine, args: string): Promise<string> {
  return String(((await $.command.run({ command: 'interview', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })) as any).text)
}

async function round($: Engine): Promise<Record<string, any>> {
  return (await call($, 'mcp__interviewer__read')).round
}

function batch(generation: string, items: unknown[], epoch = 'e1'): any {
  return { generation, epoch, items: items.map((action, index) => ({ seq: index + 1, action })) }
}

test('a card missing its reasons is refused with the paths to fix', async ($, on) => {
  baselines(on)
  await start($)
  const reason = await denied($, 'mcp__interviewer__ask', { title: 'T', cards: [{ id: 'x', question: 'Do it?', options: [] }] })
  expect(reason).toContain('cards[0].why')
  expect(reason).toContain('cards[0].evidence')
  expect(await round($)).toBeNull()
})

test('ask is pending, draws one card in the band with digit hotkeys, and nothing is sent yet', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Spec gaps', cards: [card('q1'), card('q2')] })
  expect(asked).toMatchObject({ status: 'pending', cards: 2 })
  expect(String(asked.instruction)).toContain('not an answer')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const client = await band.find({ type: 'Client', key: BAND_KEY })
  expect(client).toBeDefined()
  expect(((client?.props.props as any).round).cards).toHaveLength(2)
  expect(await band.find({ type: 'Button', key: 'interviewer-hot-1' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'interviewer-hot-2' })).toBeDefined()
  expect(prompts).toHaveLength(0)

  await denied($, 'mcp__interviewer__ask', { title: 'Another', cards: [card('z')] })
})

test('answers go back together, once, after Send; the decision log then guards the key', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  const clock = mock.clock(on)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Spec gaps', cards: [card('q1', { key: 'storage.engine' }), card('q2')] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  // The native hotkey button answers the current card without a model call.
  await band.press({ key: 'interviewer-hot-2' })
  expect((await round($)).cards[0].answer).toBe('Option B')
  await clock.advance(0)
  expect(prompts).toHaveLength(0)

  const first = batch(asked.round, [{ type: 'choose', card: 'q2', answer: { kind: 'decide' } }, { type: 'send' }])
  await band.post(first, { in: BAND_KEY })
  await band.post(first, { in: BAND_KEY })
  await clock.advance(0)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('"type":"interviewer.answers"')
  expect(prompts[0]).toContain('"label":"Option B"')
  expect(prompts[0]).toContain('You decide (recommended: Option A)')
  const after = await round($)
  expect(after.status).toBe('sent')
  expect(after.events.at(-1)).toMatchObject({ kind: 'answers', delivery: 'sent' })

  const log = await call($, 'mcp__interviewer__read')
  expect(log.decisions[0]).toMatchObject({ key: 'storage.engine', answer: 'Option B' })
  const reason = await denied($, 'mcp__interviewer__ask', { title: 'Again', cards: [card('q9', { key: 'storage.engine' })] })
  expect(reason).toContain('already decided')
  expect(await call($, 'mcp__interviewer__ask', { title: 'Again', cards: [card('q9', { key: 'storage.engine', changed: 'The host dropped it.' })] })).toMatchObject({ status: 'pending' })
})

test('a typed reply escalates that card only; Claude proposes a reading the operator confirms', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  const clock = mock.clock(on)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Spec gaps', cards: [card('q1'), card('q2')] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.post(batch(asked.round, [{ type: 'draft', card: 'q1', value: 'are these nits?' }, { type: 'say', card: 'q1' }]), { in: BAND_KEY })
  await clock.advance(0)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('"type":"interviewer.escalation"')
  expect(prompts[0]).toContain('"kind":"question"')
  expect((await round($)).cards[0]).toMatchObject({ answer: null, waitingForYou: true })

  await denied($, 'mcp__interviewer__reply', { round: asked.round, card: 'nope', text: 'x' })
  await denied($, 'mcp__interviewer__reply', { round: asked.round, card: 'q1', text: 'x', reading: { option: 'zzz' } })
  expect(await call($, 'mcp__interviewer__reply', { round: asked.round, card: 'q1', text: 'They are required by AC 3.', reading: { option: 'b' } })).toMatchObject({ status: 'shown' })
  expect((await round($)).cards[0]).toMatchObject({ answer: null, waitingForYou: false })

  await band.post({ generation: asked.round, epoch: 'e1', items: [{ seq: 3, action: { type: 'confirm', card: 'q1', message: 2 } }] }, { in: BAND_KEY })
  await clock.advance(0)
  expect((await round($)).cards[0].answer).toBe('Option B')
  expect(prompts).toHaveLength(1)
})

test('keys typed into the band client reach the round', async ($, on) => {
  baselines(on)
  mock.clock(on)
  await start($)
  await call($, 'mcp__interviewer__ask', { title: 'Keys', cards: [card('q1'), card('q2')] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.key({ key: '2', in: BAND_KEY })
  const after = await round($)
  expect(after.cards[0].answer).toBe('Option B')
  expect(after.current).toBe('q2')
})

test('the demo is a fixture: canned replies, local events, never a prompt', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  const clock = mock.clock(on)
  await start($)
  expect(await command($, 'demo')).toContain('Nothing reaches Claude')
  const demo = await round($)
  expect(demo).toMatchObject({ fixture: true, status: 'open' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.post(batch(demo.round, [{ type: 'why', card: DEMO.cards[0]!.id }, { type: 'choose', card: DEMO.cards[0]!.id, answer: { kind: 'none' } }, { type: 'send' }]), { in: BAND_KEY })
  await clock.advance(1_000)
  const after = await round($)
  expect(after.status).toBe('sent')
  expect(after.events.every((event: any) => event.delivery === 'local')).toBe(true)
  expect(prompts).toHaveLength(0)
  expect((await call($, 'mcp__interviewer__read')).decisions).toHaveLength(0)
})

test('AskUserQuestion works normally until the operator turns the redirect on', async ($, on) => {
  baselines(on)
  await start($)
  const ask = { tool: 'AskUserQuestion', questions: [{ question: 'A or B?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] }
  expect(await $.tool.call(ask)).toMatchObject({ result: 'engine dialog' })
  expect(await command($, 'redirect on')).toContain('refused')
  const outcome = await $.tool.call(ask)
  expect('deny' in outcome && String(outcome.deny)).toContain('mcp__interviewer__ask')
  await command($, 'redirect off')
  expect(await $.tool.call(ask)).toMatchObject({ result: 'engine dialog' })
})

test('without an interactive surface ask says so and creates nothing', async ($, on) => {
  baselines(on)
  await start($, false)
  expect(await call($, 'mcp__interviewer__ask', { title: 'T', cards: [card('q1')] })).toMatchObject({ status: 'unavailable' })
  expect(await round($)).toBeNull()
})

test('the pane draws the same card, and the round moves back to the band without being cancelled', async ($, on) => {
  const opened: string[] = []
  baselines(on, [], opened, true)
  await start($)
  await call($, 'mcp__interviewer__ask', { title: 'Pane', cards: [card('q1')] })
  expect(await command($, 'pane')).toContain('opened in a pane')
  expect(opened).toEqual(['interviewer-pane', 'interviewer-pane'])
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Client', key: 'interviewer-pane' })).toBeDefined()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Client', key: BAND_KEY })).toBeUndefined()
  expect(await command($, 'band')).toContain('back above the prompt')
  expect((await round($)).location).toBe('band')
  expect((await round($)).status).toBe('open')
})

test('a reload records an unsent continuation as failed instead of leaving it queued', async ($, on) => {
  baselines(on)
  mock.clock(on)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Reload', cards: [card('q1')] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.post(batch(asked.round, [{ type: 'why', card: 'q1' }]), { in: BAND_KEY })
  expect((await round($)).events[0].delivery).toBe('queued')
  await start($)
  const after = await round($)
  expect(after.events[0].delivery).toBe('failed')
  expect(after.events[0].error).toContain('reload')
})

test('withdraw closes the round without a continuation; cancel tells Claude', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  const clock = mock.clock(on)
  await start($)
  const first = await call($, 'mcp__interviewer__ask', { title: 'One', cards: [card('q1')] })
  expect(await call($, 'mcp__interviewer__withdraw', { round: first.round })).toMatchObject({ status: 'withdrawn' })
  await clock.advance(0)
  expect(prompts).toHaveLength(0)
  await call($, 'mcp__interviewer__ask', { title: 'Two', cards: [card('q1')] })
  expect(await command($, 'cancel')).toContain('Cancelled')
  await clock.advance(0)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('"type":"interviewer.cancelled"')
})

test('standing rules ride along with every continuation', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  const clock = mock.clock(on)
  await start($)
  await command($, 'rule fix plan defects of this class without asking')
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Rules', cards: [card('q1')] })
  expect(asked.standingRules).toEqual(['fix plan defects of this class without asking'])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.post(batch(asked.round, [{ type: 'choose', card: 'q1', answer: { kind: 'none' } }, { type: 'send' }]), { in: BAND_KEY })
  await clock.advance(0)
  expect(prompts[0]).toContain('standing rules: (1) fix plan defects of this class without asking')
})

test('a reply that lands after the operator sent the round says so instead of claiming no round exists', async ($, on) => {
  baselines(on)
  mock.clock(on)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Race', cards: [card('q1')] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.post(batch(asked.round, [{ type: 'why', card: 'q1' }, { type: 'choose', card: 'q1', answer: { kind: 'option', option: 'a' } }, { type: 'send' }]), { in: BAND_KEY })
  const reason = await denied($, 'mcp__interviewer__reply', { round: asked.round, card: 'q1', text: 'Because.' })
  expect(reason).toContain('already sent')
  expect(reason).toContain('Interviewer answers')
})

test('ask opens the whole card in a pane beside the transcript, with digits under it', async ($, on) => {
  const opened: string[] = []
  baselines(on, [], opened, true)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Docked', cards: [card('q1'), card('q2')] })
  expect(String(asked.shown)).toContain('pane beside the transcript')
  expect(opened).toEqual(['interviewer-pane'])
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = await pane.find({ type: 'Client', key: 'interviewer-pane' })
  expect((drawn?.props.props as any).detail).toBe('full')
  expect(Number(drawn?.props.width)).toBeLessThan(101)
  expect(await pane.find({ type: 'Button', key: 'interviewer-hot-2' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'interviewer-full' })).toBeUndefined()
  await pane.press({ key: 'interviewer-hot-2' })
  expect((await round($)).cards[0].answer).toBe('Option B')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Client', key: BAND_KEY })).toBeUndefined()
})

test('a declined pane falls back to the band, is closed, and the band offers the full card', async ($, on) => {
  const opened: string[] = []
  const closed: string[] = []
  baselines(on, [], opened, false, closed)
  await start($)
  const asked = await call($, 'mcp__interviewer__ask', { title: 'Narrow', cards: [card('q1')] })
  expect(String(asked.shown)).toContain('above the prompt')
  expect(closed).toEqual(['interviewer-pane'])
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 140 }, surface: 'terminal' })
  const drawn = await band.find({ type: 'Client', key: BAND_KEY })
  expect(Number(drawn?.props.width)).toBe(100)
  expect(await band.find({ type: 'Button', key: 'interviewer-full' })).toBeDefined()
  await band.press({ key: 'interviewer-full' })
  expect(opened).toEqual(['interviewer-pane', 'interviewer-pane'])
})

test('a short band gets the compact card', async ($, on) => {
  baselines(on)
  await start($)
  await command($, 'demo')
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 16, scroll: { offset: 0, bodyRows: 15 } }, surface: 'terminal' })
  const drawn = await band.find({ type: 'Client', key: BAND_KEY })
  expect((drawn?.props.props as any).detail).toBe('compact')
})

test('a card taller than the band is drawn whole for the host to scroll, digits first', async ($, on) => {
  baselines(on)
  await start($)
  await command($, 'demo')
  const short = { ...BAND, props: { ...BAND.props, maxRows: 10, scroll: { offset: 0, bodyRows: 9 } }, surface: 'terminal' as const }
  const band = await $.ui.mount(short)
  const drawn = await band.find({ type: 'Client', key: BAND_KEY })
  expect(Number(drawn?.props.height)).toBeGreaterThan(10)
  expect(await band.find({ type: 'Button', key: 'interviewer-hot-1' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'interviewer-full' })).toBeDefined()
})

test('scrolling is the host\'s: a wheel tick goes three rows, keys are unchanged, the round never moves', async ($, on) => {
  baselines(on, [], [], true)
  // Beneath the plugin, as the engine's own window would take it.
  const offsets: number[] = []
  on('ui.scroll', (_$, e) => { offsets.push(e.offset); return {} })
  await start($)
  await command($, 'demo')
  const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } }, surface: 'terminal' })
  const drawn = await pane.find({ type: 'Client', key: 'interviewer-pane' })
  expect(Number(drawn?.props.height)).toBeGreaterThan(12)
  const scroll = (by: number, pointer?: object) => $.ui.scroll({ component: 'Pane', requestId: 'interviewer-pane', offset: Math.max(0, by), by, bodyRows: 12, contentRows: 40, origin: { kind: 'person' }, ...(pointer ? { pointer } : {}) } as any)
  await scroll(1, { column: 10, row: 3 })
  expect(offsets.at(-1)).toBe(3)
  await scroll(12)
  expect(offsets.at(-1)).toBe(12)
  await scroll(-1, { column: 10, row: 3 })
  expect(offsets.at(-1)).toBe(0)
  expect(((await pane.find({ type: 'Client', key: 'interviewer-pane' }))?.props.props as any).round.scroll).toBe(0)
})

test('a revision onto a settled decision key is refused unless it says what changed', async ($, on) => {
  const prompts: string[] = []
  baselines(on, prompts)
  const clock = mock.clock(on)
  await start($)
  const first = await call($, 'mcp__interviewer__ask', { title: 'Settle', cards: [card('q1', { key: 'db.engine' })] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.post(batch(first.round, [{ type: 'choose', card: 'q1', answer: { kind: 'option', option: 'a' } }, { type: 'send' }]), { in: BAND_KEY })
  await clock.advance(0)
  await band.unmount()
  const second = await call($, 'mcp__interviewer__ask', { title: 'Other', cards: [card('q2')] })
  const reason = await denied($, 'mcp__interviewer__reply', { round: second.round, card: 'q2', text: 'Corrected.', revise: card('q2', { key: 'db.engine' }) })
  expect(reason).toContain('already decided')
  expect(await call($, 'mcp__interviewer__reply', { round: second.round, card: 'q2', text: 'Corrected.', revise: card('q2', { key: 'db.engine', changed: 'The host dropped it.' }) })).toMatchObject({ status: 'shown' })
  const again = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 40 }, surface: 'terminal' })
  const drawn = await again.find({ type: 'Client', key: BAND_KEY })
  expect(((drawn?.props.props as any).round.previous)['db.engine']).toMatchObject({ answer: 'Option A' })
})
