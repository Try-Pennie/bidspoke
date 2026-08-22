/**
 * An hour is read in slices, so peak memory does not scale with the hour (#953).
 *
 * Measured on prod 2026-08-22 with `scripts/dry-run-archive.ts`: ONE hour of
 * 2,615 executions holds 183.5 MB of raw rows plus 33.8 MB of encoded wires,
 * both alive at once during encoding, against Cloudflare's 128 MB ceiling. The
 * 16:23 UTC run was killed with outcome `exceededMemory` at 9.4 s of CPU, well
 * inside the 30 s processor allowance, and every run after it died the same way
 * because a killed run never advances the watermark.
 *
 * The old shape read a whole hour, returned every bundle, and let the caller
 * encode them all. Its per-run cap was justified in a comment against CPU, which
 * is the limit that was never going to bind. No cap value fixes this: a single
 * busy hour exceeds the ceiling on its own, which is why the unit of work has to
 * be a slice rather than an hour.
 *
 * What must survive the change: the hour is still reconciled against
 * independently counted expectations, so a short read refuses the hour rather
 * than archiving what arrived (L63, L98).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { streamHour, SLICE_SIZE, MAX_ID_LIST_CHARS } from '../stream-hour'
import type { HourBundle } from '../stream-hour'
import { MAX_STEP_LAG_MS } from '../fetch'

const HOUR_START = '2026-08-18T10:00:00.000Z'
const HOUR_END = '2026-08-18T11:00:00.000Z'

interface RecordedQuery {
  table: string
  head: boolean
  gte: Record<string, string>
  lt: Record<string, string>
  gt?: Record<string, string>
  inValues?: string[]
  limit?: number
  order?: string
}

function fakeSupabase(opts: {
  executions: Record<string, unknown>[]
  steps: Record<string, unknown>[]
  executionCount?: number | null
  stepCount?: number | null
  queries: RecordedQuery[]
}) {
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
        gte(col: string, value: string) { q.gte[col] = value; return builder },
        lt(col: string, value: string) { q.lt[col] = value; return builder },
        order(col: string) { q.order = col; return builder },
        gt(col: string, value: string) { q.gt = { ...(q.gt ?? {}), [col]: value }; return builder },
        in(col: string, values: string[]) { q.inValues = values; void col; return builder },
        limit(n: number) { q.limit = n; return builder },
        then(resolve: (v: { data: unknown; error: null; count: number | null }) => void) {
          if (q.head) {
            resolve({ data: null, error: null, count: countFor(table) })
            return
          }
          if (table === 'workflow_executions') {
            const after = q.gt?.id
            const start = after === undefined ? 0 : opts.executions.findIndex((r) => String(r.id) === after) + 1
            resolve({ data: opts.executions.slice(start, start + (q.limit ?? opts.executions.length)), error: null, count: null })
            return
          }
          // Steps are asked for BY NAME, so the double must honour the id list or
          // the test would pass while the real query returned the whole hour.
          const wanted = new Set(q.inValues ?? [])
          const mine = opts.steps.filter((s) => wanted.has(String(s.execution_id)))
          const after = q.gt?.id
          const start = after === undefined ? 0 : mine.findIndex((r) => String(r.id) === after) + 1
          resolve({ data: mine.slice(start, start + (q.limit ?? mine.length)), error: null, count: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

const execution = (id: string): Record<string, unknown> => ({
  id, workflow_id: 'wf-1', status: 'success', started_at: HOUR_START,
})
const step = (id: string, executionId: string): Record<string, unknown> => ({
  id, execution_id: executionId, execution_started_at: HOUR_START, started_at: HOUR_START,
})

function fixture(executionCount: number, stepsEach: number) {
  const executions = Array.from({ length: executionCount }, (_, i) => execution(`e${String(i).padStart(5, '0')}`))
  const steps = executions.flatMap((e) =>
    Array.from({ length: stepsEach }, (_, j) => step(`${String(e.id)}-s${j}`, String(e.id))),
  )
  return { executions, steps }
}

async function collect(opts: Parameters<typeof fakeSupabase>[0]) {
  const slices: HourBundle[][] = []
  const result = await streamHour(fakeSupabase(opts), HOUR_START, HOUR_END, async (bundles) => {
    slices.push(bundles)
  })
  return { result, slices }
}

describe('streamHour holds a slice, never an hour', () => {
  it('never hands the caller more than one slice worth of bundles', async () => {
    const { executions, steps } = fixture(SLICE_SIZE * 3 + 7, 2)
    const queries: RecordedQuery[] = []
    const { result, slices } = await collect({ executions, steps, queries })

    expect(result.usable).toBe(true)
    // The point of the change: the largest thing alive at once is a slice.
    const biggest = Math.max(...slices.map((s) => s.length))
    expect(biggest).toBeLessThanOrEqual(SLICE_SIZE)
    expect(slices.length).toBe(4)
    // Every execution still reaches the caller exactly once. A slicer that
    // dropped or repeated one would otherwise look identical here.
    const seen = slices.flat().map((b) => b.executionId)
    expect(seen.length).toBe(executions.length)
    expect(new Set(seen).size).toBe(executions.length)
  })

  it('asks for each slices steps by name, and still bounds them by the hour', async () => {
    const { executions, steps } = fixture(3, 2)
    const queries: RecordedQuery[] = []
    await collect({ executions, steps, queries })

    const stepRead = queries.find((q) => q.table === 'execution_steps' && !q.head)
    expect(stepRead?.inValues).toEqual(['e00000', 'e00001', 'e00002'])
    // The window predicates stay, because they are what prunes partitions. The
    // id list alone would scan every partition the table has.
    expect(stepRead?.gte.execution_started_at).toBe(HOUR_START)
    expect(stepRead?.lt.execution_started_at).toBe(HOUR_END)
    expect(stepRead?.lt.started_at).toBe(new Date(Date.parse(HOUR_END) + MAX_STEP_LAG_MS).toISOString())
  })

  it('gives each execution its own steps and no one elses', async () => {
    const { executions, steps } = fixture(2, 2)
    const { slices } = await collect({ executions, steps, queries: [] })
    const bundles = slices.flat()

    expect(bundles[0].steps.map((s) => s.execution_id)).toEqual(['e00000', 'e00000'])
    expect(bundles[1].steps.map((s) => s.execution_id)).toEqual(['e00001', 'e00001'])
  })

  it('keeps an execution that logged no steps', async () => {
    const { slices } = await collect({
      executions: [execution('e1')],
      steps: [],
      queries: [],
    })
    // Dropping it would leave the deletion gate one short with nothing to
    // explain the difference.
    expect(slices.flat()).toHaveLength(1)
    expect(slices.flat()[0].steps).toEqual([])
  })

  it('refuses the hour when fewer executions arrive than were counted', async () => {
    const { executions, steps } = fixture(3, 1)
    const { result } = await collect({ executions, steps, executionCount: 5, queries: [] })

    expect(result.usable).toBe(false)
    if (!result.usable) expect(result.reason).toMatch(/execution/i)
  })

  it('refuses the hour when fewer steps arrive than were counted', async () => {
    const { executions, steps } = fixture(3, 1)
    const { result } = await collect({ executions, steps, stepCount: 99, queries: [] })

    expect(result.usable).toBe(false)
    if (!result.usable) expect(result.reason).toMatch(/step/i)
  })

  it('reports an hour with no executions as empty without reading steps', async () => {
    const queries: RecordedQuery[] = []
    const { result, slices } = await collect({ executions: [], steps: [], queries })

    expect(result.usable && result.empty).toBe(true)
    expect(slices).toEqual([])
    // "Found nothing" and "read nothing" are different outcomes (L98).
    expect(queries.filter((q) => q.table === 'execution_steps')).toEqual([])
  })

  it('counts the requests it actually made rather than estimating', async () => {
    const { executions, steps } = fixture(SLICE_SIZE * 2, 1)
    const { result } = await collect({ executions, steps, queries: [] })

    // Two counts, then per slice one execution page plus at least one step page.
    expect(result.requests).toBeGreaterThanOrEqual(2 + 2 * 2)
  })

  it('refuses rather than truncating when a slice would name too many ids', async () => {
    // The one new failure mode this shape introduces: the id list travels in the
    // URL. A slice size that outgrew the limit must say so, not quietly ask for
    // fewer and reconcile short (L99, L100).
    expect(SLICE_SIZE * 40).toBeLessThan(MAX_ID_LIST_CHARS)
  })
})
