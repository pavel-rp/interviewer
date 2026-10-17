// The interviewer's plugin contract. JSON-only; the host keeps it in session state.

/** What Claude checked before asking, and when. */
export interface InterviewEvidence { source: string; asOf: string }

export interface InterviewOption {
  id: string
  label: string
  /** What choosing it changes, in the operator's terms. */
  consequence: string
  /** Who performs the step this option implies. */
  by: 'claude' | 'you'
  /** The exact change, command, cost or worked example; drawn verbatim. */
  preview?: string
}

/** One decision. The schema refuses a card that leaves out why, evidence or consequences. */
export interface InterviewCard {
  id: string
  question: string
  why: string
  evidence: InterviewEvidence[]
  /** Required when evidence is empty: why the premise could not be checked. */
  unverified?: string
  /** Quoted material the question rests on (not a citation to earlier scrollback). */
  context?: string
  options: InterviewOption[]
  recommended?: { option: string; reason: string }
  /** What answering this card does not decide. */
  leaves?: string
  /** Decision-log key; a key already decided needs `changed` to be asked again. */
  key?: string
  changed?: string
  /** An outward-facing or paid action: never covered by "accept recommended". */
  gate?: boolean
}

export type InterviewAnswer =
  | { kind: 'option'; option: string }
  /** Leave it: nothing is done for this card. */
  | { kind: 'none' }
  /** The operator delegates the choice; Claude takes its recommendation. */
  | { kind: 'decide' }
  /** Claude performs the step the chosen card would have asked of the operator. */
  | { kind: 'do' }
  /** A reply Claude read as an answer and the operator confirmed. */
  | { kind: 'text'; text: string }

/** What Claude proposes a typed reply means; the operator must confirm it. */
export type InterviewReading = { option: string } | { text: string }

export interface InterviewMessage {
  id: number
  from: 'you' | 'claude'
  kind: 'why' | 'question' | 'note' | 'reply'
  text: string
  reading?: InterviewReading
  settled?: 'confirmed' | 'rejected'
}

/**
 * One continuation the round owes Claude. Distinct from the round's status:
 * `queued` is waiting for the host, `sent` means the host accepted it (not that
 * Claude acted), `failed` is never replayed, `local` is a fixture's.
 */
export interface InterviewEvent {
  id: string
  kind: 'escalation' | 'answers' | 'cancelled'
  card?: string
  text: string
  delivery: 'queued' | 'sent' | 'failed' | 'local'
  error?: string
}

export interface InterviewDecision { key: string; question: string; answer: string; at: string; round: string }

export interface InterviewRound {
  id: string
  title: string
  generation: string
  /** open: pending; sent: answers submitted; cancelled: by the operator; withdrawn: by Claude. */
  status: 'open' | 'sent' | 'cancelled' | 'withdrawn'
  cards: InterviewCard[]
  /** Logged decisions the cards touch, as they stood when the round was asked. */
  previous: Record<string, InterviewDecision>
  at: number
  answers: Record<string, InterviewAnswer>
  threads: Record<string, InterviewMessage[]>
  drafts: Record<string, string>
  expanded: Record<string, boolean>
  focus: string
  scroll: number
  events: InterviewEvent[]
  serial: number
  ack: { epoch: string; seq: number }
  fixture: boolean
  location: 'band' | 'pane'
  /** Put away; the record stays readable through the read tool. */
  dismissed: boolean
}

export type InterviewAction =
  | { type: 'focus'; id: string }
  | { type: 'scroll'; offset: number }
  | { type: 'go'; index: number }
  | { type: 'choose'; card: string; answer: InterviewAnswer }
  | { type: 'clear'; card: string }
  | { type: 'draft'; card: string; value: string }
  | { type: 'say'; card: string }
  | { type: 'why'; card: string }
  | { type: 'confirm'; card: string; message: number }
  | { type: 'reject'; card: string; message: number }
  /** Show or hide a card's context, or its preview where the band is compact. */
  | { type: 'toggle'; card: string; part?: 'context' | 'preview' }
  | { type: 'accept-rest' }
  | { type: 'send' }
  | { type: 'cancel' }
  /** Put a settled round away. */
  | { type: 'dismiss' }

export interface InterviewItem { seq: number; action: InterviewAction }
export interface InterviewBatch { generation: string; epoch: string; items: InterviewItem[] }
export interface InterviewProps { round: InterviewRound; keyboard: boolean; chrome: 'band' | 'pane'; detail?: 'full' | 'compact' }
export interface InterviewProblem { path: string; message: string }

declare module 'claude-code' {
  interface PluginState {
    interviewer: {
      round: InterviewRound | null
    }
  }

  interface McpToolInputs {
    'mcp__interviewer__ask': { title: unknown; cards: unknown }
    'mcp__interviewer__reply': { round: string; card: string; text: string; reading?: unknown; revise?: unknown }
    'mcp__interviewer__read': {}
    'mcp__interviewer__withdraw': { round: string; reason?: string }
  }
}
