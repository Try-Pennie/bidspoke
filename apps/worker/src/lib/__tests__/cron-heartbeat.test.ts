import { describe, it, expect } from 'vitest'
import { evaluateHeartbeat } from '../cron-heartbeat'

const NOW = Date.parse('2026-06-26T13:00:00.000Z')
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
// The daily job's threshold; evaluateHeartbeat is pure over any staleMs.
const STALE_THRESHOLD_MS = 26 * H

describe('evaluateHeartbeat', () => {
  it('is healthy when the last run is recent', () => {
    expect(evaluateHeartbeat(iso(NOW - 1 * H), null, NOW, STALE_THRESHOLD_MS).status).toBe('healthy')
  })

  it('is healthy right at the threshold (only strictly past it is stale)', () => {
    expect(evaluateHeartbeat(iso(NOW - STALE_THRESHOLD_MS), null, NOW, STALE_THRESHOLD_MS).status).toBe('healthy')
  })

  it('is stale when the last run is older than the threshold', () => {
    const v = evaluateHeartbeat(iso(NOW - 27 * H), null, NOW, STALE_THRESHOLD_MS)
    expect(v.status).toBe('stale')
    expect(v.ageMs).toBe(27 * H)
  })

  it('reports never_ran when no heartbeat exists but it was first seen long ago', () => {
    expect(evaluateHeartbeat(null, iso(NOW - 27 * H), NOW, STALE_THRESHOLD_MS).status).toBe('never_ran')
  })

  it('is pending (no alert) when no heartbeat exists but it was first seen recently', () => {
    expect(evaluateHeartbeat(null, iso(NOW - 1 * H), NOW, STALE_THRESHOLD_MS).status).toBe('pending')
  })

  it('is pending when nothing has been recorded yet (caller should seed first-seen)', () => {
    expect(evaluateHeartbeat(null, null, NOW, STALE_THRESHOLD_MS).status).toBe('pending')
  })

  it('uses a threshold above 24h so a normal daily cadence never trips', () => {
    expect(STALE_THRESHOLD_MS).toBeGreaterThan(24 * H)
  })
})

/**
 * A run that started and never finished (#985).
 *
 * The started stamp alone can only catch a cron that never FIRED. On 2026-08-22
 * the archive was killed by the platform three hours running, each run stamping
 * "started" first, and the check reported it healthy throughout. The completed
 * stamp and a per-job run allowance make that visible as its own verdict.
 */
describe('evaluateHeartbeat with a completed stamp', () => {
  const MAX_RUN = 30 * 60 * 1000

  it('is healthy while a recent run is still inside its allowance, even with no completed stamp yet', () => {
    expect(evaluateHeartbeat(iso(NOW - 10 * 60 * 1000), null, NOW, STALE_THRESHOLD_MS, null, MAX_RUN).status).toBe('healthy')
  })

  it('is healthy when the latest run completed after it started', () => {
    expect(
      evaluateHeartbeat(iso(NOW - 2 * H), null, NOW, STALE_THRESHOLD_MS, iso(NOW - 2 * H + 60_000), MAX_RUN).status,
    ).toBe('healthy')
  })

  it('reports vanished when a run started past its allowance and nothing completed', () => {
    const v = evaluateHeartbeat(iso(NOW - 45 * 60 * 1000), null, NOW, STALE_THRESHOLD_MS, null, MAX_RUN)
    expect(v.status).toBe('vanished')
    expect(v.ageMs).toBe(45 * 60 * 1000)
  })

  it('reports vanished when the only completed stamp belongs to an earlier run', () => {
    // The previous run finished; this one started 45 minutes ago and did not.
    const started = NOW - 45 * 60 * 1000
    const v = evaluateHeartbeat(iso(started), null, NOW, STALE_THRESHOLD_MS, iso(started - 3 * H), MAX_RUN)
    expect(v.status).toBe('vanished')
  })

  it('still reports stale, not vanished, when the last start is itself past the staleness threshold', () => {
    // A job that has not fired for a day is dark in the old sense; that verdict
    // and its remedy (the trigger, the deploy) take precedence.
    const v = evaluateHeartbeat(iso(NOW - 27 * H), null, NOW, STALE_THRESHOLD_MS, null, MAX_RUN)
    expect(v.status).toBe('stale')
  })

  it('keeps the old four-argument behaviour when no allowance is given', () => {
    expect(evaluateHeartbeat(iso(NOW - 45 * 60 * 1000), null, NOW, STALE_THRESHOLD_MS).status).toBe('healthy')
  })
})
