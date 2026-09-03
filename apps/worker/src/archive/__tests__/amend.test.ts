import { describe, expect, it } from 'vitest'
import { amendDecisions, AMEND_GIVE_UP_MS, type ArchivedIncomplete, type LiveExecution } from '../amend'

/**
 * What to do with an execution the archive holds as INCOMPLETE (#871, #932).
 *
 * Why this exists at all: the deletion gate refuses any day carrying an
 * incomplete row, and both places that reason about that tolerance justify it by
 * citing an amend pass. Without one, an incomplete row is permanent, the day is
 * refused forever, its partition can never be purged, and the alert names a
 * remedy that does not exist. The gate fails safe, so this is a wedge rather than
 * a data loss, but it wedges the one path that stops the database growing.
 *
 * The third answer is the one that took the thinking. A row that can NEVER
 * finalise has to be dispositioned explicitly, or the wedge simply moves: chasing
 * it forever leaves the day refused forever just the same.
 */

const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-09-03T12:00:00Z')

function archived(over: Partial<ArchivedIncomplete> = {}): ArchivedIncomplete {
  return {
    executionId: '01a06875-33d7-748a-8038-50b49d7731a1',
    archiveDay: '2026-09-01',
    archivedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    ...over,
  }
}

function live(over: Partial<LiveExecution> = {}): LiveExecution {
  return {
    executionId: '01a06875-33d7-748a-8038-50b49d7731a1',
    status: 'completed',
    ...over,
  }
}

describe('amendDecisions', () => {
  it('rewrites an execution that has since finalised', () => {
    const [d] = amendDecisions([archived()], [live({ status: 'completed' })], NOW)
    expect(d.action).toBe('amend')
    expect(d.executionId).toBe(archived().executionId)
  })

  it.each(['completed', 'failed', 'exited', 'degraded'])('treats %s as finalised', (status) => {
    expect(amendDecisions([archived()], [live({ status })], NOW)[0].action).toBe('amend')
  })

  it('waits on an execution that is still running and inside the give-up window', () => {
    const [d] = amendDecisions([archived()], [live({ status: 'running' })], NOW)
    expect(d.action).toBe('wait')
    // Nothing is sent and nothing is written off: the day stays refused, which is
    // correct while the row may still finish.
    expect(d.reason).toContain('running')
  })

  it('gives up on an execution still running past the give-up window, with its own action', () => {
    const stale = archived({ archivedAt: new Date(NOW.getTime() - AMEND_GIVE_UP_MS - HOUR).toISOString() })
    const [d] = amendDecisions([stale], [live({ status: 'running' })], NOW)
    // Its OWN action, not folded into 'amend'. A row written off as permanently
    // incomplete is a different event from one corrected, and the gate has to be
    // able to tell them apart (L11, L260).
    expect(d.action).toBe('give-up')
    expect(d.reason).toMatch(/still non-terminal/i)
  })

  it('gives up on an execution Postgres no longer holds', () => {
    // It can never be amended from anywhere, so chasing it forever leaves the day
    // refused forever. This is the case that turns the wedge into a decision.
    const [d] = amendDecisions([archived()], [], NOW)
    expect(d.action).toBe('give-up')
    expect(d.reason).toMatch(/no longer in postgres/i)
  })

  it('gives up on a missing execution even inside the give-up window', () => {
    // Age is irrelevant when the source is gone: waiting cannot help, and the
    // window exists to bound WAITING, not to delay an answer already known.
    const fresh = archived({ archivedAt: new Date(NOW.getTime() - 1000).toISOString() })
    expect(amendDecisions([fresh], [], NOW)[0].action).toBe('give-up')
  })

  it('decides each execution independently', () => {
    const a = archived({ executionId: 'a' })
    const b = archived({ executionId: 'b' })
    const c = archived({ executionId: 'c' })
    const decisions = amendDecisions(
      [a, b, c],
      [live({ executionId: 'a', status: 'completed' }), live({ executionId: 'b', status: 'running' })],
      NOW,
    )
    expect(decisions.map((d) => `${d.executionId}:${d.action}`)).toEqual(['a:amend', 'b:wait', 'c:give-up'])
  })

  it('returns nothing for no input rather than throwing', () => {
    expect(amendDecisions([], [], NOW)).toEqual([])
  })

  it('does not wait on a missing cost', () => {
    // Measured (fixtures/cost-settlement.json): for a FAILED execution an absent
    // cost is the settled final state, not a late arrival. 20 of 764,301 settled
    // executions had no cost, all of them failed, all with a completion time, the
    // oldest 93 hours old. Anything that waits for a cost before calling a row
    // finished waits forever on about 5 rows a day and then alerts about nothing.
    const [d] = amendDecisions([archived()], [live({ status: 'failed', costUsd: null })], NOW)
    expect(d.action).toBe('amend')
  })

  it('gives up on an unrecognised status rather than waiting on it forever', () => {
    // A status this code does not know is not evidence the row is still running.
    // Treating it as running would wait out the whole window on every such row and
    // then write it off anyway; treating it as terminal would archive a row whose
    // state nobody understands as final. It is given up on with its own reason so
    // the value appears in the record (L11).
    const [d] = amendDecisions([archived()], [live({ status: 'wat' })], NOW)
    expect(d.action).toBe('give-up')
    expect(d.reason).toContain('wat')
  })
})
