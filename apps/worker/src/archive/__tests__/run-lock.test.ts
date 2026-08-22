/**
 * The archive run lock's staleness decision (#954).
 *
 * A killed invocation leaves its lock behind. Observed on prod 2026-08-21: the
 * 17:23 run still held `execution-archive:run-lock` at 17:35, twelve minutes
 * later and two minutes past the run's own 10 minute wall budget, with nothing
 * written and no error recorded. The next invocation read that lock, treated it
 * as a genuine concurrent run and returned `skipped: 'locked'`, which is
 * indistinguishable from correct behaviour. So one terminated run silently cost
 * the run after it too.
 *
 * The lock is an optimisation rather than the correctness story (the watermark
 * and the gate's COUNT(DISTINCT) are what make a duplicate harmless), which is
 * exactly why it must not be able to suppress work.
 */
import { describe, it, expect } from 'vitest'
import { decideLock, lockValue, STALE_GRACE_MS } from '../run-lock'

const WALL_BUDGET_MS = 10 * 60 * 1000
const NOW = new Date('2026-08-21T17:35:00.000Z')

function at(iso: string): Date {
  return new Date(iso)
}

describe('decideLock', () => {
  it('takes a free lock', () => {
    const d = decideLock({ stored: null, now: NOW, wallBudgetMs: WALL_BUDGET_MS })
    expect(d.action).toBe('take')
  })

  it('skips while the holder is still inside its own budget', () => {
    const stored = lockValue(at('2026-08-21T17:33:00.000Z'), WALL_BUDGET_MS)
    const d = decideLock({ stored, now: NOW, wallBudgetMs: WALL_BUDGET_MS })

    expect(d.action).toBe('skip')
    // The age has to travel with the decision. A bare "locked" is what made the
    // killed run invisible.
    if (d.action !== 'skip') throw new Error('unreachable')
    expect(d.heldForMs).toBe(2 * 60 * 1000)
  })

  it('still skips a holder only just past its deadline, because a run can legitimately overrun', () => {
    // The 2026-08-21 case exactly: started 17:23, budget 10 minutes, read 17:35,
    // so two minutes past deadline. That run WAS killed, but nothing readable at
    // 17:35 could prove it: the wall budget is checked BETWEEN hours, and an
    // hour costs 202 to 257 seconds end to end, so a run that passed its last
    // check a millisecond before the deadline is still legitimately sending
    // four minutes later. Taking over here would put two live runs on one hour,
    // which is the only thing the lock exists to prevent.
    const stored = lockValue(at('2026-08-21T17:23:00.000Z'), WALL_BUDGET_MS)
    const d = decideLock({ stored, now: NOW, wallBudgetMs: WALL_BUDGET_MS })

    expect(d.action).toBe('skip')
  })

  it('takes over once the holder is past its deadline and the measured overrun grace', () => {
    const stored = lockValue(at('2026-08-21T17:23:00.000Z'), WALL_BUDGET_MS)
    const d = decideLock({
      stored,
      now: at('2026-08-21T17:40:00.000Z'),
      wallBudgetMs: WALL_BUDGET_MS,
    })

    expect(d.action).toBe('take-over')
    if (d.action !== 'take-over') throw new Error('unreachable')
    expect(d.heldForMs).toBe(17 * 60 * 1000)
    expect(d.overdueByMs).toBe(17 * 60 * 1000 - WALL_BUDGET_MS - STALE_GRACE_MS)
    expect(d.reason).toMatch(/past its own deadline/)
  })

  it('takes over at the next hourly run, which is when a killed run is actually seen', () => {
    // The cron is hourly at :23, so this is the case that matters in production:
    // the run after a killed one reads its lock, names it, and proceeds. The
    // lock's TTL is deliberately longer than the cadence so this read happens at
    // all: a TTL that expired first would clear the evidence and the killed run
    // would stay invisible, which is the silence #954 is about.
    const stored = lockValue(at('2026-08-21T17:23:00.000Z'), WALL_BUDGET_MS)
    const d = decideLock({
      stored,
      now: at('2026-08-21T18:23:00.000Z'),
      wallBudgetMs: WALL_BUDGET_MS,
    })

    expect(d.action).toBe('take-over')
    if (d.action !== 'take-over') throw new Error('unreachable')
    expect(d.reason).toMatch(/killed rather than still working/)
  })

  it('takes over a lock it cannot read, naming that as the reason', () => {
    // A value written by an older version, or a truncated write. Refusing to run
    // on a value nothing can interpret would let one bad key stop all archiving
    // until somebody deleted it by hand.
    const d = decideLock({ stored: 'not json at all', now: NOW, wallBudgetMs: WALL_BUDGET_MS })

    expect(d.action).toBe('take-over')
    if (d.action !== 'take-over') throw new Error('unreachable')
    expect(d.reason).toMatch(/could not be read/)
    // Unknown rather than a made up zero: reporting "held for 0 ms" would read
    // as a lock taken this instant.
    expect(d.heldForMs).toBeNull()
  })

  it('reads a bare timestamp, which is what the previous version wrote', () => {
    // The lock in production holds `new Date().toISOString()`. During the deploy
    // gap a new run reads an old value, and treating that as unreadable would
    // take over a live run.
    const d = decideLock({
      stored: '2026-08-21T17:33:00.000Z',
      now: NOW,
      wallBudgetMs: WALL_BUDGET_MS,
    })

    expect(d.action).toBe('skip')
    if (d.action !== 'skip') throw new Error('unreachable')
    expect(d.heldForMs).toBe(2 * 60 * 1000)
  })

  it('takes over an old bare timestamp that is past the derived deadline', () => {
    const d = decideLock({
      stored: '2026-08-21T17:23:00.000Z',
      now: at('2026-08-21T18:23:00.000Z'),
      wallBudgetMs: WALL_BUDGET_MS,
    })

    expect(d.action).toBe('take-over')
  })

  it('takes over a lock stamped in the future, rather than waiting for a clock that is wrong', () => {
    // A deadline beyond anything a run could legitimately claim means the value
    // is wrong, not that the run is long. Trusting it would block archiving for
    // as long as the bad stamp said.
    const stored = JSON.stringify({
      startedAt: '2027-01-01T00:00:00.000Z',
      deadlineAt: '2027-01-01T00:10:00.000Z',
    })
    const d = decideLock({ stored, now: NOW, wallBudgetMs: WALL_BUDGET_MS })

    expect(d.action).toBe('take-over')
    if (d.action !== 'take-over') throw new Error('unreachable')
    expect(d.reason).toMatch(/future/)
  })
})

describe('lockValue', () => {
  it('stamps both the start and the deadline, so a reader need not know the budget', () => {
    const stored = JSON.parse(lockValue(at('2026-08-21T17:23:00.000Z'), WALL_BUDGET_MS)) as Record<string, string>

    expect(stored.startedAt).toBe('2026-08-21T17:23:00.000Z')
    expect(stored.deadlineAt).toBe('2026-08-21T17:33:00.000Z')
  })
})
