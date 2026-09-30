/**
 * The exit check for Phase 3 (#1410, L3, L4): a health probe that only reads,
 * and a drill that runs the attempt against the deployed objects.
 *
 * The probe peeks one throwaway ledger and reads one throwaway claim, both
 * under names nothing real uses, and reports each answer with its latency.
 *
 * The drill WRITES: under the rehearsal kind against a throwaway buyer it runs
 * the two lead race, the in_doubt race and a kill after reserve, the three
 * shapes the Workers suite proves, and records the p50 and p99 of every object
 * call. The p99 is what OBJECT_CALL_DEADLINE_MS is set from. It touches no
 * buyer and no Postgres row: the buyer call is a stub and the mirror is a no-op.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { withDeadline, type Timers } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import type { EntryKey, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../durable-objects/buyer-ledger'
import type { ClaimBody, ClaimResult } from '../durable-objects/lead-sale'
import { BuyerLedgerClient, LeadSaleClient, OBJECT_CALL_DEADLINE_MS } from './buyer-object-clients'
import { ClaimTally, runBuyerSaleAttempt, type AttemptResult, type AttemptStep, type LedgerApi, type SaleApi } from './buyer-sale-attempt'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { formatErr } from './format-error'
import { withJobRun, type JobRunEnding } from './job-run-record'

type Bindings = Pick<Env, 'BUYER_LEDGER' | 'LEAD_SALE'>

export interface ObjectProbe {
  ok: boolean
  ms: number
  error?: string
}

export interface BuyerObjectsHealth {
  ok: boolean
  probed_at: string
  ledger: ObjectProbe
  sale: ObjectProbe
}

export interface HealthOptions {
  clock?: () => number
  timers?: Timers
}

const PROBE_NAME = 'health-probe'

export async function buyerObjectsHealth(env: Bindings, opts: HealthOptions = {}): Promise<BuyerObjectsHealth> {
  const clock = opts.clock ?? (() => Date.now())
  const client = { timers: opts.timers }
  const ledger = new BuyerLedgerClient(env.BUYER_LEDGER, PROBE_NAME, client)
  const sale = new LeadSaleClient(env.LEAD_SALE, { kind: 'rehearsal', population: 'engine', lead_key: PROBE_NAME }, client)
  const probed_at = new Date(clock()).toISOString()
  // One after the other, so each latency is that object's alone (L699).
  const ledgerProbe = await probe(clock, () => ledger.peek('rehearsal'))
  const saleProbe = await probe(clock, () => sale.read())
  return { ok: ledgerProbe.ok && saleProbe.ok, probed_at, ledger: ledgerProbe, sale: saleProbe }
}

async function probe(clock: () => number, read: () => Promise<unknown>): Promise<ObjectProbe> {
  const started = clock()
  try {
    await read()
    return { ok: true, ms: clock() - started }
  } catch (err) {
    return { ok: false, ms: clock() - started, error: err instanceof Error ? err.message : 'non Error thrown' }
  }
}

// ── The drill ──────────────────────────────────────────────────────────────────

export interface DrillScenario {
  name: string
  ok: boolean
  detail?: string
}

export interface Percentiles {
  calls: number
  p50_ms: number
  p99_ms: number
  max_ms: number
}

export interface BuyerObjectsDrill {
  ok: boolean
  ran_at: string
  partner_id: string
  scenarios: DrillScenario[]
  latency: Record<string, Percentiles>
  /**
   * The claims the drill's own attempts found expired, and the in_doubt claims
   * they healed (#1643): the drill's line, reported beside the organic counts
   * on the node output and never summed into them (L528).
   */
  claim_events: { expired_in_flight: number; in_doubt_heals: number }
}

export interface DrillOptions {
  partnerId?: string
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  timers?: Timers
  /** How long the killed attempts hold their claim before it is in doubt. Short, so the drill is quick. */
  holdMs?: number
}

/** Nearest rank percentiles over the recorded call durations. */
export function percentiles(samples: number[]): Percentiles {
  if (samples.length === 0) throw new Error('no calls recorded')
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
  return { calls: sorted.length, p50_ms: rank(0.5), p99_ms: rank(0.99), max_ms: sorted[sorted.length - 1] }
}

export function summarizeDrill(scenarios: readonly DrillScenario[]): boolean {
  return scenarios.length > 0 && scenarios.every((s) => s.ok)
}

const DRILL_OUTCOME: SaleOutcomeRecord = { buyer_reference: 'drill', result_code: 'drill', http_status: 200, payout_cents: 100 }
const NO_LIMITS = { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }

/** Records the duration of every call on the wrapped API, by the client's op name. */
class Recorder {
  readonly samples = new Map<string, number[]>()
  constructor(private readonly clock: () => number) {}
  async time<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const started = this.clock()
    try {
      return await fn()
    } finally {
      const list = this.samples.get(op) ?? []
      list.push(this.clock() - started)
      this.samples.set(op, list)
    }
  }
  report(): Record<string, Percentiles> {
    const out: Record<string, Percentiles> = {}
    for (const [op, list] of this.samples) out[op] = percentiles(list)
    return out
  }
}

function measuredLedger(inner: BuyerLedgerClient, rec: Recorder): LedgerApi & { release: BuyerLedgerClient['release']; markMirrored: BuyerLedgerClient['markMirrored']; peek: BuyerLedgerClient['peek'] } {
  return {
    reserve: (body: ReserveBody): Promise<ReserveResult> => rec.time('buyer ledger reserve', () => inner.reserve(body)),
    commit: (key: EntryKey, outcome: SaleOutcomeRecord): Promise<LedgerEntry> => rec.time('buyer ledger commit', () => inner.commit(key, outcome)),
    release: (key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry> => rec.time('buyer ledger release', () => inner.release(key, status)),
    entry: (key: EntryKey) => rec.time('buyer ledger entry', () => inner.entry(key)),
    markMirrored: (keys: EntryKey[]) => rec.time('buyer ledger mark-mirrored', () => inner.markMirrored(keys)),
    peek: (kind) => rec.time('buyer ledger peek', () => inner.peek(kind)),
  }
}

function measuredSale(inner: LeadSaleClient, rec: Recorder): SaleApi {
  return {
    claim: (body: ClaimBody): Promise<ClaimResult> => rec.time('lead sale claim', () => inner.claim(body)),
    sold: (g, o) => rec.time('lead sale sold', () => inner.sold(g, o)),
    free: (g) => rec.time('lead sale free', () => inner.free(g)),
    heal: (g, o) => rec.time('lead sale heal', () => inner.heal(g, o)),
  }
}

export async function runBuyerObjectsDrill(env: Bindings, opts: DrillOptions = {}): Promise<BuyerObjectsDrill> {
  const clock = opts.clock ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const holdMs = opts.holdMs ?? 50
  const ran_at = new Date(clock()).toISOString()
  const partner_id = opts.partnerId ?? `${DRILL_PARTNER_PREFIX}${ran_at}`
  const run = `${partner_id}-${clock()}`
  const rec = new Recorder(clock)
  const clientOpts = { timers: opts.timers, deadlineMs: OBJECT_CALL_DEADLINE_MS }
  const ledger = measuredLedger(new BuyerLedgerClient(env.BUYER_LEDGER, partner_id, clientOpts), rec)
  const usedKeys: EntryKey[] = []
  const claims = new ClaimTally()

  const attempt = (leadKey: string, executionId: string, extra: { killAfter?: AttemptStep; buyerTimeoutMs?: number; limits?: ReserveBody['limits']; buyerCalls: { n: number } }): Promise<AttemptResult> => {
    const key: EntryKey = { lead_key: leadKey, population: 'engine', kind: 'rehearsal' }
    if (!usedKeys.some((k) => k.lead_key === leadKey)) usedKeys.push(key)
    const sale = measuredSale(new LeadSaleClient(env.LEAD_SALE, key, clientOpts), rec)
    return runBuyerSaleAttempt(
      { partner_id, execution_id: executionId, lead_key: leadKey, population: 'engine', kind: 'rehearsal', payout_cents: 100, limits: extra.limits ?? NO_LIMITS },
      {
        sale,
        ledger,
        callBuyer: () => {
          extra.buyerCalls.n += 1
          return Promise.resolve({ outcome: 'accepted' as const, record: DRILL_OUTCOME })
        },
        mirror: () => Promise.resolve(),
        clock,
        sleep,
        buyerTimeoutMs: extra.buyerTimeoutMs ?? 20_000,
        waitIntervalMs: 20,
        onStep: (step) => {
          if (extra.killAfter === step) throw new Error(`killed after ${step}`)
        },
        onClaimEvent: claims.observe,
      }
    )
  }

  /** One slot left, whatever earlier drills left in this hour. */
  const oneSlot = async (): Promise<ReserveBody['limits']> => {
    const counts = await ledger.peek('rehearsal')
    return { ...NO_LIMITS, hourly_lead_cap: counts.hour_leads + 1 }
  }

  const scenarios: DrillScenario[] = []
  const record = async (name: string, body: () => Promise<string | null>) => {
    try {
      const detail = await body()
      scenarios.push(detail === null ? { name, ok: true } : { name, ok: false, detail })
    } catch (err) {
      scenarios.push({ name, ok: false, detail: err instanceof Error ? err.message : 'non Error thrown' })
    }
  }

  await record('two leads race for one slot', async () => {
    const limits = await oneSlot()
    const calls = { n: 0 }
    const [a, b] = await Promise.all([attempt(`${run}-race-a`, `${run}-e1`, { limits, buyerCalls: calls }), attempt(`${run}-race-b`, `${run}-e2`, { limits, buyerCalls: calls })])
    const sold = [a, b].filter((r) => r.result === 'sold')
    const capped = [a, b].filter((r) => r.result === 'no_sale' && r.reason === 'hourly_lead_cap')
    if (sold.length !== 1 || capped.length !== 1) return `expected one sold and one hourly_lead_cap, got ${describe(a)} and ${describe(b)}`
    if (calls.n !== 1) return `expected one buyer call, got ${calls.n}`
    return null
  })

  await record('two executions race on an in_doubt claim', async () => {
    const lead = `${run}-doubt`
    const killed = { n: 0 }
    await attempt(lead, `${run}-e0`, { killAfter: 'claimed', buyerTimeoutMs: holdMs, buyerCalls: killed }).catch(() => undefined)
    await sleep(holdMs + 10)
    const limits = await oneSlot()
    const calls = { n: 0 }
    const [a, b] = await Promise.all([attempt(lead, `${run}-e1`, { limits, buyerCalls: calls }), attempt(lead, `${run}-e2`, { limits, buyerCalls: calls })])
    const fresh = [a, b].filter((r) => r.result === 'sold' && !r.replay)
    const replay = [a, b].filter((r) => r.result === 'sold' && r.replay)
    if (fresh.length !== 1 || replay.length !== 1) return `expected one sale and one replay, got ${describe(a)} and ${describe(b)}`
    if (calls.n !== 1) return `expected one buyer call, got ${calls.n}`
    return null
  })

  await record('an attempt killed after its reserve', async () => {
    const lead = `${run}-reserve`
    const key: EntryKey = { lead_key: lead, population: 'engine', kind: 'rehearsal' }
    const killed = { n: 0 }
    await attempt(lead, `${run}-e0`, { killAfter: 'reserved', buyerTimeoutMs: holdMs, buyerCalls: killed }).catch(() => undefined)
    await sleep(holdMs + 10)
    const calls = { n: 0 }
    const next = await attempt(lead, `${run}-e1`, { buyerCalls: calls })
    if (next.result !== 'no_sale' || next.reason !== 'outcome_unknown') return `expected outcome_unknown while the entry is pending, got ${describe(next)}`
    if (calls.n !== 0) return `expected no buyer call, got ${calls.n}`
    // A person resolves it: the pending entry is released and the slot frees.
    const released = await ledger.release(key, 'released')
    if (released.status !== 'released') return `expected released, got ${released.status}`
    const callsAfter = { n: 0 }
    const after = await attempt(lead, `${run}-e2`, { buyerCalls: callsAfter })
    if (after.result !== 'no_sale' || after.reason !== 'buyer_error' || after.detail !== 'earlier attempt released') return `expected the earlier release to be reported, got ${describe(after)}`
    if (callsAfter.n !== 0) return `expected no buyer call after the release, got ${callsAfter.n}`
    return null
  })

  await record('an attempt killed after its commit is healed from the ledger', async () => {
    const lead = `${run}-commit`
    const killed = { n: 0 }
    await attempt(lead, `${run}-e0`, { killAfter: 'committed', buyerTimeoutMs: holdMs, buyerCalls: killed }).catch(() => undefined)
    await sleep(holdMs + 10)
    const healsBefore = claims.inDoubtHeals
    const calls = { n: 0 }
    const next = await attempt(lead, `${run}-e1`, { buyerCalls: calls })
    if (next.result !== 'sold' || !next.replay) return `expected the committed sale to be replayed, got ${describe(next)}`
    if (claims.inDoubtHeals !== healsBefore + 1) return `expected one heal, got ${claims.inDoubtHeals - healsBefore}`
    if (calls.n !== 0) return `expected no buyer call, got ${calls.n}`
    return null
  })

  // The drill's entries are its own: mark them mirrored so retention can prune them (L5).
  await ledger.markMirrored(usedKeys).catch(() => undefined)

  return {
    ok: summarizeDrill(scenarios),
    ran_at,
    partner_id,
    scenarios,
    latency: rec.report(),
    claim_events: { expired_in_flight: claims.expiredInFlight, in_doubt_heals: claims.inDoubtHeals },
  }
}

// ── The daily run (#1643) ──────────────────────────────────────────────────────

/** The job_runs and alerter name. */
export const BUYER_OBJECTS_DRILL_JOB = 'buyer-objects-drill'
/** The whole drill, bounded as the admin route bounds it (L110). */
export const SCHEDULED_DRILL_DEADLINE_MS = 30_000
/** Every drill buyer id starts with this, so its ledger is never a real buyer's. */
export const DRILL_PARTNER_PREFIX = 'drill-'

export const BUYER_OBJECTS_DRILL_REMEDY: AlertRemedy = {
  consequence:
    'The daily drill of the lead sale claim and the buyer ledger failed. It runs against a throwaway drill buyer under the ' +
    'rehearsal kind, so no lead and no real buyer count was touched, but the objects the buyer_select node sells through did ' +
    'not behave the way the Workers suite proves they do. Each line names the scenario and what it saw:',
  fixHint:
    'Run POST /api/admin/buyer-objects/drill to see the full report, then read the latest buyer-objects-drill row in job_runs ' +
    'for the latency of every object call. A scenario that fails on a deploy is the change in that deploy; one that did not ' +
    'finish is an object not answering, so check GET /api/admin/buyer-objects/health.',
  headlineVerb: 'failed a scenario',
  itemNoun: { one: 'failed scenario', many: 'failed scenarios' },
}

export interface ScheduledDrillDeps {
  supabase: SupabaseClient
  drill: () => Promise<BuyerObjectsDrill>
  /** The shared alerter: a non empty list pages, an empty one clears. */
  notify: (lines: string[]) => Promise<void>
  log: (line: string) => void
  timers?: Timers
}

type DrillRun = { kind: 'report'; report: BuyerObjectsDrill } | { kind: 'did_not_finish'; detail: string }

export interface ScheduledDrillResult {
  run: DrillRun
  /** One per failed scenario, or one saying the drill did not finish; empty on a pass. */
  lines: string[]
}

/**
 * Runs the drill once under a job_runs row and pages on a failed scenario
 * (#1643). The row's summary carries each scenario, the latency and the
 * drill's own claim events. The work never throws: a drill that threw or ran
 * past the deadline is an outcome of its own, recorded and paged, never a pass.
 */
export async function runScheduledBuyerObjectsDrill(deps: ScheduledDrillDeps): Promise<ScheduledDrillResult> {
  const run = await withJobRun<DrillRun>(
    deps.supabase,
    BUYER_OBJECTS_DRILL_JOB,
    async () => {
      try {
        return { kind: 'report', report: await withDeadline(deps.drill(), SCHEDULED_DRILL_DEADLINE_MS, 'buyer objects drill', deps.timers) }
      } catch (err) {
        return { kind: 'did_not_finish', detail: err instanceof Error ? err.message : formatErr(err) }
      }
    },
    drillEnding,
  )
  const lines = failureLines(run)
  deps.log(`[${BUYER_OBJECTS_DRILL_JOB}] ${lines.length === 0 ? 'passed' : `failed: ${lines.join(' | ')}`}`)
  await deps.notify(lines)
  return { run, lines }
}

function failureLines(run: DrillRun): string[] {
  if (run.kind === 'did_not_finish') return [`the drill did not finish: ${run.detail}`]
  const lines = run.report.scenarios.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail ?? 'failed with no detail'}`)
  if (!run.report.partner_id.startsWith(DRILL_PARTNER_PREFIX)) {
    lines.push(`the drill ran against ${run.report.partner_id}, which is not a throwaway ${DRILL_PARTNER_PREFIX} buyer`)
  }
  if (run.report.scenarios.length === 0) lines.push('the drill ran no scenarios')
  return lines
}

function drillEnding(run: DrillRun): JobRunEnding {
  if (run.kind === 'did_not_finish') return { outcome: 'did_not_finish', detail: run.detail }
  const failed = failureLines(run)
  const r = run.report
  return {
    outcome: failed.length === 0 ? 'passed' : 'scenario_failed',
    detail: failed.length === 0 ? `${r.scenarios.length} scenarios passed` : failed.join(' | '),
    summary: {
      ran_at: r.ran_at,
      partner_id: r.partner_id,
      scenarios: r.scenarios,
      latency: r.latency,
      drill_claim_events: r.claim_events,
    },
  }
}

/** What the scheduled handler calls. */
export function runScheduledBuyerObjectsDrillForEnv(supabase: SupabaseClient, env: Bindings & Pick<Env, 'IDEMPOTENCY'>): Promise<ScheduledDrillResult> {
  return runScheduledBuyerObjectsDrill({
    supabase,
    drill: () => runBuyerObjectsDrill(env),
    notify: (lines) => notifyExportFailure(supabase, BUYER_OBJECTS_DRILL_JOB, lines, env.IDEMPOTENCY, BUYER_OBJECTS_DRILL_REMEDY),
    log: (line) => (line.includes('failed') ? console.error(line) : console.log(line)),
  })
}

function describe(r: AttemptResult): string {
  return r.result === 'sold' ? `sold${r.replay ? ' (replay)' : ''}` : `no_sale ${r.reason}${r.detail ? ` (${r.detail})` : ''}`
}
