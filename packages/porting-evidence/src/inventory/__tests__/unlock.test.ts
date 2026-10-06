import { describe, expect, it } from 'vitest'
import type { Capability } from '../needs.ts'
import { PLAN_ORDER, deriveOrder, unlockTable, type UnlockItem } from '../unlock.ts'

const item = (hashid: string, needs: Capability[], extra: Partial<UnlockItem> = {}): UnlockItem => ({
  hashid,
  needs: new Set(needs),
  redactedHttpSteps: 0,
  filterRules: false,
  multiTrigger: false,
  bidding: false,
  raisedTimeout: false,
  ...extra,
})

describe('unlockTable (#1710)', () => {
  const items = [
    item('p_now', []),
    item('p_code', ['code_runtime'], { redactedHttpSteps: 2 }),
    item('p_code_sched', ['code_runtime', 'schedules'], { bidding: true }),
    item('p_runner', ['runner'], { multiTrigger: true, filterRules: true, raisedTimeout: true }),
  ]

  it('counts, cumulatively, the workflows whose every need is met after each capability', () => {
    const rows = unlockTable(items, ['code_runtime', 'schedules', 'runner'])
    expect(rows.map((r) => [r.added, r.unlocked, r.unlockedNoRedacted, r.newly])).toEqual([
      [null, 1, 1, ['p_now']],
      ['code_runtime', 2, 1, ['p_code']],
      ['schedules', 3, 2, ['p_code_sched']],
      ['runner', 4, 3, ['p_runner']],
    ])
    expect(rows[3]).toMatchObject({ bidding: 1, multiTrigger: 1, filterRules: 1, raisedTimeout: 1 })
  })

  it('reports by name what no listed capability unlocks, rather than dropping it', () => {
    const rows = unlockTable(items, ['code_runtime'])
    expect(rows.at(-1)?.unlocked).toBe(2)
    expect(unlockTable(items, ['code_runtime']).stillBlocked).toEqual(['p_code_sched', 'p_runner'])
  })

  it('names every capability in the plan order once', () => {
    expect(new Set(PLAN_ORDER).size).toBe(8)
  })
})

describe('deriveOrder (#1710)', () => {
  it('adds next whichever capability unlocks the most, keeping long runs after schedules', () => {
    const items2 = [
      item('a', ['long_runs']), item('b', ['long_runs']), item('c', ['long_runs']),
      item('d', ['schedules']),
      item('e', ['connections']), item('f', ['connections']),
    ]
    // Long runs unlock the most on their own, but need the schedules run engine first.
    expect(deriveOrder(items2)).toEqual(['connections', 'schedules', 'long_runs', ...PLAN_ORDER.filter((c) => !['connections', 'schedules', 'long_runs'].includes(c))])
  })

  it('breaks a tie by the plan order', () => {
    const order = deriveOrder([item('a', ['runner']), item('b', ['code_runtime'])])
    expect(order.slice(0, 2)).toEqual(['code_runtime', 'runner'])
  })
})
