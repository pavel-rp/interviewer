import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register } from 'claude-code'

import { ASK_SCHEMA, CARD_SCHEMA, LIMITS, validateAsk, validateCard, validateReading } from '../src/card'
import { DEMO, DEMO_PREVIOUS, fixtureReply } from '../src/fixtures'
import {
  applyBatch, createRound, current, decisionsFrom, findCard, interrupted, markEvent, parseBatch, publicRound, reducer, reply, withdraw,
} from '../src/model'
import { CARD_COLUMNS, naturalRows } from '../src/view'
import type { Detail } from '../src/view'
import type { InterviewAction, InterviewCard, InterviewDecision, InterviewEvent, InterviewRound } from '../types'

// The host adapter: tools, the band and pane, client messages, delivery and the
// operator's /interview command. All interview rules live in src/.

const ROUND_REF = { plugin: 'interviewer', key: 'round' } as const
const roundAtom = atom(ROUND_REF, null)
const PANE_ID = 'interviewer-pane'
const BAND_KEY = 'interviewer-band'
const PANE_KEY = 'interviewer-pane'
const CLIENT_MATCH = /^interviewer-(band|pane)$/

const observed = { interactive: false, supported: false }
// The host never tells a band Client that Escape returned the keyboard. A band
// message proves the band held it; a prompt edit proves it no longer does.
let bandKeyboard = false
let retiringPane = false
// The dock's requested width: beside the transcript, not across the terminal.
const PANE_COLUMNS = 84
// Observed site geometry, refreshed on every draw: picks the band's detail and
// bounds the pane's wheel scrolling.
const sites = { band: { columns: CARD_COLUMNS, rows: 18 } }
// The band's requestId as last drawn, so a new card can scroll it back to the top,
// and whether the card is what the band shows now.
let bandSite = ''
let bandDrawn = false

// Card heights by round state: the host redraws far more often than the round changes.
const heights = new Map<string, number>()
function rowsOf(round: InterviewRound, columns: number, chrome: 'band' | 'pane', detail: Detail = 'full'): number {
  const key = `${round.generation}:${round.serial}:${columns}:${chrome}:${detail}`
  let rows = heights.get(key)
  if (rows === undefined) {
    if (heights.size > 64) heights.clear()
    heights.set(key, rows = naturalRows(round, columns, chrome, detail))
  }
  return rows
}

type $ = CoreEngineInterface
const json = (value: unknown): string => JSON.stringify(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const live = (round: InterviewRound | null): round is InterviewRound => !!round && round.status === 'open'

// ---------------------------------------------------------------------------
// Durable operator memory: kept between sessions in this plugin's own store.

async function decisions($: $): Promise<Record<string, InterviewDecision>> {
  const value = await $.store.get('decisions')
  return isRecord(value) ? value as Record<string, InterviewDecision> : {}
}

async function rules($: $): Promise<string[]> {
  const value = await $.store.get('rules')
  return Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === 'string') : []
}

// ---------------------------------------------------------------------------
// Every round write goes through commit, which then schedules what it owes:
// continuations for new queued events, canned replies for fixture escalations,
// and the decision log for a round just sent.

async function commit<T>($: $, change: (round: InterviewRound | null) => { round: InterviewRound | null; out: T }): Promise<T> {
  let outcome: { round: InterviewRound | null; out: T } | undefined
  let before: InterviewRound | null = null
  await update($, roundAtom, current => {
    before = current ?? null
    outcome = change(before)
    return outcome.round
  })
  const after = outcome!.round
  if (after) await follow($, before, after)
  return outcome!.out
}

async function follow($: $, before: InterviewRound | null, after: InterviewRound): Promise<void> {
  const known = new Set(before?.generation === after.generation ? before.events.map(event => event.id) : [])
  const fresh = after.events.filter(event => !known.has(event.id))
  for (const event of fresh) {
    if (event.delivery === 'queued') scheduleDelivery($, after.generation, event)
    if (after.fixture && event.kind === 'escalation' && event.card) $.clock.after(500, () => { void fixtureRespond($, after.generation, event.card!) })
  }
  if (!after.fixture && fresh.some(event => event.kind === 'answers')) {
    const log = { ...(await decisions($)) }
    for (const decision of decisionsFrom(after, new Date().toISOString())) log[decision.key] = decision
    await $.store.set('decisions', log)
  }
  if (before?.status === 'open' && after.status !== 'open' && after.location === 'band') releaseBand($)
  if (after.dismissed && !before?.dismissed && after.location === 'pane') await retirePane($)
  // The host scrolls a card taller than its site; the next card starts at its top.
  const site = after.location === 'pane' ? PANE_ID : bandSite
  if (site && before?.generation === after.generation && (before.at !== after.at || before.status !== after.status)) {
    $.clock.after(0, () => { void $.ui.scroll({ in: site, to: 'start' }).catch(() => undefined) })
  }
}

async function retirePane($: $): Promise<void> {
  retiringPane = true
  try { await $.ui.close({ id: PANE_ID }) } catch { /* already closed */ } finally { retiringPane = false }
}

// The pane and the band lay the card out differently, so a move starts at the top.
async function setLocation($: $, generation: string, location: 'band' | 'pane'): Promise<void> {
  await commit($, round => ({ round: round && round.generation === generation && round.location !== location ? { ...round, location, scroll: 0, serial: round.serial + 1 } : round, out: undefined }))
}

/**
 * The card is always drawn at its full height and the host scrolls the band
 * or pane over it, so no plugin state moves while scrolling. A wheel tick (it
 * carries a pointer) goes three rows instead of one; scroll keys are unchanged.
 */
const WHEEL_ROWS = 3
const quickened = (e: { offset: number; by: number }): number => Math.max(0, e.offset + (WHEEL_ROWS - 1) * e.by)

/**
 * Show the round whole in a pane docked beside the transcript (inline above the
 * prompt on a narrow or non-fullscreen terminal). When the surface declines,
 * the round stays in the band, and the waiting pane is closed so it never
 * appears later on its own.
 */
async function place($: $, generation: string): Promise<{ placed: true } | { placed: false; reason: string }> {
  const round = await read($, roundAtom)
  if (!round || round.generation !== generation || round.dismissed) return { placed: false, reason: 'no interview to show' }
  await setLocation($, generation, 'pane')
  releaseBand($)
  const rows = Math.min(48, rowsOf(round, PANE_COLUMNS, 'pane') + answerBarRows(round, PANE_COLUMNS))
  const opened = await $.ui.open({ id: PANE_ID, title: `Interview · ${round.title}`, focus: true, columns: PANE_COLUMNS, rows })
  if (opened.isPlaced) return { placed: true }
  await setLocation($, generation, 'band')
  await retirePane($)
  return { placed: false, reason: opened.reason }
}

function releaseBand($: $): void {
  if (!bandKeyboard) return
  bandKeyboard = false
  $.ui.invalidate('ui.render')
}

// ---------------------------------------------------------------------------
// Delivery: one continuation per event, never replayed.

async function deliver($: $, generation: string, event: InterviewEvent): Promise<void> {
  let delivery: 'sent' | 'failed' = 'sent'
  let error = ''
  try {
    const standing = await rules($)
    const text = standing.length ? `${event.text}\nThe operator's standing rules: ${standing.map((rule, index) => `(${index + 1}) ${rule}`).join(' ')}` : event.text
    const submitted = await $.prompt.submit({ text })
    // A hook may decline without throwing; nothing entered the session then.
    if (typeof submitted.drop === 'string') { delivery = 'failed'; error = `Declined: ${submitted.drop}`.slice(0, 240) }
  } catch (caught) {
    delivery = 'failed'
    error = caught instanceof Error ? caught.message.slice(0, 240) : 'Prompt submission failed'
  }
  await commit($, round => ({ round: round && round.generation === generation ? markEvent(round, event.id, delivery, error) : round, out: undefined }))
  if (delivery === 'failed') $.ui.toast('The interviewer could not reach Claude; the card shows why.')
}

function scheduleDelivery($: $, generation: string, event: InterviewEvent): void {
  // A separate dispatch: prompt.submit cannot run while a UI event or command resolves.
  $.clock.after(0, () => { void deliver($, generation, event) })
}

async function fixtureRespond($: $, generation: string, cardId: string): Promise<void> {
  await commit($, round => {
    if (!round || round.generation !== generation || round.status !== 'open') return { round, out: undefined }
    const card = findCard(round, cardId)
    const thread = round.threads[cardId] ?? []
    const last = thread[thread.length - 1]
    if (!card || !last || last.from !== 'you') return { round, out: undefined }
    const canned = fixtureReply(card, last)
    return { round: reply(round, cardId, canned.text, canned.reading), out: undefined }
  })
}

/** An operator action that arrives through a native element rather than the client. */
async function act($: $, generation: string, action: InterviewAction): Promise<void> {
  await commit($, round => ({ round: round && round.generation === generation ? reducer(round, action) : round, out: undefined }))
}

function settledInstruction(round: InterviewRound): string {
  if (round.status === 'sent') return 'The operator sent their answers before your reply landed. Act on the "Interviewer answers" message instead; do not re-ask.'
  if (round.status === 'cancelled') return 'The operator cancelled the round. Decide nothing from it.'
  return 'You withdrew this round. Ask again only if the questions still matter.'
}

function newGeneration(): string {
  return `iv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Client messages from the band or the pane.

async function onClientMessage($: $, e: { element: string; data: unknown }) {
  const chrome = e.element === PANE_KEY ? 'pane' as const : 'band' as const
  if (isRecord(e.data) && e.data.keyboard === true && Object.keys(e.data).length === 2) {
    if (chrome === 'band' && !bandKeyboard) {
      bandKeyboard = true
      $.ui.invalidate('ui.render')
    }
    return {}
  }
  const batch = parseBatch(e.data)
  if (!batch) return {}
  const after = await commit($, round => {
    if (!round || round.generation !== batch.generation) return { round, out: round }
    const next = applyBatch(round, batch)
    return { round: next, out: next }
  })
  if (chrome === 'band' && !bandKeyboard && after?.status === 'open') {
    bandKeyboard = true
    $.ui.invalidate('ui.render')
  }
  return after && after.generation === batch.generation ? { props: clientProps(after, chrome) } : {}
}

// ---------------------------------------------------------------------------
// Drawing

type RenderEvent = Parameters<$['ui']['resolve']>[0]

/** The band shows the whole card when it fits and the compact one otherwise; a pane always the whole card. */
function detailFor(round: InterviewRound, chrome: 'band' | 'pane'): Detail {
  return chrome === 'pane' || rowsOf(round, sites.band.columns, 'band') <= sites.band.rows ? 'full' : 'compact'
}

function clientProps(round: InterviewRound, chrome: 'band' | 'pane') {
  return { round: clone(round), keyboard: chrome === 'pane' || bandKeyboard, chrome, detail: detailFor(round, chrome) }
}

function client($: $, e: RenderEvent, round: InterviewRound, chrome: 'band' | 'pane', width: number, height: number) {
  const resolved = $.ui.resolve(e)
  if (!('Client' in resolved)) return <resolved.Text>The interviewer needs a terminal or desktop surface.</resolved.Text>
  const { Client } = resolved
  return <Client key={chrome === 'pane' ? PANE_KEY : BAND_KEY} module="../src/client.ts" props={clientProps(round, chrome)} width={width} height={height} />
}

const HOTKEY_LABEL = 26

const FULL_CARD = 'Full card'

/**
 * Native buttons a bare digit presses from an empty prompt (the band) or while
 * the pane holds the keys, like the engine's own survey. The band adds the way
 * to the whole card.
 */
function answerBar($: $, e: RenderEvent, round: InterviewRound, chrome: 'band' | 'pane') {
  const { Box, Button } = $.ui.resolve(e)
  const card = current(round)
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {card.options.map((option, index) => (
        <Button key={`interviewer-hot-${index + 1}`} hotkey={String(index + 1)} plain label={option.label.length > HOTKEY_LABEL ? `${option.label.slice(0, HOTKEY_LABEL - 1)}…` : option.label}
          onPress={() => act($, round.generation, { type: 'choose', card: card.id, answer: { kind: 'option', option: option.id } })} />
      ))}
      {chrome === 'band' ? <Button key="interviewer-full" hotkey="f" plain label={FULL_CARD} onPress={() => place($, round.generation)} /> : null}
    </Box>
  )
}

function answerBarRows(round: InterviewRound, width: number, chrome: 'band' | 'pane' = 'pane'): number {
  const labels = current(round).options.map((option, index) => `${index + 1}: ${option.label.slice(0, HOTKEY_LABEL)}`)
  if (chrome === 'band') labels.push(`f: ${FULL_CARD}`)
  const cells = labels.reduce((sum, label) => sum + label.length + 2, 0)
  return Math.max(1, Math.ceil(cells / Math.max(20, Math.min(width, CARD_COLUMNS))))
}

// ---------------------------------------------------------------------------
// The operator's command

async function openPane($: $): Promise<string> {
  const round = await read($, roundAtom)
  if (!round || round.dismissed) return 'No interview to show.'
  const shown = await place($, round.generation)
  return shown.placed ? `${round.title} opened in a pane.` : `The surface did not place the pane (${shown.reason}); it stays above the prompt.`
}

async function toBand($: $): Promise<string> {
  const round = await read($, roundAtom)
  if (!round || round.dismissed) return 'No interview to show.'
  await setLocation($, round.generation, 'band')
  await retirePane($)
  return `${round.title} is back above the prompt.`
}

const HELP = [
  '/interview            what is open now',
  '/interview demo       a fixture round from the usability report (never calls a model)',
  '/interview pane|band  move the open round into a pane or back above the prompt',
  '/interview cancel     cancel the open round (Claude is told it was cancelled)',
  '/interview rules      standing rules sent with every answer; rule <text> adds, unrule <n> removes',
  '/interview decisions  the decision log; forget <key> removes one',
  '/interview redirect on|off   refuse AskUserQuestion in favour of the interviewer',
].join('\n')

async function runCommand($: $, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const tail = args.trim().slice(verb.length).trim()
  if (!verb) {
    const round = await read($, roundAtom)
    if (!round) return `No interview yet.\n\n${HELP}`
    const answered = round.cards.filter(card => round.answers[card.id]).length
    return `${round.title}${round.fixture ? ' (fixture)' : ''}: ${round.status}, ${answered}/${round.cards.length} answered, ${round.location}${round.dismissed ? ', dismissed' : ''}.\n\n${HELP}`
  }
  if (verb === 'demo') {
    const created = await commit<InterviewRound | null>($, round => {
      if (live(round) && !round.fixture) return { round, out: null }
      const demo = createRound(DEMO, newGeneration(), { fixture: true, previous: DEMO_PREVIOUS, location: 'pane' })
      return { round: demo, out: demo }
    })
    if (!created) return 'A real interview is open; answer or cancel it first.'
    bandKeyboard = false
    const shown = await place($, created.generation)
    $.ui.invalidate('ui.render')
    return shown.placed
      ? 'Demo round opened in a pane beside the transcript. Digits answer while it holds the keys; click the card for the rest. Nothing reaches Claude.'
      : `Demo round opened above the prompt (the pane was declined: ${shown.reason}). Digits answer from an empty prompt; f opens the full card. Nothing reaches Claude.`
  }
  if (verb === 'pane') return openPane($)
  if (verb === 'band') return toBand($)
  if (verb === 'cancel') {
    const round = await read($, roundAtom)
    if (!live(round)) return 'No interview is open.'
    await act($, round.generation, { type: 'cancel' })
    return `Cancelled ${round.title}.`
  }
  if (verb === 'rules') {
    const list = await rules($)
    return list.length ? list.map((rule, index) => `${index + 1}. ${rule}`).join('\n') : 'No standing rules. /interview rule <text> adds one; every answer Claude receives carries them.'
  }
  if (verb === 'rule') {
    if (!tail) return 'Usage: /interview rule <text>'
    const list = [...await rules($), tail.slice(0, 300)].slice(-20)
    await $.store.set('rules', list)
    return `Rule ${list.length} saved: ${tail}`
  }
  if (verb === 'unrule') {
    const index = Number(rest[0]) - 1
    const list = await rules($)
    if (!Number.isSafeInteger(index) || !list[index]) return 'Usage: /interview unrule <n>'
    await $.store.set('rules', list.filter((_, at) => at !== index))
    return `Removed: ${list[index]}`
  }
  if (verb === 'decisions') {
    const log = Object.values(await decisions($))
    return log.length ? log.map(item => `${item.key}: ${item.answer} (${item.at.slice(0, 10)}) — ${item.question}`).join('\n') : 'The decision log is empty.'
  }
  if (verb === 'forget') {
    const log = await decisions($)
    if (!rest[0] || !log[rest[0]]) return 'Usage: /interview forget <key>'
    const { [rest[0]]: removed, ...kept } = log
    await $.store.set('decisions', kept)
    return `Forgot ${removed!.key}: ${removed!.answer}`
  }
  if (verb === 'redirect') {
    if (rest[0] !== 'on' && rest[0] !== 'off') return `AskUserQuestion redirect is ${(await $.store.get('redirect')) === true ? 'on' : 'off'}. Usage: /interview redirect on|off`
    await $.store.set('redirect', rest[0] === 'on')
    return rest[0] === 'on' ? 'Claude\'s AskUserQuestion calls are now refused with a pointer to the interviewer.' : 'AskUserQuestion works normally again.'
  }
  return HELP
}

// ---------------------------------------------------------------------------

const ASK_DESCRIPTION = 'Interview the operator: one call with every open decision as cards, asked one at a time in a card above the prompt. Use it instead of AskUserQuestion or a prose list whenever you need two or more decisions, or one that needs evidence, a preview or a reason. Before asking, check what you can yourself (files, ticket, branch freshness, sibling repos) and put it in evidence with when; never ask what a read or a fetch would answer. One decision per card, plain words, quote the context. The interviewer adds None, You decide, You do it, Why? and a free reply itself. The result is pending, not an answer: end your turn and wait for the answers message.'

export const register: Register = on => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    observed.interactive = e.isInteractive
    observed.supported = e.surface === 'terminal' || e.surface === 'desktop'
    bandKeyboard = false
    const known = await $.state.get(ROUND_REF)
    if (known.value === undefined) await $.state.set(ROUND_REF, null)
    // A reload drops scheduled deliveries; record them as failed, never queued forever.
    await commit($, round => ({ round: round ? interrupted(round) : round, out: undefined }))
    await $.command.register({ name: 'interview', description: 'The interviewer: open round, demo, pane, rules and the decision log', argumentHint: '[demo|pane|band|cancel|rules|rule <text>|unrule <n>|decisions|forget <key>|redirect on|off]' })
    await $.tool.register({ name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_SCHEMA })
    await $.tool.register({
      name: 'reply',
      description: 'Answer the operator on one card of the open interview, after an Interviewer event (they asked why, asked back, or replied in their own words). Plain language. reading proposes what their words mean as {option} or {text}; they confirm it in the card. revise replaces the card (same id) when its question or premise was wrong.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['round', 'card', 'text'],
        properties: {
          round: { type: 'string' }, card: { type: 'string' }, text: { type: 'string', maxLength: LIMITS.reply },
          reading: { type: 'object', properties: { option: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false },
          revise: CARD_SCHEMA,
        },
      },
    })
    await $.tool.register({ name: 'read', description: 'Read the current interview (answers so far, per-card threads, delivery), the decision log and the operator\'s standing rules.', inputSchema: { type: 'object', additionalProperties: false } })
    await $.tool.register({
      name: 'withdraw',
      description: 'Withdraw the open interview when its questions no longer apply. No continuation is sent.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['round'], properties: { round: { type: 'string' }, reason: { type: 'string', maxLength: 300 } } },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__interviewer__ask' }, async ($, e) => {
    if (e.agentId) return { deny: json({ error: 'Only the main conversation can interview the operator; return the questions to it.' }) }
    if (!observed.interactive || !observed.supported) {
      return { result: json({ status: 'unavailable', instruction: 'No interactive terminal or desktop surface: ask in plain text, one question at a time, with your reasons.' }) }
    }
    const decided = await decisions($)
    const validated = validateAsk({ title: e.title, cards: e.cards }, decided)
    if (!validated.ok) return { deny: json({ error: 'the interview was refused', problems: validated.errors }) }
    const previous: Record<string, InterviewDecision> = {}
    for (const card of validated.value.cards) if (card.key && decided[card.key]) previous[card.key] = decided[card.key]!
    const out = await commit<{ error: string } | { created: InterviewRound }>($, round => {
      if (live(round) && !round.fixture) return { round, out: { error: `round ${round.id} ("${round.title}") is still open; wait for its answers, or withdraw it` } }
      const created = createRound(validated.value, newGeneration(), { previous, location: 'pane' })
      return { round: created, out: { created } }
    })
    if ('error' in out) return { deny: json(out) }
    bandKeyboard = false
    const shown = await place($, out.created.generation)
    $.ui.invalidate('ui.render')
    const standing = await rules($)
    return {
      result: json({
        status: 'pending', round: out.created.id, cards: out.created.cards.length,
        shown: shown.placed ? 'in a pane beside the transcript' : `above the prompt (pane declined: ${shown.reason})`,
        ...(standing.length ? { standingRules: standing } : {}),
        instruction: 'Pending: this is not an answer. End your turn now. All answers arrive together as one "Interviewer answers" message. Before that an "Interviewer event" may arrive for one card (why, a question back, or the operator\'s own words): answer it with mcp__interviewer__reply, then end your turn again.',
      }),
    }
  })

  on('tool.call', { tool: 'mcp__interviewer__reply' }, async ($, e) => {
    const input: Record<string, unknown> = isRecord(e) ? e : {}
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text || text.length > LIMITS.reply) return { deny: json({ error: `text is required, at most ${LIMITS.reply} characters` }) }
    const round = await read($, roundAtom)
    // The operator may settle the round before a reply to their question lands.
    if (round && round.id === input.round && round.status !== 'open') return { deny: json({ error: `round ${round.id} is already ${round.status}; your reply was not shown`, instruction: settledInstruction(round) }) }
    if (!live(round) || round.id !== input.round) return { deny: json({ error: 'no open interview has that round id', open: live(round) ? round.id : null }) }
    const card = typeof input.card === 'string' ? findCard(round, input.card) : undefined
    if (!card) return { deny: json({ error: 'no card in this round has that id', cards: round.cards.map(item => item.id) }) }
    let revise: InterviewCard | undefined
    if (input.revise !== undefined) {
      const checked = validateCard(input.revise)
      if (!checked.ok) return { deny: json({ error: 'the revised card was refused', problems: checked.errors }) }
      if (checked.value.id !== card.id) return { deny: json({ error: 'a revision keeps the card id' }) }
      revise = checked.value
    }
    const reading = validateReading(input.reading, revise ?? card)
    if (!reading.ok) return { deny: json({ error: 'reading was refused', problems: reading.errors }) }
    const out = await commit($, current => {
      if (!live(current) || current.generation !== round.generation) return { round: current, out: false }
      return { round: reply(current, card.id, text, reading.value, revise), out: true }
    })
    if (!out) return { deny: json({ error: 'the round closed meanwhile' }) }
    return { result: json({ status: 'shown', card: card.id, instruction: reading.value ? 'Your reading is shown with Confirm / Not quite; it is not an answer until the operator confirms. End your turn.' : 'Shown in the card. The round is still open; end your turn.' }) }
  })

  on('tool.call', { tool: 'mcp__interviewer__read' }, async $ => {
    const round = await read($, roundAtom)
    return { result: json({ round: round ? publicRound(round) : null, decisions: Object.values(await decisions($)), standingRules: await rules($) }) }
  })

  on('tool.call', { tool: 'mcp__interviewer__withdraw' }, async ($, e) => {
    const out = await commit($, round => {
      if (!live(round) || round.id !== e.round) return { round, out: false }
      return { round: withdraw(round), out: true }
    })
    return out ? { result: json({ status: 'withdrawn' }) } : { deny: json({ error: 'no open interview has that round id' }) }
  })

  // Off by default: workflow skills call AskUserQuestion today.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId || (await $.store.get('redirect')) !== true) return next(e)
    return { deny: 'This operator interviews through mcp__interviewer__ask: send every open decision as cards in one call (question, why, evidence with as-of, options with consequence and who does it, recommended with reason). Do not ask in prose instead.' }
  })

  on('prompt.edit', async ($, e, next) => {
    releaseBand($)
    return next(e)
  })

  // A settled round's summary leaves with the turn that acted on it.
  on('turn.complete', async ($, e, next) => {
    await commit($, round => {
      if (!round || round.status === 'open' || round.dismissed || round.events.some(event => event.delivery === 'queued')) return { round, out: undefined }
      return { round: { ...round, dismissed: true, serial: round.serial + 1 }, out: undefined }
    })
    return next(e)
  })

  on('command.run', { command: 'interview' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const round = await read($, roundAtom)
    bandDrawn = !!round && !round.dismissed && round.location === 'band'
    if (!round || !bandDrawn) return next(e)
    const { Box } = $.ui.resolve(e)
    // A readable measure, not the terminal's width; the rest of the row stays empty.
    const width = Math.min(CARD_COLUMNS, Math.max(40, e.props.bodyColumns))
    const open = round.status === 'open'
    const bar = open ? answerBarRows(round, width, 'band') : 0
    const room = Math.max(4, e.props.maxRows - bar)
    sites.band = { columns: width, rows: room }
    bandSite = e.requestId
    const natural = rowsOf(round, width, 'band', detailFor(round, 'band'))
    if (natural > room) {
      // Taller than the band: drawn whole for the host to scroll (wheel and
      // `n more`), the digit buttons first so they stay armed at the top.
      return (
        <Box flexDirection="column" width={width}>
          {open ? answerBar($, e, round, 'band') : null}
          {client($, e, round, 'band', width, natural)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={width}>
        {client($, e, round, 'band', width, Math.max(Math.min(8, room), natural))}
        {open ? answerBar($, e, round, 'band') : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const round = await read($, roundAtom)
    if (!round || round.dismissed || round.location !== 'pane') return <Text>The interview moved back above the prompt.</Text>
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text>The interviewer needs a terminal or desktop surface.</Text>
    const { Box } = $.ui.resolve(e)
    const width = Math.min(CARD_COLUMNS, Math.max(40, e.props.bodyColumns))
    const open = round.status === 'open'
    const bar = open ? answerBarRows(round, width) : 0
    // The whole card; the host scrolls the pane when it is taller, the digit
    // buttons then first so they stay in view.
    const natural = rowsOf(round, width, 'pane')
    const overflows = e.props.scroll.bodyRows > 0 && natural + bar > e.props.scroll.bodyRows
    return (
      <Box flexDirection="column" width={width}>
        {open && overflows ? answerBar($, e, round, 'pane') : null}
        {client($, e, round, 'pane', width, natural)}
        {open && !overflows ? answerBar($, e, round, 'pane') : null}
      </Box>
    )
  })

  on('ui.message', { element: CLIENT_MATCH }, onClientMessage)

  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) =>
    e.origin.kind === 'person' && e.pointer ? next({ ...e, offset: quickened(e) }) : next(e))

  on('ui.scroll', { component: 'AbovePrompt' }, async ($, e, next) =>
    bandDrawn && e.origin.kind === 'person' && e.pointer ? next({ ...e, offset: quickened(e) }) : next(e))

  // Closing the pane by hand puts the round back above the prompt; it never cancels it.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (retiringPane || e.origin.kind !== 'person') return next(e)
    await commit($, round => ({ round: round && round.location === 'pane' ? { ...round, location: 'band', serial: round.serial + 1 } : round, out: undefined }))
    return next(e)
  })
}
