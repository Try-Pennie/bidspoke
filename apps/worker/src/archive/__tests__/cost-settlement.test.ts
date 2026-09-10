/**
 * A missing execution cost is permanent, not late (#931).
 *
 * ADR 0009 recorded that 100% of executions settled beyond 5 minutes, bucketed
 * over one hour of traffic. That is right about the tail consumer's latency and
 * wrong as a universal: a population of roughly 5 rows a day can be absent from
 * an hour's sample without the sample being wrong (L172).
 *
 * Measured over EVERY execution past the settle window on 2026-08-21: 20 of
 * 764,301 carry no cost, all 20 are `failed`, every one has a completion time,
 * and the oldest was 93 hours old. So for a failed execution an absent cost is
 * the settled final state.
 *
 * Nothing today gets this wrong, and that is exactly why the guard is worth
 * having now. The amend pass (#932) and the deletion gate (#872) are both
 * unwritten, and both would naturally treat a null cost as an unfinished record.
 * Anything that waits for a cost waits forever on those rows, which becomes a
 * permanent low-level alert stream about nothing (L36).
 */
import { describe, it, expect } from 'vitest'
import { A_V7_EXECUTION_ID } from './_ids'
import { dispositionFor, EXPECTED_ORGANIZATION_SLUG, ARCHIVE_DEADLINE_MS } from '../disposition'
import { scalarsFor } from '../scalars'
import { SETTLE_WINDOW_MS } from '../clock'
import measured from '../fixtures/cost-settlement.json'

const HOUR_START = '2026-08-18T10:00:00.000Z'
const settled = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + 60_000)
const orgs = new Map([['wf-live', { id: 'org-live', slug: EXPECTED_ORGANIZATION_SLUG }]])

const execution = (over: Record<string, unknown> = {}) => ({
  id: A_V7_EXECUTION_ID,
  workflow_id: 'wf-live',
  status: 'failed',
  started_at: HOUR_START,
  completed_at: '2026-08-18T10:00:12.000Z',
  cost_usd: null,
  ...over,
})

describe('the measurement', () => {
  it('is a full count past the settle window, not a sample', () => {
    expect(measured.settledExecutions).toBeGreaterThan(700000)
    expect(measured.provenance.settleWindowHours).toBe(SETTLE_WINDOW_MS / (60 * 60 * 1000))
  })

  it('records that only failed executions lack a cost', () => {
    const { byStatus } = measured.withoutCost
    expect(byStatus.failed).toBe(measured.withoutCost.total)
    expect(byStatus.completed).toBe(0)
    expect(byStatus.degraded).toBe(0)
  })

  // The load-bearing fact. If these rows were merely late, waiting would be
  // correct; they are not, so waiting is a permanent stall.
  it('records that the rows are settled, not in flight', () => {
    expect(measured.withoutCost.allHaveCompletedAt).toBe(true)
    expect(measured.withoutCost.oldestAgeHoursAtMeasurement).toBeGreaterThan(24)
  })

  it('says which earlier measurement it corrects, rather than silently replacing it', () => {
    expect(measured.provenance.supersedes).toMatch(/100%/)
  })
})

describe('a settled execution with no cost', () => {
  // The behaviour that must hold for anything already shipped.
  it('is archived cleanly, not refused', () => {
    const d = dispositionFor(execution(), { now: settled, organizationOf: orgs })

    expect(d.action).toBe('archive')
    expect(d.incomplete).toBe(false)
  })

  it('is not marked incomplete even long past the deadline', () => {
    const old = new Date(Date.parse(HOUR_START) + SETTLE_WINDOW_MS + ARCHIVE_DEADLINE_MS + 60_000)
    const d = dispositionFor(execution(), { now: old, organizationOf: orgs })

    expect(d.action).toBe('archive')
    expect(d.incomplete).toBe(false)
  })

  it('produces scalars rather than a refusal, carrying the null through', () => {
    const s = scalarsFor(execution(), 'org-live', null)

    expect(s.ok).toBe(true)
    expect(s.ok && s.scalars.costUsd).toBeNull()
    // The columns the archive genuinely requires are still enforced, so this is
    // not a test that scalarsFor accepts anything (L159).
    expect(scalarsFor(execution({ workflow_id: null }), 'org-live', null).ok).toBe(false)
    expect(scalarsFor(execution(), undefined, null).ok).toBe(false)
  })

  it('carries a real cost through unchanged when there is one', () => {
    const s = scalarsFor(execution({ cost_usd: '0.00042' }), 'org-live', null)

    expect(s.ok && s.scalars.costUsd).toBeCloseTo(0.00042)
  })

  // Zero is a real measured cost, not an absent one, and the two must not be
  // folded together by anything downstream.
  it('keeps a zero cost distinct from a missing one', () => {
    const zero = scalarsFor(execution({ cost_usd: 0 }), 'org-live', null)
    const missing = scalarsFor(execution({ cost_usd: null }), 'org-live', null)

    expect(zero.ok && zero.scalars.costUsd).toBe(0)
    expect(missing.ok && missing.scalars.costUsd).toBeNull()
  })
})
