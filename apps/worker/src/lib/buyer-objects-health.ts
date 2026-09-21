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
import type { Timers } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import type { EntryKey, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../durable-objects/buyer-ledger'
import type { ClaimBody, ClaimResult } from '../durable-objects/lead-sale'
import { BuyerLedgerClient, LeadSaleClient, OBJECT_CALL_DEADLINE_MS } from './buyer-object-clients'
import { runBuyerSaleAttempt, type AttemptResult, type AttemptStep, type LedgerApi, type SaleApi } from './buyer-sale-attempt'

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
  const partner_id = opts.partnerId ?? `drill-${ran_at}`
  const run = `${partner_id}-${clock()}`
  const rec = new Recorder(clock)
  const clientOpts = { timers: opts.timers, deadlineMs: OBJECT_CALL_DEADLINE_MS }
  const ledger = measuredLedger(new BuyerLedgerClient(env.BUYER_LEDGER, partner_id, clientOpts), rec)
  const usedKeys: EntryKey[] = []

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

  // The drill's entries are its own: mark them mirrored so retention can prune them (L5).
  await ledger.markMirrored(usedKeys).catch(() => undefined)

  return { ok: summarizeDrill(scenarios), ran_at, partner_id, scenarios, latency: rec.report() }
}

function describe(r: AttemptResult): string {
  return r.result === 'sold' ? `sold${r.replay ? ' (replay)' : ''}` : `no_sale ${r.reason}${r.detail ? ` (${r.detail})` : ''}`
}
