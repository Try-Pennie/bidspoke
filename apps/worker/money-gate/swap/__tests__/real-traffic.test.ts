/**
 * Instrument 3 of a validation swap (#2591, real-traffic.ts), against an in
 * memory stand in for the production tables, read through the same read only
 * client the script uses. It holds that every run lands in exactly one bucket,
 * that only runs of a version carrying the pinned script are judged, that a
 * seeded defect is named by its check, that the report and the log carry no
 * payload value or id, and that a read it cannot vouch for is refused.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readOnlyClient } from '../../lib/read-only-client'
import { seedDefect, type SwapCandidate } from '../candidate'
import { BUCKETS } from '../outcomes'
import { formatRealTrafficReport, replayRealTraffic, ReplayRefused, PAGE } from '../real-traffic'
import { parseArgs } from '../../../scripts/lead-validation-replay'
import lendswift from '../candidates/rml-lendswift.json'
import lendswiftDef from '../../fixtures/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json'

type Row = Record<string, unknown>

/**
 * A query builder over arrays, with the filters the replay uses. `dropFromPages`
 * loses rows from every page while counts stay true, which is what a short read
 * looks like.
 */
function fakeClient(tables: Record<string, Row[]>, opts: { dropFromPages?: number } = {}) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let head = false
    let window: [number, number] | null = null
    let orderBy: string | null = null
    const b = {
      select(_cols: string, o?: { count?: string; head?: boolean }) { head = o?.head === true; return b },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
      gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b },
      lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return b },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
      order(c: string) { orderBy = c; return b },
      range(a: number, z: number) { window = [a, z]; return b },
      abortSignal() { return b },
      then(resolve: (v: { data: unknown; error: null; count: number | null }) => unknown) {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        if (head) return Promise.resolve({ data: null, error: null, count: rows.length }).then(resolve)
        if (orderBy) rows = [...rows].sort((x, y) => (String(x[orderBy!]) < String(y[orderBy!]) ? -1 : 1))
        if (window) rows = rows.slice(window[0], window[1] + 1)
        if (opts.dropFromPages) rows = rows.slice(opts.dropFromPages)
        return Promise.resolve({ data: rows, error: null, count: null }).then(resolve)
      },
    }
    return b
  }
  return readOnlyClient({ from } as unknown as SupabaseClient)
}

const candidate = lendswift as unknown as SwapCandidate
const WF = candidate.workflow_id
const NS = candidate.replaces.namespace
const otherDefinition = structuredClone(lendswiftDef.definition)
const otherStep = otherDefinition.nodes.find((n) => n.namespace === NS) as unknown as { config: { script: string } }
otherStep.config.script = `${otherStep.config.script}\n// another version`

// Values a report must never print.
const SECRET = { name: 'SentinelGivenName', lead: 'lead-sentinel-7731', trace: 'trace-sentinel-5521' }

function payload(employmentStatus: string) {
  return { leadUuid: SECRET.lead, personalInformation: { state: 'TX', firstName: SECRET.name, lastName: 'Reyes' }, loanInformation: { loanAmount: 1000 }, financialInformation: { employmentStatus } }
}
const rejected = (reason: string) => ({ response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: { lead_id: SECRET.lead, status: 'rejected', reason } } })

function world(): Record<string, Row[]> {
  const at = (h: number, m: number) => `2026-10-20T0${h}:${String(m).padStart(2, '0')}:00.000Z`
  const runs: Row[] = []
  const steps: Row[] = []
  let n = 0
  const run = (startedAt: string, version: string, employmentStatus: string, validate: { status: string; output: unknown } | null) => {
    const id = `run-${++n}`
    runs.push({ id, workflow_id: WF, is_test: false, started_at: startedAt, workflow_version_id: version, trigger_payload: payload(employmentStatus), trace_id: SECRET.trace })
    const step = (ns: string, status: string, output: unknown, order: number) => steps.push({ id: `${id}-${ns}`, execution_id: id, workflow_id: WF, execution_started_at: startedAt, step_namespace: ns, status, output, step_order: order })
    step('constants', 'completed', { biddingActive: true, states: ['TX'], maximumLoanAmount: 5001 }, 1)
    step('parse_name', 'completed', { firstName: SECRET.name, lastName: 'Reyes' }, 2)
    if (validate) step(NS, validate.status, validate.output, 3)
  }
  run(at(0, 5), 'v-pinned', 'employed', { status: 'completed', output: { valid: true } })
  run(at(0, 10), 'v-pinned', 'military', { status: 'completed', output: rejected('military status ineligible') })
  run(at(1, 5), 'v-pinned', 'employed', { status: 'failed', output: null })
  run(at(1, 10), 'v-pinned', 'employed', null)
  run(at(1, 15), 'v-other', 'military', { status: 'completed', output: rejected('military status ineligible') })
  // A test run is never real traffic.
  runs.push({ ...runs[0], id: 'run-test', is_test: true })
  return {
    workflow_versions: [
      { id: 'v-pinned', workflow_id: WF, definition: lendswiftDef.definition },
      { id: 'v-other', workflow_id: WF, definition: otherDefinition },
    ],
    workflow_executions: runs,
    execution_steps: steps,
  }
}

const window = { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-10-20T02:00:00Z') }

describe('replayRealTraffic', () => {
  it('puts every judged run in exactly one bucket, and judges only runs of a pinned version', async () => {
    const log: string[] = []
    const r = await replayRealTraffic(candidate, window, { client: fakeClient(world()), log: (l) => log.push(l) })
    expect(r.versions).toEqual({ pinned: 1, total: 2 })
    expect(r.runsInWindow).toBe(5)
    expect(r.runsJudged).toBe(4)
    expect(r.buckets).toEqual({ agree: 2, response_differs: 0, script_threw: 1, node_threw: 0, no_validate_step: 1 })
    expect(BUCKETS.reduce((s, b) => s + r.buckets[b], 0)).toBe(r.runsJudged)
    expect(r.scriptReasons).toEqual({ 'military status ineligible': 1 })
    expect(r.afterScriptThrew).toEqual({ pass: 1, reject: 0, threw: 0 })
    expect(r.noValidateStep).toEqual({ 'no step row': 1 })
  })

  it('reads a recorded answer\'s keys in any order: the step output is jsonb, which stores keys in its own order (#2594)', async () => {
    const tables = world()
    const military = tables.execution_steps.find((s) => s.step_namespace === NS && s.execution_id === 'run-2')!
    // Postgres jsonb orders keys shorter first: reason, status, lead_id.
    military.output = { response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: { reason: 'military status ineligible', status: 'rejected', lead_id: SECRET.lead } } }
    const r = await replayRealTraffic(candidate, window, { client: fakeClient(tables), log: () => {} })
    expect(r.buckets).toEqual({ agree: 2, response_differs: 0, script_threw: 1, node_threw: 0, no_validate_step: 1 })
  })

  it('names a seeded defect by its check, and prints no payload value or id', async () => {
    const log: string[] = []
    const seeded = seedDefect(candidate, 'military', 'lenient')
    const r = await replayRealTraffic(seeded, window, { client: fakeClient(world()), log: (l) => log.push(l) })
    // The run whose step failed is let through by the node with or without the
    // seed (passes_after_throw); the seed adds exactly the military lead.
    expect(r.differences).toEqual({ 'node_passes at military': { count: 1, fields: [] }, 'passes_after_throw at -': { count: 1, fields: [] } })
    const text = `${log.join('\n')}\n${formatRealTrafficReport(r, seeded)}`
    expect(text).toContain('node_passes at military: 1')
    expect(text).toContain('military status ineligible: 1 / 0  (fewer than 20 real cases: covered by the grid only)')
    for (const value of [...Object.values(SECRET), 'run-1', 'v-pinned']) expect(text).not.toContain(value)
  })

  it('refuses, by name, a read it cannot vouch for', async () => {
    const deps = (tables: Record<string, Row[]>, o?: { dropFromPages?: number }) => ({ client: fakeClient(tables, o), log: () => {} })
    const noPinned = world()
    noPinned.workflow_versions = noPinned.workflow_versions.filter((v) => v.id !== 'v-pinned')
    await expect(replayRealTraffic(candidate, window, deps(noPinned))).rejects.toThrow(/no version of .* carries the pinned script/)
    await expect(replayRealTraffic(candidate, { from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-10-19T01:00:00Z') }, deps(world()))).rejects.toThrow(/no run of a pinned version .* started between/)
    await expect(replayRealTraffic(candidate, window, deps(world(), { dropFromPages: 1 }))).rejects.toThrow(ReplayRefused)
    await expect(replayRealTraffic(candidate, { from: window.to, to: window.from }, deps(world()))).rejects.toThrow(/the window is empty/)
  })

  it('reads pages no larger than the row cap', () => {
    expect(PAGE).toBeLessThanOrEqual(1000)
  })
})

describe('the replay command line', () => {
  it('takes a candidate and its options, and refuses anything else by name', () => {
    expect(parseArgs(['rml-gigfi', '--hours', '6', '--seed', 'state:strict'])).toMatchObject({ candidate: 'rml-gigfi', hours: 6, seed: 'state:strict' })
    expect(() => parseArgs([])).toThrow(/name a candidate/)
    expect(() => parseArgs(['x', '--hours', '200'])).toThrow(/1 to 168/)
    expect(() => parseArgs(['x', '--wat'])).toThrow(/unknown option/)
  })
})
