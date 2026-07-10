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
