/**
 * The unlock table (#1710, plan 0.5): how many switched on Pipedream workflows
 * could move to Bidspoke after each capability lands, and the build order derived
 * from it. Re-run at each phase end; the order is re-derived from the output.
 *
 * A workflow is unlocked once every capability it needs (needs.ts) has been
 * added. Rows are cumulative. The right hand count leaves out workflows with a web
 * request step whose settings the export redacted, which cannot convert until
 * those settings are read off Pipedream: that column is the real ceiling.
 */
import type { Capability } from './needs.ts'

/** The plan's derived order (Discussion #1684, 0.5): Phases 2 and 3, then 1, 4, 7, 5, 6, 8. */
export const PLAN_ORDER: readonly Capability[] = ['code_runtime', 'connections', 'schedules', 'data_stores', 'long_runs', 'request_access', 'non_http_triggers', 'runner']

/** Hard dependencies: Phase 7's continuations and retries need Phase 1's run engine. */
const REQUIRES: Partial<Record<Capability, Capability[]>> = { long_runs: ['schedules'] }

export interface UnlockItem {
  hashid: string
  needs: Set<Capability>
  redactedHttpSteps: number
  filterRules: boolean
  multiTrigger: boolean
  bidding: boolean
  raisedTimeout: boolean
}

export interface UnlockRow {
  /** The capability this row adds; null for the first row, today's platform. */
  added: Capability | null
  unlocked: number
  unlockedNoRedacted: number
  bidding: number
  filterRules: number
  multiTrigger: number
  raisedTimeout: number
  /** Workflows this row unlocks that the row before did not. */
  newly: string[]
}

export type UnlockTable = UnlockRow[] & { stillBlocked: string[] }

const met = (it: UnlockItem, have: Set<Capability>) => [...it.needs].every((c) => have.has(c))

export function unlockTable(items: UnlockItem[], order: readonly Capability[]): UnlockTable {
  const have = new Set<Capability>()
  const done = new Set<string>()
  const rows: UnlockRow[] = []
  for (const added of [null, ...order] as Array<Capability | null>) {
    if (added !== null) have.add(added)
    const newly = items.filter((it) => !done.has(it.hashid) && met(it, have)).map((it) => it.hashid).sort()
    for (const h of newly) done.add(h)
    const unlocked = items.filter((it) => done.has(it.hashid))
    rows.push({
      added,
      unlocked: unlocked.length,
      unlockedNoRedacted: unlocked.filter((it) => it.redactedHttpSteps === 0).length,
      bidding: unlocked.filter((it) => it.bidding).length,
      filterRules: unlocked.filter((it) => it.filterRules).length,
      multiTrigger: unlocked.filter((it) => it.multiTrigger).length,
      raisedTimeout: unlocked.filter((it) => it.raisedTimeout).length,
      newly,
    })
  }
  return Object.assign(rows, { stillBlocked: items.filter((it) => !done.has(it.hashid)).map((it) => it.hashid).sort() })
}

/**
 * The order re-derived from the data: each next capability is the one, among those
 * whose prerequisites are in, that unlocks the most workflows; ties go to the plan
 * order. A capability that unlocks nothing yet still enters, last, in plan order.
 */
export function deriveOrder(items: UnlockItem[]): Capability[] {
  const have = new Set<Capability>()
  const order: Capability[] = []
  while (order.length < PLAN_ORDER.length) {
    const ready = PLAN_ORDER.filter((c) => !have.has(c) && (REQUIRES[c] ?? []).every((r) => have.has(r)))
    let best = ready[0]
    let bestCount = -1
    for (const c of ready) {
      const next = new Set([...have, c])
      const count = items.filter((it) => met(it, next) && !met(it, have)).length
      if (count > bestCount) { best = c; bestCount = count }
    }
    have.add(best)
    order.push(best)
  }
  return order
}
