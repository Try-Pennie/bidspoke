/**
 * The repair yields to the live archive (#1027, #1032).
 *
 * They take the same lock, so a repair running while the archive is behind
 * holds today's hours back further. Today's hours have a seven day retention
 * clock running; the old day being repaired has at most one night left either
 * way. So the repair is always the one that waits.
 */
import { describe, it, expect } from 'vitest'
import { mayRepairRun, REPAIR_YIELDS_ABOVE_HOURS_BEHIND } from '../repair-priority'

describe('mayRepairRun', () => {
  it('allows a repair while the archive is keeping up', () => {
    expect(mayRepairRun({ hoursBehind: 0 })).toEqual({ allowed: true })
  })

  it('allows a repair at the ordinary settle-window lag', () => {
    // The archive will not touch an hour until the two hour settle window has
    // passed, so it sits two to three hours behind while perfectly healthy.
    // Refusing on that would refuse every repair and make the remedy
    // unreachable exactly when it is needed (L109).
    expect(mayRepairRun({ hoursBehind: 2 }).allowed).toBe(true)
    expect(mayRepairRun({ hoursBehind: 3 }).allowed).toBe(true)
  })

  it('allows a repair exactly at the limit, and refuses past it', () => {
    expect(mayRepairRun({ hoursBehind: REPAIR_YIELDS_ABOVE_HOURS_BEHIND }).allowed).toBe(true)
    expect(mayRepairRun({ hoursBehind: REPAIR_YIELDS_ABOVE_HOURS_BEHIND + 1 }).allowed).toBe(false)
  })

  it('says how far behind it is and what to do, not just no', () => {
    const verdict = mayRepairRun({ hoursBehind: 9 })

    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toContain('9 hours behind')
    // A refusal a person cannot act on is a dead control (L109, L111).
    expect(verdict.reason).toMatch(/caught up|force/)
  })

  it('refuses when it cannot tell how far behind the archive is', () => {
    // Unreadable is not healthy. Proceeding would be proceeding on an
    // assumption nobody measured, and the reason has to say which of the two it
    // is because the remedies differ (L215).
    const verdict = mayRepairRun({ hoursBehind: null })

    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toMatch(/could not be read/)
  })

  it('goes ahead when the caller forces it in this request', () => {
    // The escape hatch is per request, never a stored setting: a suppression
    // nobody can see is how this comes back (L523).
    expect(mayRepairRun({ hoursBehind: 40, force: true })).toEqual({ allowed: true })
    expect(mayRepairRun({ hoursBehind: null, force: true })).toEqual({ allowed: true })
  })
})
