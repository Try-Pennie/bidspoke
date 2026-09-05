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

describe('a retry of the same scheduled event (#1181)', () => {
  // Cloudflare re-dispatches a cron whose invocation it terminated. Measured on
  // prod: 2026-08-26 03:23 (retry 03:26), 2026-09-01 19:23 (retry 19:24) and
  // 2026-09-05 00:23 (retry 00:24). Each retry arrived inside the dead run's
  // deadline, read the lock as held, and skipped, so the platform's own recovery
  // was thrown away and the hours waited for the next cadence.
  //
  // The retry carries the same scheduledTime as the attempt it replaces, and the
  // runtime only retries after that attempt has ended. So a lock stamped with
  // THIS invocation's scheduled time was written by an attempt that is no
  // longer running, whatever its deadline says.
  const SCHEDULED = at('2026-09-05T00:23:00.000Z')
  const KILLED_AT = at('2026-09-05T00:23:35.000Z')
  const RETRY_AT = at('2026-09-05T00:24:18.000Z')

  it('takes over a lock stamped with its own scheduled time, even inside the deadline', () => {
    const stored = lockValue(KILLED_AT, WALL_BUDGET_MS, SCHEDULED)
    const d = decideLock({ stored, now: RETRY_AT, wallBudgetMs: WALL_BUDGET_MS, scheduledFor: SCHEDULED })

    expect(d.action).toBe('take-over')
    if (d.action !== 'take-over') throw new Error('unreachable')
    expect(d.heldForMs).toBe(43 * 1000)
    // Its own wording (L11): a retry is not a deadline overrun, and the alert
    // reader has to be able to tell the two apart.
    expect(d.reason).toMatch(/retry of the same scheduled event/)
    expect(d.reason).not.toMatch(/past its own deadline/)
  })

  it('still skips when the holder was taken for a DIFFERENT scheduled event inside its deadline', () => {
    // The negative control: the takeover must key on the event, not merely on a
    // scheduled time being present. A run for the previous hour still inside its
    // budget is a live run.
    const stored = lockValue(KILLED_AT, WALL_BUDGET_MS, at('2026-09-04T23:23:00.000Z'))
    const d = decideLock({ stored, now: RETRY_AT, wallBudgetMs: WALL_BUDGET_MS, scheduledFor: SCHEDULED })

    expect(d.action).toBe('skip')
  })

  it('still skips when this invocation has no scheduled time, whatever the stamp carries', () => {
    // The backlog walk and the admin route are not cron retries and pass none.
    const stored = lockValue(KILLED_AT, WALL_BUDGET_MS, SCHEDULED)
    const d = decideLock({ stored, now: RETRY_AT, wallBudgetMs: WALL_BUDGET_MS })

    expect(d.action).toBe('skip')
  })

  it('still skips a stamp that carries no scheduled time, which is what production writes today', () => {
    // During the deploy gap the retry reads a stamp the previous version wrote.
    // Nothing in it can prove the holder dead, so the deadline rule stands.
    const stored = lockValue(KILLED_AT, WALL_BUDGET_MS)
    const d = decideLock({ stored, now: RETRY_AT, wallBudgetMs: WALL_BUDGET_MS, scheduledFor: SCHEDULED })

    expect(d.action).toBe('skip')
  })

  it('round-trips the scheduled time through the stamp', () => {
    const stored = JSON.parse(lockValue(KILLED_AT, WALL_BUDGET_MS, SCHEDULED)) as Record<string, string>

    expect(stored.scheduledFor).toBe('2026-09-05T00:23:00.000Z')
  })
})
