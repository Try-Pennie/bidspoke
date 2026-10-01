import { describe, expect, it } from 'vitest'
import { evaluateEvidence, type CaptureRecord, type EvidenceInput } from './verdict.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0)

let seq = 0
const cap = (eventId: string, kind: CaptureRecord['kind'], at: number, extra: Partial<CaptureRecord> = {}): CaptureRecord => ({
  eventId,
  kind,
  receivedAt: at,
  siteId: `${kind}-site`,
  seq: String(seq++),
  quarantined: false,
  ...extra,
})

/** A run that started and finished a minute later. */
const run = (eventId: string, at: number): CaptureRecord[] => [cap(eventId, 'start', at), cap(eventId, 'terminal', at + MIN)]

const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  window: { start: T0, end: T0 + 24 * HOUR },
  now: T0 + 24 * HOUR,
  captures: [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), ...run('e3', T0 + 20 * HOUR)],
  learnedGapMs: 6 * HOUR,
  floor: 3,
  recordingHistory: [{ at: T0 - HOUR, enabled: true }],
  independentRunCount: { count: 3, windowStart: T0, windowEnd: T0 + 24 * HOUR },
  pairingWaitMs: 15 * MIN,
  delayMs: 0,
  ...over,
})

describe('evaluateEvidence: complete', () => {
  it('passes a window where every start has exactly one terminal and the counts agree', () => {
    const r = evaluateEvidence(base())
    expect(r.verdict).toBe('complete')
    expect(r.stats).toMatchObject({ starts: 3, paired: 3 })
  })

  it('accepts an error terminal as the end of a run', () => {
    const r = evaluateEvidence(base({ captures: [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), cap('e3', 'start', T0 + 20 * HOUR), cap('e3', 'error', T0 + 20 * HOUR + 1)] }))
    expect(r.verdict).toBe('complete')
  })

  it('does not count a responded capture as a finish', () => {
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), cap('e3', 'start', T0 + 20 * HOUR), cap('e3', 'responded', T0 + 20 * HOUR + 1)]
    const r = evaluateEvidence(base({ captures: caps }))
    expect(r.verdict).toBe('gap')
    expect(r.reasons.join(' ')).toMatch(/e3/)
  })
})

describe('evaluateEvidence: never complete on zero', () => {
  it('calls zero captures insufficient evidence, even with a floor of zero', () => {
    const r = evaluateEvidence(base({ captures: [], floor: 0, independentRunCount: { count: 0, windowStart: T0, windowEnd: T0 + 24 * HOUR } }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.reasons.join(' ')).toMatch(/no captures/)
  })
})

describe('evaluateEvidence: gap', () => {
  it('reports a start whose terminal never came, once the pairing wait has passed', () => {
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), cap('e3', 'start', T0 + 20 * HOUR)]
    const r = evaluateEvidence(base({ captures: caps }))
    expect(r.verdict).toBe('gap')
    expect(r.stats.unpairedStarts).toEqual(['e3'])
  })

  it('treats more than one terminal for an event as a defect, never as complete', () => {
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), ...run('e3', T0 + 20 * HOUR), cap('e3', 'terminal', T0 + 20 * HOUR + 2 * MIN)]
    const r = evaluateEvidence(base({ captures: caps }))
    expect(r.verdict).toBe('gap')
    expect(r.stats.multipleTerminals).toEqual(['e3'])
    expect(r.reasons.join(' ')).toMatch(/more than one terminal/)
  })

  it('reports a terminal with no start', () => {
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), ...run('e3', T0 + 20 * HOUR), cap('e4', 'terminal', T0 + 21 * HOUR)]
    const r = evaluateEvidence(base({ captures: caps }))
    expect(r.verdict).toBe('gap')
    expect(r.stats.terminalsWithoutStart).toEqual(['e4'])
  })

  it('waits out the pairing window before calling a start unpaired', () => {
    const now = T0 + 24 * HOUR
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), ...run('e3', T0 + 20 * HOUR), cap('e4', 'start', now - 5 * MIN)]
    const r = evaluateEvidence(base({ captures: caps, independentRunCount: { count: 4, windowStart: T0, windowEnd: now } }))
    expect(r.verdict).toBe('complete')
    expect(r.stats.pending).toEqual(['e4'])
  })

  it('extends the pairing wait by the workflow delay, so a delayed run is not called a gap', () => {
    const now = T0 + 24 * HOUR
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), ...run('e3', T0 + 20 * HOUR), cap('e4', 'start', now - 2 * HOUR)]
    const counted = { count: 4, windowStart: T0, windowEnd: now }
    expect(evaluateEvidence(base({ captures: caps, independentRunCount: counted, delayMs: 0 })).verdict).toBe('gap')
    const delayed = evaluateEvidence(base({ captures: caps, independentRunCount: counted, delayMs: 3 * HOUR }))
    expect(delayed.verdict).toBe('complete')
    expect(delayed.stats.pending).toEqual(['e4'])
  })
})

describe('evaluateEvidence: insufficient evidence', () => {
  it('refuses fewer starts than the workflow floor', () => {
    const r = evaluateEvidence(base({ floor: 10 }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.reasons.join(' ')).toMatch(/floor/)
  })

  it('refuses when the newest capture is older than several learned gaps', () => {
    const r = evaluateEvidence(base({ learnedGapMs: HOUR }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.reasons.join(' ')).toMatch(/quiet/)
  })

  it('refuses without a learned gap, rather than skipping the staleness check', () => {
    const r = evaluateEvidence(base({ learnedGapMs: null }))
    expect(r.verdict).toBe('insufficient_evidence')
  })

  it('refuses without an independent run count: the recorder is not its own witness', () => {
    const r = evaluateEvidence(base({ independentRunCount: null }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.reasons.join(' ')).toMatch(/independent/)
  })

  it('refuses when fewer starts were captured than runs were independently counted', () => {
    const r = evaluateEvidence(base({ independentRunCount: { count: 5, windowStart: T0, windowEnd: T0 + 24 * HOUR } }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.reasons.join(' ')).toMatch(/3 starts.*5 runs/)
  })

  it('refuses an independent count over a different window than the report', () => {
    const r = evaluateEvidence(base({ independentRunCount: { count: 3, windowStart: T0 - 24 * HOUR, windowEnd: T0 } }))
    expect(r.verdict).toBe('insufficient_evidence')
  })

  it('excludes quarantined captures from pairing and names them', () => {
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), cap('e3', 'start', T0 + 20 * HOUR), cap('e3', 'terminal', T0 + 20 * HOUR + MIN, { quarantined: true })]
    const r = evaluateEvidence(base({ captures: caps }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.reasons.join(' ')).toMatch(/quarantined/)
  })

  it('ranks insufficient evidence above a gap, and still reports the gap', () => {
    const caps = [...run('e1', T0 + HOUR), ...run('e2', T0 + 10 * HOUR), cap('e3', 'start', T0 + 20 * HOUR)]
    const r = evaluateEvidence(base({ captures: caps, floor: 10 }))
    expect(r.verdict).toBe('insufficient_evidence')
    expect(r.stats.unpairedStarts).toEqual(['e3'])
  })
})

describe('evaluateEvidence: recording off', () => {
  it('refuses when recording was switched off for part of the window', () => {
    const r = evaluateEvidence(base({ recordingHistory: [{ at: T0 - HOUR, enabled: true }, { at: T0 + 5 * HOUR, enabled: false }, { at: T0 + 6 * HOUR, enabled: true }] }))
    expect(r.verdict).toBe('recording_off')
  })

  it('refuses when recording was off as the window began', () => {
    const r = evaluateEvidence(base({ recordingHistory: [{ at: T0 - HOUR, enabled: false }, { at: T0 + HOUR, enabled: true }] }))
    expect(r.verdict).toBe('recording_off')
  })

  it('refuses when there is no recording history at all, rather than assuming it was on', () => {
    const r = evaluateEvidence(base({ recordingHistory: [] }))
    expect(r.verdict).toBe('recording_off')
  })

  it('ignores a switch off after the window ended', () => {
    const r = evaluateEvidence(base({ recordingHistory: [{ at: T0 - HOUR, enabled: true }, { at: T0 + 25 * HOUR, enabled: false }] }))
    expect(r.verdict).toBe('complete')
  })
})
