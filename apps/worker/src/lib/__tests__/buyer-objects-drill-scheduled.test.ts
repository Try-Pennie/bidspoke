/**
 * The daily buyer objects drill (#1643). The Phase 3 drill used to run only by
 * hand through POST /api/admin/buyer-objects/drill and kept nothing, so after
 * the day 2 run there was no record of it having run at all. The scheduled run
 * writes a job_runs row with each scenario's outcome, the latency percentiles
 * and the drill's own claim expiries and heals (a separate line from the
 * organic counts on the parity row, never summed into them), and pages through
 * the shared alerter when a scenario fails or the drill does not finish.
 *
 * The drill itself runs against the real objects in the Workers suite; here it
 * is injected, and so is the deadline's timer (L524).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Timers } from '@bidspoke/buyer-profile'
import type { AlertRemedy } from '../export-alerts'
import {
  BUYER_OBJECTS_DRILL_JOB,
  BUYER_OBJECTS_DRILL_REMEDY,
  SCHEDULED_DRILL_DEADLINE_MS,
  runScheduledBuyerObjectsDrill,
  type BuyerObjectsDrill,
} from '../buyer-objects-health'

interface Recorded { table: string; op: string; row: Record<string, unknown> }

function supabaseDouble() {
  const writes: Recorded[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        insert(row: Record<string, unknown>) { writes.push({ table, op: 'insert', row }); return chain },
        update(row: Record<string, unknown>) { writes.push({ table, op: 'update', row }); return chain },
        eq() { return chain },
        select() { return chain },
        single() { return Promise.resolve({ data: { id: 'run-1' }, error: null }) },
        then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [{ id: 'run-1' }], error: null }).then(res) },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, writes }
}

const PASSED: BuyerObjectsDrill = {
  ok: true,
  ran_at: '2026-09-30T13:00:00.000Z',
  partner_id: 'drill-2026-09-30T13:00:00.000Z',
  scenarios: [
    { name: 'two leads race for one slot', ok: true },
    { name: 'two executions race on an in_doubt claim', ok: true },
  ],
  latency: { 'lead sale claim': { calls: 9, p50_ms: 12, p99_ms: 40, max_ms: 40 } },
  claim_events: { expired_in_flight: 3, in_doubt_heals: 1 },
}

const FAILED: BuyerObjectsDrill = {
  ...PASSED,
  ok: false,
  scenarios: [
    { name: 'two leads race for one slot', ok: true },
    { name: 'two executions race on an in_doubt claim', ok: false, detail: 'expected one sale and one replay, got sold and sold' },
  ],
}

/** A timer that never fires unless the test fires it. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = []
  const timers: Timers = {
    setTimeout: (fn: () => void, ms: number) => { pending.push({ fn, ms }); return pending.length as unknown as ReturnType<typeof setTimeout> },
    clearTimeout: () => undefined,
  } as unknown as Timers
  return { timers, pending }
}

function closeOf(writes: Recorded[]) {
  const close = writes.find((w) => w.op === 'update' && 'outcome' in w.row)
  if (!close) throw new Error('the job_runs row was never closed')
  return close.row
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the scheduled buyer objects drill (#1643)', () => {
  it('writes a job_runs row with every scenario, the latency and its own claim events, and clears the alert when all pass', async () => {
    const db = supabaseDouble()
    const notified: string[][] = []
    const r = await runScheduledBuyerObjectsDrill({ supabase: db.client, drill: async () => PASSED, notify: async (lines) => { notified.push(lines) }, log: () => undefined })

    expect(r.lines).toEqual([])
    expect(db.writes[0]).toMatchObject({ table: 'job_runs', op: 'insert', row: { job: BUYER_OBJECTS_DRILL_JOB } })
    expect(BUYER_OBJECTS_DRILL_JOB).toBe('buyer-objects-drill')
    const close = closeOf(db.writes)
    expect(close.outcome).toBe('passed')
    expect(close.summary).toEqual({
      ran_at: PASSED.ran_at,
      partner_id: PASSED.partner_id,
      scenarios: PASSED.scenarios,
      latency: PASSED.latency,
      drill_claim_events: { expired_in_flight: 3, in_doubt_heals: 1 },
    })
    // An empty list is what clears a standing alert (the shared alerter's contract).
    expect(notified).toEqual([[]])
  })

  it('a failed scenario is recorded as failed and pages, naming the scenario and what it saw', async () => {
    const db = supabaseDouble()
    const notified: string[][] = []
    const logs: string[] = []
    const r = await runScheduledBuyerObjectsDrill({ supabase: db.client, drill: async () => FAILED, notify: async (lines) => { notified.push(lines) }, log: (l) => logs.push(l) })

    const line = 'two executions race on an in_doubt claim: expected one sale and one replay, got sold and sold'
    expect(r.lines).toEqual([line])
    expect(closeOf(db.writes)).toMatchObject({ outcome: 'scenario_failed', summary: { scenarios: FAILED.scenarios } })
    expect(notified).toEqual([[line]])
    expect(logs.join('\n')).toContain(line)
  })

  it('a drill that does not finish inside the deadline is recorded and pages, never read as a pass', async () => {
    const db = supabaseDouble()
    const notified: string[][] = []
    const { timers, pending } = manualTimers()
    const running = runScheduledBuyerObjectsDrill({ supabase: db.client, drill: () => new Promise<BuyerObjectsDrill>(() => undefined), notify: async (lines) => { notified.push(lines) }, log: () => undefined, timers })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].ms).toBe(SCHEDULED_DRILL_DEADLINE_MS)
    pending[0].fn()
    const r = await running

    expect(r.lines).toEqual([`the drill did not finish: buyer objects drill did not answer within ${SCHEDULED_DRILL_DEADLINE_MS} ms`])
    expect(closeOf(db.writes)).toMatchObject({ outcome: 'did_not_finish' })
    expect(notified).toEqual([r.lines])
  })

  it('a drill that ran against anything but a throwaway drill buyer is refused by name, because it could have moved real counts', async () => {
    const db = supabaseDouble()
    const notified: string[][] = []
    const r = await runScheduledBuyerObjectsDrill({ supabase: db.client, drill: async () => ({ ...PASSED, partner_id: 'p-tripoint' }), notify: async (lines) => { notified.push(lines) }, log: () => undefined })

    expect(r.lines).toEqual(['the drill ran against p-tripoint, which is not a throwaway drill- buyer'])
    expect(closeOf(db.writes)).toMatchObject({ outcome: 'scenario_failed' })
    expect(notified).toEqual([r.lines])
  })

  // The page said "no real buyer count was touched" even over this line (#835).
  it('never says no real buyer count was touched when the drill ran against a real buyer, and says it otherwise', async () => {
    const remedies: AlertRemedy[] = []
    const notify = async (_lines: string[], remedy: AlertRemedy) => { remedies.push(remedy) }
    await runScheduledBuyerObjectsDrill({ supabase: supabaseDouble().client, drill: async () => ({ ...FAILED, partner_id: 'p-tripoint' }), notify, log: () => undefined })
    await runScheduledBuyerObjectsDrill({ supabase: supabaseDouble().client, drill: async () => FAILED, notify, log: () => undefined })
    expect(remedies[0].consequence).not.toMatch(/no real buyer count was touched/)
    expect(remedies[0].consequence).toMatch(/real buyer/)
    expect(remedies[1]).toBe(BUYER_OBJECTS_DRILL_REMEDY)
    expect(remedies[1].consequence).toMatch(/no real buyer count was touched/)
  })

  it('the deadline is the admin route\'s 30 seconds', () => {
    expect(SCHEDULED_DRILL_DEADLINE_MS).toBe(30_000)
  })
})
