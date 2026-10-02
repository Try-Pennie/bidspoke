/**
 * Cutover evidence verdict for one recorded Pipedream workflow (#1705, D6).
 *
 * Pure: every input, the clock included, is passed in. Four outcomes, and only
 * `complete` lets a cutover proceed:
 *
 * - `recording_off`: `porting.recording_enabled` was false for any part of the
 *   window, or its history is missing (never assumed on).
 * - `insufficient_evidence`: zero captures (never complete, L98), fewer starts
 *   than the workflow's own floor, the newest capture older than several of the
 *   workflow's learned gaps, no learned gap to judge that by, no independent run
 *   count (the recorder cannot be the only witness to its own completeness, L58),
 *   fewer captured starts than independently counted runs, or any quarantined
 *   capture in the window.
 * - `gap`: a start with no terminal once its pairing wait has passed, a terminal
 *   with no start, or more than one terminal for one event (a defect: a run ends
 *   once).
 * - `complete`: none of the above.
 *
 * Pairing is one start plus exactly one terminal (`terminal` or `error`).
 * `responded` captures attach to the event and never count as a finish. A
 * start's pairing wait is the configured timeout plus the workflow's delay
 * steps, so a run sleeping in a delay is pending, not a gap.
 *
 * Every reason found is reported, not only the one that decided the verdict, so
 * a report refusing on thin evidence still names the gaps it already saw.
 */

export type CaptureKind = 'start' | 'terminal' | 'error' | 'responded'

export interface CaptureRecord {
  eventId: string
  kind: CaptureKind
  /** Epoch ms the receiver stored it. */
  receivedAt: number
  siteId: string
  seq: string
  /** Stored under an unknown capture version: kept, never paired. */
  quarantined: boolean
}

export interface RecordingChange {
  at: number
  enabled: boolean
}

export interface IndependentRunCount {
  count: number
  windowStart: number
  windowEnd: number
}

export interface EvidenceInput {
  window: { start: number; end: number }
  now: number
  captures: CaptureRecord[]
  /** The workflow's usual time between runs, learned from its history; null when not yet learned. */
  learnedGapMs: number | null
  /** Fewest captured starts in the window this workflow's report will judge on. */
  floor: number
  /** Every change to porting.recording_enabled, any order. */
  recordingHistory: RecordingChange[]
  independentRunCount: IndependentRunCount | null
  pairingWaitMs: number
  /** Total of the workflow's delay steps, added to the pairing wait. */
  delayMs: number
  /** How many learned gaps of silence make the recorder look quiet. Default 3. */
  quietMultiplier?: number
}

export type Verdict = 'complete' | 'gap' | 'insufficient_evidence' | 'recording_off'

export interface EvidenceResult {
  verdict: Verdict
  reasons: string[]
  stats: {
    starts: number
    paired: number
    pending: string[]
    unpairedStarts: string[]
    terminalsWithoutStart: string[]
    multipleTerminals: string[]
    quarantined: number
  }
}

const isTerminal = (k: CaptureKind) => k === 'terminal' || k === 'error'
const iso = (ms: number) => new Date(ms).toISOString()

function recordingOffReasons(input: EvidenceInput): string[] {
  const history = [...input.recordingHistory].sort((a, b) => a.at - b.at)
  if (history.length === 0) return ['no porting.recording_enabled history exists, so recording cannot be shown on']
  const before = history.filter((c) => c.at <= input.window.start)
  const atStart = before.length ? before[before.length - 1].enabled : null
  if (atStart === null) return [`porting.recording_enabled has no value before the window began at ${iso(input.window.start)}`]
  if (!atStart) return [`recording was off when the window began at ${iso(input.window.start)}`]
  const offInside = history.find((c) => c.at > input.window.start && c.at < input.window.end && !c.enabled)
  return offInside ? [`recording was switched off at ${iso(offInside.at)}, inside the window`] : []
}

export function evaluateEvidence(input: EvidenceInput): EvidenceResult {
  const { window, now } = input
  const live = input.captures.filter((c) => !c.quarantined)
  const quarantined = input.captures.length - live.length

  const byEvent = new Map<string, CaptureRecord[]>()
  for (const c of live) {
    const list = byEvent.get(c.eventId) ?? []
    list.push(c)
    byEvent.set(c.eventId, list)
  }

  const wait = input.pairingWaitMs + input.delayMs
  let starts = 0
  let paired = 0
  const pending: string[] = []
  const unpairedStarts: string[] = []
  const terminalsWithoutStart: string[] = []
  const multipleTerminals: string[] = []

  for (const [eventId, caps] of byEvent) {
    const start = caps.find((c) => c.kind === 'start')
    const terminals = caps.filter((c) => isTerminal(c.kind))
    if (!start) {
      if (terminals.some((t) => t.receivedAt >= window.start && t.receivedAt < window.end)) terminalsWithoutStart.push(eventId)
      continue
    }
    if (start.receivedAt < window.start || start.receivedAt >= window.end) continue
    starts++
    if (terminals.length > 1) multipleTerminals.push(eventId)
    else if (terminals.length === 1) paired++
    else if (start.receivedAt + wait > now) pending.push(eventId)
    else unpairedStarts.push(eventId)
  }

  const off = recordingOffReasons(input)

  const thin: string[] = []
  const inWindow = input.captures.filter((c) => c.receivedAt >= window.start && c.receivedAt < window.end)
  if (inWindow.length === 0) thin.push('no captures in the window; zero is never complete')
  if (starts < input.floor) thin.push(`${starts} starts captured, below this workflow's floor of ${input.floor}`)
  if (input.learnedGapMs === null) {
    thin.push('no learned gap for this workflow, so a quiet recorder cannot be told from a quiet workflow')
  } else if (inWindow.length > 0) {
    // A loop, not Math.max(...spread): spreading a busy window as call
    // arguments throws RangeError (#1718).
    let newest = inWindow[0].receivedAt
    for (const c of inWindow) if (c.receivedAt > newest) newest = c.receivedAt
    const limit = input.learnedGapMs * (input.quietMultiplier ?? 3)
    if (now - newest > limit) thin.push(`recorder quiet since ${iso(newest)}, longer than ${input.quietMultiplier ?? 3} learned gaps`)
  }
  const counted = input.independentRunCount
  if (!counted) {
    thin.push('no independent run count for the window; the recorder cannot be the only witness to its own completeness')
  } else if (counted.windowStart !== window.start || counted.windowEnd !== window.end) {
    thin.push(`the independent run count covers ${iso(counted.windowStart)} to ${iso(counted.windowEnd)}, not the report window`)
  } else if (starts < counted.count) {
    thin.push(`${starts} starts captured against ${counted.count} runs counted independently`)
  }
  if (quarantined > 0) thin.push(`${quarantined} quarantined captures under an unknown capture version`)

  const gaps: string[] = []
  if (unpairedStarts.length) gaps.push(`starts without a terminal: ${unpairedStarts.join(', ')}`)
  if (terminalsWithoutStart.length) gaps.push(`terminals without a start: ${terminalsWithoutStart.join(', ')}`)
  if (multipleTerminals.length) gaps.push(`more than one terminal for: ${multipleTerminals.join(', ')}`)

  const verdict: Verdict = off.length ? 'recording_off' : thin.length ? 'insufficient_evidence' : gaps.length ? 'gap' : 'complete'
  return {
    verdict,
    reasons: [...off, ...thin, ...gaps],
    stats: { starts, paired, pending, unpairedStarts, terminalsWithoutStart, multipleTerminals, quarantined },
  }
}
