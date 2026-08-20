import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchHour } from '../hour-fetch'
import { MAX_STEP_LAG_MS } from '../fetch'

const HOUR_START = '2026-08-18T10:00:00.000Z'
const HOUR_END = '2026-08-18T11:00:00.000Z'

interface RecordedQuery {
  table: string
  head: boolean
  gte: Record<string, string>
  lt: Record<string, string>
  range?: [number, number]
  order?: string
}

/**
 * Records the predicates each query was actually given, so a test can assert the
 * WINDOW that reached the database rather than only the rows that came back. A
 * double that only counts rows cannot tell a correct window from a wrong one.
 */
function fakeSupabase(opts: {
  executions: Record<string, unknown>[]
  steps: Record<string, unknown>[]
  executionCount?: number | null
  stepCount?: number | null
  queries: RecordedQuery[]
}) {
  const rowsFor = (table: string): Record<string, unknown>[] =>
    table === 'workflow_executions' ? opts.executions : opts.steps
  const countFor = (table: string): number | null => {
    if (table === 'workflow_executions') {
      return opts.executionCount === undefined ? opts.executions.length : opts.executionCount
    }
    return opts.stepCount === undefined ? opts.steps.length : opts.stepCount
  }

  return {
    from(table: string) {
      const q: RecordedQuery = { table, head: false, gte: {}, lt: {} }
      const builder = {
        select(_cols: string, options?: { count?: string; head?: boolean }) {
          q.head = options?.head === true
          opts.queries.push(q)
          return builder
        },
        gte(col: string, value: string) {
          q.gte[col] = value
          return builder
        },
        lt(col: string, value: string) {
          q.lt[col] = value
          return builder
        },
        order(col: string) {
          q.order = col
          return builder
        },
        range(from: number, to: number) {
          q.range = [from, to]
          return builder
        },
        then(resolve: (v: { data: unknown; error: null; count: number | null }) => void) {
          if (q.head) {
            resolve({ data: null, error: null, count: countFor(table) })
            return
          }
          const [from, to] = q.range ?? [0, rowsFor(table).length - 1]
          resolve({ data: rowsFor(table).slice(from, to + 1), error: null, count: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

const execution = (id: string): Record<string, unknown> => ({
  id,
  workflow_id: 'wf-1',
  status: 'success',
  started_at: HOUR_START,
})
const step = (id: string, executionId: string): Record<string, unknown> => ({
  id,
  execution_id: executionId,
  execution_started_at: HOUR_START,
  started_at: HOUR_START,
})

describe('fetchHour', () => {
  it('bounds steps by the hour their execution belongs to, and widens only the pruning hint', async () => {
    const queries: RecordedQuery[] = []
    const supabase = fakeSupabase({
      executions: [execution('e1')],
      steps: [step('s1', 'e1')],
      queries,
    })

    await fetchHour(supabase, HOUR_START, HOUR_END)

    const stepRead = queries.find((q) => q.table === 'execution_steps' && !q.head)
    expect(stepRead).toBeDefined()
    expect(stepRead?.gte.execution_started_at).toBe(HOUR_START)
    expect(stepRead?.lt.execution_started_at).toBe(HOUR_END)
    expect(Date.parse(stepRead?.lt.started_at ?? '')).toBe(Date.parse(HOUR_END) + MAX_STEP_LAG_MS)
  })

  it('orders every paged read by a unique column, since range paging an unordered result is undefined', async () => {
    const queries: RecordedQuery[] = []
    const supabase = fakeSupabase({ executions: [execution('e1')], steps: [step('s1', 'e1')], queries })

    await fetchHour(supabase, HOUR_START, HOUR_END)

    for (const q of queries.filter((q) => !q.head)) {
      expect(q.order, `${q.table} was paged without an order`).toBe('id')
    }
  })

  it('groups each execution with its own steps', async () => {
    const supabase = fakeSupabase({
      executions: [execution('e1'), execution('e2')],
      steps: [step('s1', 'e1'), step('s2', 'e2'), step('s3', 'e1')],
      queries: [],
    })

    const result = await fetchHour(supabase, HOUR_START, HOUR_END)

    expect(result.usable).toBe(true)
    if (!result.usable) return
    expect(result.bundles).toHaveLength(2)
    expect(result.bundles.find((b) => b.executionId === 'e1')?.steps).toHaveLength(2)
    expect(result.bundles.find((b) => b.executionId === 'e2')?.steps).toHaveLength(1)
  })

  // An execution that failed before its first step logged is real, and dropping
  // it would leave the deletion gate short by one with nothing explaining why.
  it('keeps an execution that has no steps at all', async () => {
    const supabase = fakeSupabase({
      executions: [execution('e1'), execution('e2')],
      steps: [step('s1', 'e1')],
      queries: [],
    })

    const result = await fetchHour(supabase, HOUR_START, HOUR_END)

    expect(result.usable).toBe(true)
    if (!result.usable) return
    expect(result.bundles).toHaveLength(2)
    expect(result.bundles.find((b) => b.executionId === 'e2')?.steps).toEqual([])
  })

  it('refuses the whole hour when the step read does not reconcile, rather than bundling what it got', async () => {
    const supabase = fakeSupabase({
      executions: [execution('e1')],
      steps: [step('s1', 'e1')],
      stepCount: 5,
      queries: [],
    })

    const result = await fetchHour(supabase, HOUR_START, HOUR_END)

    expect(result.usable).toBe(false)
    if (result.usable) return
    expect(result.reason).toMatch(/1 against 5/)
  })

  it('refuses when the execution read does not reconcile', async () => {
    const supabase = fakeSupabase({
      executions: [execution('e1')],
      steps: [],
      executionCount: 9,
      queries: [],
    })

    const result = await fetchHour(supabase, HOUR_START, HOUR_END)

    expect(result.usable).toBe(false)
    if (result.usable) return
    expect(result.reason).toMatch(/1 against 9/)
  })

  // PostgREST omits the count header in some conditions, and a null read as
  // zero would make every hour report itself empty and archive nothing, while
  // every run reported success (L90: a value nothing ever writes reads as a
  // confident measurement).
  it('refuses when the count comes back absent, rather than reading it as no rows', async () => {
    const supabase = fakeSupabase({
      executions: [execution('e1')],
      steps: [],
      executionCount: null,
      queries: [],
    })

    const result = await fetchHour(supabase, HOUR_START, HOUR_END)

    expect(result.usable).toBe(false)
    if (result.usable) return
    expect(result.reason).toMatch(/no count/)
    expect(result.reason).toMatch(/not the same as no rows/)
  })

  it('reports an empty hour as its own outcome and never reads steps for it', async () => {
    const queries: RecordedQuery[] = []
    const supabase = fakeSupabase({ executions: [], steps: [], queries })

    const result = await fetchHour(supabase, HOUR_START, HOUR_END)

    expect(result.usable).toBe(true)
    if (!result.usable) return
    expect(result.bundles).toEqual([])
    expect(result.empty).toBe(true)
    expect(queries.some((q) => q.table === 'execution_steps')).toBe(false)
  })
})
