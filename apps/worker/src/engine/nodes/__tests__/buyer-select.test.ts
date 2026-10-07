/**
 * The buyer_select executor (#1411 PR B), unit level with every dependency
 * injected: the profile snapshot, the two objects, the buyer call, the breaker,
 * the mirror, the bid logger and the clock. What the walker does with the
 * result (step rows, routing) is covered in engine/__tests__/buyer-select-walk.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { DeadlineError } from '@bidspoke/buyer-profile'
import { OBJECT_CALL_DEADLINE_MS, type ClientOptions } from '../../../lib/buyer-object-clients'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'
import type { BuyerProfilesSnapshot, LoadedBuyer } from '../../../lib/buyer-profile-loader'
import type { PartnerCallResult } from '../../../lib/post-to-partner'
import type { ClaimBody, ClaimResult } from '../../../durable-objects/lead-sale'
import type { EntryKey, EntryResult, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../../../durable-objects/buyer-ledger'
import type { LedgerApi, SaleApi } from '../../../lib/buyer-sale-attempt'
import { canaryBucket } from '@bidspoke/buyer-profile'
import { summariseParityDay } from '../../../lib/buyer-select-parity'
import { ENGINE_TRIPOINT_SALE_PAYLOAD } from '../buyer-select-payload'
import { createLeadSupabaseClient, noteLeadWriteUnanswered } from '../../../lib/lead-read-budget'
import { BUYER_CALL_TIMEOUT_MS, BUYER_SALE_MIRROR_DEADLINE_MS, BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS, BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS, MEASURED_OBJECT_CALL_P99_MS, executeBuyerSelectNode, productionDeps, type BuyerSelectDeps, type BuyerSelectOutput } from '../buyer-select'

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** 2027-09-20 15:30 UTC: Monday 11:30 in New York. */
const NOW = Date.UTC(2027, 8, 20, 15, 30)
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensMinute: 0, closesMinute: 1440 }))

const TRIPOINT_ACCEPT = [{ field: 'ok', equals: true }, { field: 'data.createLead.resultCode', in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] }]
const TRIPOINT_DECLINE = [
  { field: 'data.createLead.resultCode', in: [1003, 1004, 1020] },
  { field: 'details[].message', any_item_word_prefix_ci: 'invalid' },
]

function buyer(partnerId: string, slug: string, priority: number, over: Partial<LoadedBuyer['profile']> = {}): LoadedBuyer {
  return {
    partner: {
      id: partnerId, slug, is_active: true, api_endpoint: `https://${slug}.example/leads`, cf_secret_key: null,
      outbound_field_mapping: null, extra_extraction: { buyer_reference: 'data.createLead.id', result_code: 'data.createLead.resultCode' }, accept_signals: TRIPOINT_ACCEPT,
      response_classification: { rejection_signals: TRIPOINT_DECLINE as never },
      // The winner's own facts (#1416): a name, a landing page and a routing code per buyer, so a
      // second buyer's sale is visibly not Tripoint's.
      name: slug === 'tripoint' ? 'Tripoint' : slug.charAt(0).toUpperCase() + slug.slice(1),
      click_url: `https://${slug}.example/apply`,
      external_routing_code: slug === 'tripoint' ? 2 : 7,
      duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }],
      circuit_enabled: true, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
    },
    profile: {
      partnerId, soldOn: 'offer', isEnabled: true, priority, allowedStates: ['TX'], debtMin: 15000, debtMax: null, loanAmountMin: null,
      hourlyLeadCap: null, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: null,
      windows: ALL_WEEK, blackoutDates: [], tiers: [{ population: 'engine', debtFrom: 12500, debtTo: null, multiplier: 0.0012 }],
      ...over,
    },
    version: 1,
    updated_at: '2027-09-20T10:00:00.000Z',
  }
}

const snapshot = (...buyers: LoadedBuyer[]): BuyerProfilesSnapshot => ({ org_id: 'org-1', loaded_at: new Date(NOW).toISOString(), content_hash: 'test', served_from: 'database', buyers })

const CONFIG = {
  population: 'engine',
  mode: 'live',
  lead_key: '{{trigger.payload.leadUuid}}',
  sell_off_when: '{{steps.prospect_trades.output.body.sellOff}}',
  bid_when_positive: '{{steps.prospect_trades.output.body.engineBid}}',
  state: '{{trigger.payload.personalInformation.state}}',
  debt: '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}',
  sale_payload: ENGINE_TRIPOINT_SALE_PAYLOAD,
}

function node(config: Record<string, unknown> = {}): NodeDefinition {
  return { id: 'bs-1', namespace: 'sell_off', type: 'buyer_select', config: { ...CONFIG, retries: 2, ...config } }
}

function ctx(over: { sellOff?: unknown; engineBid?: unknown; leadUuid?: unknown; env?: Record<string, string>; isTest?: boolean; shadow?: 'dry_run' } = {}): ExecutionContext {
  return {
    trigger: {
      payload: { leadUuid: over.leadUuid === undefined ? 'lead-1' : over.leadUuid, personalInformation: { firstName: 'J', state: 'TX', ssn: '123-45-6789' } },
      source: 'engine', workflow_id: 'wf-engine', trace_id: 'trace-1', org_id: 'org-1', execution_id: 'exec-1', sighting_id: 'sighting-1',
    },
    steps: {
      prospect_trades: { status: 'completed', output: { body: { sellOff: over.sellOff ?? true, engineBid: over.engineBid ?? 0.65, tradeCalculations: { engineDebt: 18250, enrollableDebt: 22100 } } } },
      create_prospect: { status: 'completed', output: { body: { id: '003SF1' } } },
    },
    env: over.env ?? {},
    execution: { workflow_id: 'wf-engine', trace_id: 'trace-1', execution_id: 'exec-1' },
    isTest: over.isTest,
    shadow_mode: over.shadow,
  }
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** The lead sale and buyer ledger calls a test can give a duration to (#1804). */
type ObjectOp = 'claim' | 'sold' | 'free' | 'commit' | 'release'

class FakeSale implements SaleApi {
  state: 'free' | 'in_flight' | 'sold' = 'free'
  generation = 0
  outcome: SaleOutcomeRecord | null = null
  calls: string[] = []
  /** `spend` lets a test give each call a duration on the harness clock (#1804). */
  constructor(readonly key: { kind: string; population: string; lead_key: string }, private readonly spend: (op: ObjectOp) => void = () => {}) {}
  async claim(body: ClaimBody): Promise<ClaimResult> {
    this.calls.push(`claim:${body.execution_id}`)
    this.spend('claim')
    if (this.state === 'sold') return { state: 'sold', partner_id: 'p', outcome: this.outcome!, generation: this.generation }
    this.state = 'in_flight'
    this.generation += 1
    return { state: 'claimed', generation: this.generation }
  }
  async sold(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    this.calls.push(`sold:${generation}`)
    this.spend('sold')
    this.state = 'sold'
    this.outcome = outcome
    return ++this.generation
  }
  async free(generation: number): Promise<number> {
    this.calls.push(`free:${generation}`)
    this.spend('free')
    this.state = 'free'
    return ++this.generation
  }
  async heal(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    this.calls.push(`heal:${generation}`)
    this.state = 'sold'
    this.outcome = outcome
    return ++this.generation
  }
}

class FakeLedger implements LedgerApi {
  entries = new Map<string, LedgerEntry>()
  calls: string[] = []
  constructor(readonly partnerId: string, private readonly refuse: ReserveResult | Error | null = null, private readonly spend: (op: ObjectOp) => void = () => {}) {}
  private k(key: EntryKey) { return `${key.lead_key}|${key.population}|${key.kind}` }
  async reserve(body: ReserveBody): Promise<ReserveResult> {
    this.calls.push(`reserve:${body.kind}:${body.payout_cents}`)
    if (this.refuse instanceof Error) throw this.refuse
    if (this.refuse) return this.refuse
    const existing = this.entries.get(this.k(body))
    const counts = { hour_leads: 1, day_leads: 1, hour_spend_cents: body.payout_cents, day_spend_cents: body.payout_cents, et_day: '2027-09-20', hour_bucket: 0 }
    if (existing) return { reserved: true, repeat: true, entry: existing, counts }
    const entry: LedgerEntry = { lead_key: body.lead_key, population: body.population, kind: body.kind, payout_cents: body.payout_cents, status: 'reserved', et_day: '2027-09-20', hour_bucket: 0, reserved_at: NOW, resolved_at: null, mirrored: false, execution_id: body.execution_id, outcome: null, resolution_source: null, resolved_by: null }
    this.entries.set(this.k(body), entry)
    return { reserved: true, repeat: false, entry, counts }
  }
  async commit(key: EntryKey, outcome: SaleOutcomeRecord): Promise<LedgerEntry> {
    this.calls.push('commit')
    this.spend('commit')
    const e = this.entries.get(this.k(key))!
    const next = { ...e, status: 'accepted' as const, outcome, resolved_at: NOW }
    this.entries.set(this.k(key), next)
    return next
  }
  async release(key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry> {
    this.calls.push(`release:${status}`)
    this.spend('release')
    const e = this.entries.get(this.k(key))!
    const next = { ...e, status, resolved_at: NOW }
    this.entries.set(this.k(key), next)
    return next
  }
  async entry(key: EntryKey): Promise<EntryResult> {
    const e = this.entries.get(this.k(key))
    return e ? { found: true, entry: e } : { found: false }
  }
}

type BuyerAnswer = PartnerCallResult | Error

const ACCEPTED: PartnerCallResult = { status: 200, text: '', json: { ok: true, data: { createLead: { id: 'L-1', resultCode: 1000 } } }, isHtml: false, headers: {} }
const DUPLICATE: PartnerCallResult = { status: 200, text: '', json: { ok: true, data: { createLead: { id: null, resultCode: 1020 } } }, isHtml: false, headers: {} }
const INVALID_502: PartnerCallResult = { status: 502, text: '', json: { ok: false, details: [{ message: 'Invalid phone number' }] }, isHtml: false, headers: {} }
const BARE_504: PartnerCallResult = { status: 504, text: 'Gateway Timeout', json: null, isHtml: false, headers: {} }
const UNMATCHED_200: PartnerCallResult = { status: 200, text: '', json: { ok: true, data: {} }, isHtml: false, headers: {} }

interface Harness {
  deps: BuyerSelectDeps
  sales: FakeSale[]
  ledgers: Map<string, FakeLedger>
  buyerCalls: Array<{ slug: string; body: unknown }>
  mirrored: unknown[]
  /** Copies started that never answer (mirrorHangs). */
  mirrorsHanging: number
  /** Writes the node said did not answer in time (#1849). */
  unanswered: string[]
  bidRows: Array<Record<string, unknown>>
  breakerCalls: string[]
  logs: Array<Record<string, unknown>>
  clockMs: number
  /** The options each ledger client was built with, in order; undefined when the node passed none. */
  ledgerClientOpts: Array<ClientOptions | undefined>
  /** Work the node handed to the background; a test awaits it before asserting what landed. */
  background: Promise<void>[]
}

function harness(opts: {
  profiles?: BuyerProfilesSnapshot | Error
  answers?: Record<string, BuyerAnswer[]>
  refuse?: Record<string, ReserveResult | Error>
  breakerOpen?: string[]
  /** A breaker whose check throws, by slug: an unreadable breaker, not an open one. */
  breakerError?: Record<string, Error>
  mirrorError?: Error
  /** A buyer_sales copy that never answers: the rpc hangs (#1849). */
  mirrorHangs?: boolean
  ledgerError?: Error
  advanceOnBuyerCall?: number
  /** Time the breaker takes to record the call's result, after the buyer answered (#1804). */
  advanceOnBreakerRecord?: number
  /** Time the buyer_sales copy takes (#1804). */
  advanceOnMirror?: number
  /** Time each lead sale or buyer ledger call takes, by call (#1804). Reserve has its own option, slowReserveMs. */
  advanceOnObject?: Partial<Record<ObjectOp, number>>
  /** A reserve that takes this long: past the deadline the client was given, it throws the client's DeadlineError at that deadline. */
  slowReserveMs?: number
} = {}): Harness {
  const h: Harness = { sales: [], ledgers: new Map(), buyerCalls: [], mirrored: [], mirrorsHanging: 0, unanswered: [], bidRows: [], breakerCalls: [], logs: [], clockMs: NOW, ledgerClientOpts: [], background: [], deps: undefined as unknown as BuyerSelectDeps }
  const answers = { ...(opts.answers ?? {}) }
  const spend = (op: ObjectOp) => { h.clockMs += opts.advanceOnObject?.[op] ?? 0 }
  h.deps = {
    loadProfiles: async () => {
      if (opts.profiles instanceof Error) throw opts.profiles
      return opts.profiles ?? snapshot(buyer('p-1', 'tripoint', 1))
    },
    saleClient: (key) => {
      const s = new FakeSale(key, spend)
      h.sales.push(s)
      return s
    },
    background: (work) => { h.background.push(work) },
    ledgerClient: (partnerId, clientOpts) => {
      h.ledgerClientOpts.push(clientOpts)
      const ledgerError = opts.ledgerError
      if (ledgerError) {
        const reject = () => Promise.reject(ledgerError)
        return { reserve: reject, commit: reject, release: reject, entry: reject }
      }
      let l = h.ledgers.get(partnerId)
      if (!l) {
        l = new FakeLedger(partnerId, opts.refuse?.[partnerId] ?? null, spend)
        h.ledgers.set(partnerId, l)
      }
      const slow = opts.slowReserveMs
      if (!slow) return l
      const ledger = l
      return {
        reserve: async (body) => {
          const d = clientOpts?.deadlineMs
          const limit = typeof d === 'function' ? d('buyer ledger reserve') : d
          if (limit !== undefined && slow > limit) {
            h.clockMs += limit
            throw new DeadlineError('ledger reserve', limit)
          }
          h.clockMs += slow
          return ledger.reserve(body)
        },
        commit: (key, outcome) => ledger.commit(key, outcome),
        release: (key, status) => ledger.release(key, status),
        entry: (key) => ledger.entry(key),
      }
    },
    callBuyer: async (target, body) => {
      h.buyerCalls.push({ slug: target.slug, body })
      if (opts.advanceOnBuyerCall) h.clockMs += opts.advanceOnBuyerCall
      const queue = answers[target.slug] ?? [ACCEPTED]
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      if (next instanceof Error) throw next
      return next
    },
    breaker: (slug) => ({
      check: async () => {
        h.breakerCalls.push(`check:${slug}`)
        const unreadable = opts.breakerError?.[slug]
        if (unreadable) throw unreadable
        return { allowed: !(opts.breakerOpen ?? []).includes(slug), state: (opts.breakerOpen ?? []).includes(slug) ? 'open' : 'closed' }
      },
      recordSuccess: async () => { h.breakerCalls.push(`success:${slug}`); h.clockMs += opts.advanceOnBreakerRecord ?? 0 },
      recordError: async () => { h.breakerCalls.push(`error:${slug}`); h.clockMs += opts.advanceOnBreakerRecord ?? 0 },
      releaseProbe: async () => { h.breakerCalls.push(`release:${slug}`) },
    }),
    mirror: async (row) => {
      h.clockMs += opts.advanceOnMirror ?? 0
      if (opts.mirrorHangs) {
        h.mirrorsHanging++
        return new Promise<void>(() => {})
      }
      if (opts.mirrorError) throw opts.mirrorError
      h.mirrored.push(row)
    },
    logBid: (row) => { h.bidRows.push(row as unknown as Record<string, unknown>) },
    clock: () => h.clockMs,
    sleep: async (ms) => { h.clockMs += ms },
    log: (event) => { h.logs.push(event) },
    writeUnanswered: (what) => { h.unanswered.push(what) },
    localDev: false,
  }
  return h
}

const env = {} as Env
const run = (h: Harness, c: ExecutionContext = ctx(), n: NodeDefinition = node()) => executeBuyerSelectNode(n, c, env, h.deps)
const out = (r: Awaited<ReturnType<typeof executeBuyerSelectNode>>): BuyerSelectOutput => r.output

// ── Applicability ─────────────────────────────────────────────────────────────

describe('applicability, before any object or database call', () => {
  it('a lead that is not a sell off routes not_applicable and touches nothing', async () => {
    const h = harness()
    const r = await run(h, ctx({ sellOff: false }))
    expect(out(r)).toMatchObject({ _route: 'not_applicable', reason: 'sell_off_false', sale: { skipped: true, accepted: false } })
    expect(h.sales).toEqual([])
    expect(h.buyerCalls).toEqual([])
    expect(r.attempts).toEqual([])
  })

  it('a sell off lead with a zero bid routes not_applicable, the incumbent\'s second bail (L620)', async () => {
    const h = harness()
    const r = await run(h, ctx({ engineBid: 0 }))
    expect(out(r)).toMatchObject({ _route: 'not_applicable', reason: 'bid_not_positive' })
    expect(h.sales).toEqual([])
  })

  it('a non boolean sell off flag is treated as false and logged by name', async () => {
    const h = harness()
    const r = await run(h, ctx({ sellOff: 'yes' }))
    expect(out(r)).toMatchObject({ _route: 'not_applicable', reason: 'sell_off_false' })
    expect(h.logs.some((l) => l.event === 'sell_off_flag_not_boolean')).toBe(true)
  })

  it('a sell off flag that cannot be resolved routes deferred in decide only, so the incumbent decides for itself', async () => {
    const h = harness()
    const c = ctx()
    delete c.steps.prospect_trades
    const r = await run(h, c, node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'sell_off_unresolved' })
    expect(h.sales).toEqual([])
  })
})

// ── Live sales ────────────────────────────────────────────────────────────────

/**
 * #1416: the sale carries the winner's own facts, so the response and patch
 * scripts derive the click URL, the partner name, the routing code and the
 * Success, Duplicate and Fail class from it, never from a Tripoint literal.
 */
describe("the sale carries the winner's own facts (#1416)", () => {
  it('a sold lead names the buyer, where it lands, its routing code and Success', async () => {
    const r = await run(harness())
    expect(out(r).sale).toEqual({
      skipped: false, accepted: true, buyer_reference: 'L-1', result_code: '1000', partner_slug: 'tripoint',
      partner_name: 'Tripoint', click_url: 'https://tripoint.example/apply', routing_code: 2, response_class: 'Success',
    })
  })

  it('a decline matching the buyer duplicate rules is Duplicate, with the code and the declining buyer named, and no landing page', async () => {
    const r = await run(harness({ answers: { tripoint: [DUPLICATE] } }))
    expect(out(r)).toMatchObject({ _route: 'no_sale', reason: 'declined_by_buyer' })
    expect(out(r).sale).toEqual({
      skipped: false, accepted: false, buyer_reference: null, result_code: '1020', partner_slug: 'tripoint',
      partner_name: 'Tripoint', click_url: null, routing_code: null, response_class: 'Duplicate',
    })
  })

  it('a decline matching no duplicate rule is Fail (the invalid 502 shape)', async () => {
    const r = await run(harness({ answers: { tripoint: [INVALID_502] } }))
    expect(out(r).sale).toMatchObject({ accepted: false, partner_slug: 'tripoint', response_class: 'Fail', result_code: null })
  })

  it('a second buyer sells with ITS name, landing page and routing code after the first declined', async () => {
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), answers: { tripoint: [DUPLICATE], liberty: [ACCEPTED] } })
    const r = await run(h)
    expect(out(r).sale).toEqual({
      skipped: false, accepted: true, buyer_reference: 'L-1', result_code: '1000', partner_slug: 'liberty',
      partner_name: 'Liberty', click_url: 'https://liberty.example/apply', routing_code: 7, response_class: 'Success',
    })
  })

  it('a lead not for sale carries a skipped sale with every winner fact null', async () => {
    const r = await run(harness(), ctx({ sellOff: false }))
    expect(out(r).sale).toEqual({
      skipped: true, accepted: false, buyer_reference: null, result_code: null, partner_slug: null,
      partner_name: null, click_url: null, routing_code: null, response_class: null,
    })
  })

  it('a rehearsal sale carries the same facts, so the parity report and the scripts read one shape', async () => {
    const r = await run(harness(), ctx(), node({ mode: 'decide_only' }))
    expect(out(r).sale).toMatchObject({ accepted: true, partner_slug: 'tripoint', partner_name: 'Tripoint', click_url: 'https://tripoint.example/apply', routing_code: 2, response_class: 'Success' })
  })
})

describe('live mode', () => {
  it('sells to the eligible buyer: claim, reserve, call, commit, mark sold, mirror, one bid row, breaker success', async () => {
    const h = harness()
    const r = await run(h)
    expect(out(r)).toMatchObject({
      _route: 'sold',
      mode_effective: 'live',
      sale: { skipped: false, accepted: true, buyer_reference: 'L-1', result_code: '1000', partner_slug: 'tripoint' },
    })
    expect(h.buyerCalls).toHaveLength(1)
    expect(h.buyerCalls[0].body).toMatchObject({ unsecuredDebt: 18250, pennieLeadId: '003SF1', executionId: 'trace-1', personalInformation: { ssn: '123456789' } })
    expect(h.sales[0].key).toEqual({ kind: 'live', population: 'engine', lead_key: 'lead-1' })
    expect(h.sales[0].state).toBe('sold')
    expect(h.ledgers.get('p-1')!.calls).toEqual(['reserve:live:2190', 'commit'])
    expect(h.mirrored).toHaveLength(1)
    expect(h.bidRows).toHaveLength(1)
    expect(h.bidRows[0]).toMatchObject({ partner_slug: 'tripoint', classification: 'accept', http_status: 200, bid_cents: null })
    expect(h.breakerCalls).toEqual(['check:tripoint', 'success:tripoint'])
    expect(r.attempts).toHaveLength(1)
    expect(r.attempts[0]).toMatchObject({ partner_slug: 'tripoint', namespace: 'sell_off.tripoint', status: 'completed' })
    expect(out(r).considered).toEqual([expect.objectContaining({ partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: 'sold' })])
    expect(r.failure).toBeUndefined()
  })

  it('a definite decline falls through to the next buyer in rank order, 1 before 2, and both leave a bid row', async () => {
    const h = harness({ profiles: snapshot(buyer('p-2', 'liberty', 2), buyer('p-1', 'tripoint', 1)), answers: { tripoint: [DUPLICATE], liberty: [ACCEPTED] } })
    const r = await run(h)
    expect(h.buyerCalls.map((c) => c.slug)).toEqual(['tripoint', 'liberty'])
    expect(out(r)).toMatchObject({ _route: 'sold', sale: { partner_slug: 'liberty' } })
    expect(out(r).considered.map((c) => [c.partner, c.outcome])).toEqual([['tripoint', 'declined_by_buyer'], ['liberty', 'sold']])
    expect(h.bidRows.map((b) => b.classification)).toEqual(['decline', 'accept'])
    expect(r.attempts).toHaveLength(2)
  })

  it('the two 502 shapes are declines: the lead moves on and nothing is held', async () => {
    const h = harness({ answers: { tripoint: [INVALID_502] } })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'no_sale', reason: 'declined_by_buyer', sale: { skipped: false, accepted: false } })
    expect(h.ledgers.get('p-1')!.calls).toEqual(['reserve:live:2190', 'release:declined'])
    expect(h.sales[0].state).toBe('free')
  })

  it('a bare 504 stops the cascade, fails the step, and holds the reservation and the claim', async () => {
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), answers: { tripoint: [BARE_504] } })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'transient' })
    expect(r.failure?.message).toMatch(/outcome_unknown/)
    expect(h.buyerCalls.map((c) => c.slug)).toEqual(['tripoint'])
    expect(h.ledgers.get('p-1')!.entries.values().next().value?.status).toBe('reserved')
    expect(h.sales[0].state).toBe('in_flight')
    expect(out(r)._route).toBe('no_sale')
  })

  it('a timeout on the buyer call is the same: cascade stopped, step failed, everything held', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), answers: { tripoint: [abort] } })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'transient' })
    expect(h.buyerCalls).toHaveLength(1)
    expect(h.sales[0].state).toBe('in_flight')
  })

  it('a 200 matching neither rule stops the cascade, routes no_sale, holds both, and does not fail the step', async () => {
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), answers: { tripoint: [UNMATCHED_200] } })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'no_sale', reason: 'outcome_unknown' })
    expect(r.failure).toBeUndefined()
    expect(h.buyerCalls).toHaveLength(1)
    expect(h.sales[0].state).toBe('in_flight')
  })

  it('no eligible buyer is no_sale with the reasons per buyer, and nobody is called', async () => {
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1, { allowedStates: ['FL'] }), buyer('p-2', 'liberty', 2, { debtMin: 50000 })) })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'no_sale', reason: 'no_eligible_buyer' })
    expect(out(r).considered.map((c) => [c.partner, c.reason])).toEqual([['tripoint', 'state_not_allowed'], ['liberty', 'debt_below_min']])
    expect(h.buyerCalls).toEqual([])
    expect(h.sales).toEqual([])
  })

  // #1541, #1543: a click sold buyer is sold by buyer_click_check and the click
  // workflow, never by this node. It is left out of the considered list rather
  // than shown as "No pricing for this lead source", which was false: it has no
  // pricing because it is quoted at the Engine bid, and this node never offers it.
  it('an enabled click sold buyer is never sold and never listed as considered: nobody reserves or calls it', async () => {
    const h = harness({ profiles: snapshot(buyer('p-9', 'liberty', 1, { soldOn: 'click', priority: null, tiers: [] }), buyer('p-1', 'tripoint', 2)) })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'sold', sale: { partner_slug: 'tripoint' } })
    expect(out(r).considered.map((c) => c.partner)).toEqual(['tripoint'])
    expect(out(r).considered.some((c) => c.reason === 'no_pricing_for_population')).toBe(false)
    expect(h.buyerCalls.map((c) => c.slug)).toEqual(['tripoint'])
    expect(h.ledgers.get('p-9')?.calls ?? []).toEqual([])
  })

  it('an open breaker skips the buyer with circuit_open and releases nothing it never took', async () => {
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), breakerOpen: ['tripoint'] })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'sold', sale: { partner_slug: 'liberty' } })
    expect(out(r).considered[0]).toMatchObject({ partner: 'tripoint', outcome: 'skipped', reason: 'circuit_open' })
    expect(h.buyerCalls.map((c) => c.slug)).toEqual(['liberty'])
  })

  it('a cap refusal names the cap and the count and tries the next buyer', async () => {
    const counts = { hour_leads: 50, day_leads: 50, hour_spend_cents: 0, day_spend_cents: 0, et_day: '2027-09-20', hour_bucket: 0 }
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), refuse: { 'p-1': { reserved: false, reason: 'hourly_lead_cap', limit: 50, counts } } })
    const r = await run(h)
    expect(out(r).considered[0]).toMatchObject({ partner: 'tripoint', outcome: 'skipped', reason: 'hourly_lead_cap', detail: '50 of 50' })
    expect(out(r)).toMatchObject({ _route: 'sold', sale: { partner_slug: 'liberty' } })
  })

  it('a ledger that errors is cap_check_error, never an allow', async () => {
    const h = harness({ ledgerError: new Error('ledger 500') })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'no_sale' })
    expect(out(r).considered[0]).toMatchObject({ partner: 'tripoint', reason: 'cap_check_error' })
    expect(h.buyerCalls).toEqual([])
  })

  it('stamps the live share and the caps in force on the output', async () => {
    const h = harness()
    const r = await run(h, ctx({ env: { BUYER_SELECT_LIVE_PERCENT: '100' } }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(r)).toMatchObject({ _route: 'sold', live_percent_in_force: 100 })
    expect(out(r).caps_in_force).toEqual([{ partner: 'tripoint', hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }])
  })
})

describe('the live share (L72)', () => {
  it('the variable deleted: every sell off lead routes deferred with live_percent_unset and no buyer is called', async () => {
    const h = harness()
    const r = await run(h, ctx({ env: {} }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'live_percent_unset', live_percent_in_force: null })
    expect(h.buyerCalls).toEqual([])
    expect(h.sales).toEqual([])
  })

  it('the variable set to a non numeric value is the same', async () => {
    const h = harness()
    const r = await run(h, ctx({ env: { BUYER_SELECT_LIVE_PERCENT: 'all' } }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'live_percent_unset' })
    expect(h.buyerCalls).toEqual([])
  })

  it('the boundary is exclusive: a lead whose bucket equals the percent is outside the share', async () => {
    const bucket = canaryBucket('lead-1')
    const atBoundary = await run(harness(), ctx({ env: { BUYER_SELECT_LIVE_PERCENT: String(bucket) } }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(atBoundary)).toMatchObject({ _route: 'deferred', reason: 'canary_out', live_percent_in_force: bucket })
    const justInside = await run(harness(), ctx({ env: { BUYER_SELECT_LIVE_PERCENT: String(bucket + 1) } }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(justInside)._route).toBe('sold')
  })

  it('a lead outside the share routes deferred with canary_out, inside it sells', async () => {
    const zero = await run(harness(), ctx({ env: { BUYER_SELECT_LIVE_PERCENT: '0' } }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(zero)).toMatchObject({ _route: 'deferred', reason: 'canary_out', live_percent_in_force: 0 })
    const all = await run(harness(), ctx({ env: { BUYER_SELECT_LIVE_PERCENT: '100' } }), node({ live_percent_env: 'BUYER_SELECT_LIVE_PERCENT' }))
    expect(out(all)).toMatchObject({ _route: 'sold', live_percent_in_force: 100 })
  })
})

// ── Decide only ───────────────────────────────────────────────────────────────

describe('decide only mode (L142)', () => {
  it('does everything except the buyer call under the rehearsal kind, marks the rehearsal claim sold, mirrors, and routes deferred', async () => {
    const h = harness()
    const r = await run(h, ctx({ env: { BUYER_SELECT_REHEARSAL_CAPS: JSON.stringify({ hourly_lead_cap: 500, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }) } }), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'decide_only', mode_effective: 'decide_only', sale: { skipped: false, accepted: true, partner_slug: 'tripoint', result_code: 'rehearsal_no_call' } })
    expect(h.buyerCalls).toEqual([])
    expect(h.sales[0].key.kind).toBe('rehearsal')
    expect(h.sales[0].state).toBe('sold')
    expect(h.ledgers.get('p-1')!.calls).toEqual(['reserve:rehearsal:2190', 'commit'])
    expect(h.mirrored).toHaveLength(1)
    expect(h.bidRows).toEqual([])
    expect(typeof out(r).would_send_body_sha256).toBe('string')
    expect(out(r).would_send_body_sha256).toHaveLength(64)
    expect(r.failure).toBeUndefined()
  })

  it('records the state it resolved for the lead on the output, null when the value is not a state, so the parity summary can count it (#1413)', async () => {
    const h = harness()
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r).lead_state).toBe('TX')
    const h2 = harness()
    const r2 = await run(h2, ctx(), node({ mode: 'decide_only', state: '{{trigger.payload.personalInformation.firstName}}' }))
    expect(out(r2).lead_state).toBeNull()
  })

  it('records the debt it priced the lead on, in whole dollars, and null when the value is not an amount, so the sighting carries the figure the payout was computed on (#1482)', async () => {
    const h = harness()
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r).lead_debt).toBe(18250)
    const h2 = harness()
    const r2 = await run(h2, ctx(), node({ mode: 'decide_only', debt: '{{trigger.payload.personalInformation.firstName}}' }))
    expect(out(r2).lead_debt).toBeNull()
  })

  it('rehearsal caps come from BUYER_SELECT_REHEARSAL_CAPS and an invalid value is a named reason, not a throw (L688)', async () => {
    const h = harness()
    const r = await run(h, ctx({ env: { BUYER_SELECT_REHEARSAL_CAPS: '{not json' } }), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'rehearsal_caps_invalid' })
    expect(h.sales).toEqual([])
    expect(r.failure).toBeUndefined()
  })

  it.each([
    ['the profile read fails with no last good copy', { profiles: new Error('profiles down') }, 'profiles_unavailable'],
    ['the ledger errors', { ledgerError: new Error('ledger 500') }, 'cap_check_error'],
  ] as const)('%s: still routes onward with a named reason and never throws', async (_label, opts, reason) => {
    const h = harness(opts)
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason })
    expect(r.failure).toBeUndefined()
    expect(h.buyerCalls).toEqual([])
  })

  it('the mirror erroring is reported and does not fail the rehearsal', async () => {
    const h = harness({ mirrorError: new Error('supabase down') })
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', mirrored: false })
    expect(r.failure).toBeUndefined()
  })

  it('an empty lead key routes deferred in decide only and fails the step by name in live', async () => {
    const decide = await run(harness(), ctx({ leadUuid: '' }), node({ mode: 'decide_only' }))
    expect(out(decide)).toMatchObject({ _route: 'deferred', reason: 'lead_key_empty' })
    const live = await run(harness(), ctx({ leadUuid: '' }))
    expect(live.failure?.message).toMatch(/lead_key_empty/)
    expect(out(live)._route).toBe('no_sale')
  })

  it('past its internal deadline it routes deferred with rehearsal_deadline, and the added latency is labelled decide_only', async () => {
    const h = harness({ ledgerError: undefined })
    // The clock jumps past the deadline the moment the profiles are loaded.
    const slowProfiles = async () => { h.clockMs += BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS + 1; return snapshot(buyer('p-1', 'tripoint', 1)) }
    const r = await executeBuyerSelectNode(node({ mode: 'decide_only' }), ctx(), env, { ...h.deps, loadProfiles: slowProfiles })
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'rehearsal_deadline', mode_effective: 'decide_only' })
    expect(h.logs.some((l) => l.event === 'buyer_select_decide_only_latency' && l.mode === 'decide_only')).toBe(true)
    expect(h.sales).toEqual([])
  })
})

// ── Report only ───────────────────────────────────────────────────────────────

describe('report only: Test Runner, shadow and local dev (L319, L719)', () => {
  it.each([
    ['a Test Runner run', { isTest: true }, false],
    ['a shadow dry run', { shadow: 'dry_run' as const }, false],
    ['local dev', {}, true],
  ])('%s evaluates and reports, claims, reserves, calls and mirrors nothing, and says which mode it ran in', async (_label, over, localDev) => {
    const h = harness()
    h.deps.localDev = localDev
    const r = await run(h, ctx(over as never))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'report_only', mode_effective: 'report_only' })
    expect(out(r).considered).toEqual([expect.objectContaining({ partner: 'tripoint', outcome: 'eligible', payout_cents: 2190 })])
    expect(h.sales).toEqual([])
    expect(h.buyerCalls).toEqual([])
    expect(h.mirrored).toEqual([])
    expect(h.bidRows).toEqual([])
  })

  it('local dev with ALLOW_PROD_WRITES set is still report only: the guard is about the buyer, not the database (L719)', async () => {
    const h = harness()
    h.deps.localDev = true
    const r = await run(h, ctx({ env: { ALLOW_PROD_WRITES: 'true' } }))
    expect(out(r).mode_effective).toBe('report_only')
    expect(h.buyerCalls).toEqual([])
  })
})

// ── Shape ─────────────────────────────────────────────────────────────────────

describe('the output is deliberately not the Tripoint shape', () => {
  it('carries no resultCode, qualified or createLead key anywhere, so isTripointBidOutput can never match it', async () => {
    const r = await run(harness())
    const keys = new Set<string>()
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val) }
    }
    walk(out(r))
    for (const forbidden of ['resultCode', 'qualified', 'createLead']) expect(keys.has(forbidden), forbidden).toBe(false)
  })

  it('the node runs once whatever retries the definition carries', async () => {
    const h = harness()
    const r = await run(h, ctx(), node({ retries: 5 }))
    expect(out(r).retries_ignored).toBe(5)
    expect(h.buyerCalls).toHaveLength(1)
  })

  it('a missing or unknown mode is a named failure in live and never a default (L72)', async () => {
    const r = await run(harness(), ctx(), node({ mode: 'canary' }))
    expect(r.failure?.message).toMatch(/mode_invalid/)
    expect(out(r)._route).toBe('no_sale')
  })
})


describe('the decide only budget bounds the whole attempt (#1491)', () => {
  it('a ledger that would take five seconds ends the rehearsal at the budget, reports rehearsal_deadline and holds nothing', async () => {
    const h = harness({ slowReserveMs: 5_000 })
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'rehearsal_deadline', mode_effective: 'decide_only' })
    expect(out(r).duration_ms).toBeLessThanOrEqual(BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS)
    expect(h.sales[0].state).toBe('free')
    expect(h.ledgerClientOpts[0]?.deadlineMs).toBeTypeOf('function')
    expect(r.failure).toBeUndefined()
  })

  it('a reserve that overran the budget is released in the background with a real deadline, so the ledger never holds a reservation nobody settles (#1512)', async () => {
    const h = harness({ slowReserveMs: 5_000 })
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'rehearsal_deadline' })
    expect(h.background).toHaveLength(1)
    await Promise.all(h.background)
    expect(h.ledgers.get('p-1')?.calls).toEqual(['release:released'])
    expect(h.sales[0].state).toBe('free')
    const deadline = h.ledgerClientOpts[0]?.deadlineMs
    expect(deadline).toBeTypeOf('function')
    if (typeof deadline !== 'function') return
    // The budget is spent, so an ordinary call would get the 1 ms floor; cleanup keeps the standard deadline.
    expect(deadline('buyer ledger reserve')).toBeLessThanOrEqual(1)
    expect(deadline('buyer ledger release')).toBe(OBJECT_CALL_DEADLINE_MS)
    expect(deadline('lead sale free')).toBe(OBJECT_CALL_DEADLINE_MS)
  })

})

/**
 * #1508: live has a ceiling of its own before the buyer call. Everything up to
 * and including the reservation shares BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS from
 * the node's start; the buyer call keeps BUYER_CALL_TIMEOUT_MS, and the calls
 * after it (commit, mark sold) and every cleanup keep OBJECT_CALL_DEADLINE_MS,
 * because an accepted answer must still be recorded whatever the clock says.
 */
describe('the live pre-call budget (#1508)', () => {
  it('is 2,000 ms: above the rehearsal p95 of 913 ms and the measured object call p99 of 1,492 ms, and a fraction of the 20 s Engine allows', () => {
    expect(BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS).toBe(2_000)
    expect(BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS).toBeGreaterThan(MEASURED_OBJECT_CALL_P99_MS)
    expect(BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS).toBeGreaterThan(BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS)
    expect(BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS).toBeLessThan(BUYER_CALL_TIMEOUT_MS)
  })

  it('hands the ledger client a deadline function: pre-call operations are bounded by what is left of the budget, cleanup keeps the standard deadline', async () => {
    const h = harness({ slowReserveMs: 5_000 })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'no_sale', reason: 'object_deadline', mode_effective: 'live' })
    expect(out(r).considered[0]).toMatchObject({ partner: 'tripoint', outcome: 'skipped', reason: 'object_deadline' })
    expect(out(r).duration_ms).toBeLessThanOrEqual(BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS)
    expect(h.buyerCalls).toEqual([])
    // The reservation that may have landed is released and the claim freed, inline: money was about to move.
    expect(h.ledgers.get('p-1')?.calls).toEqual(['release:released'])
    expect(h.sales[0].state).toBe('free')
    expect(h.background).toHaveLength(0)
    expect(r.failure).toBeUndefined()
    const deadline = h.ledgerClientOpts[0]?.deadlineMs
    expect(deadline).toBeTypeOf('function')
    if (typeof deadline !== 'function') return
    expect(deadline('buyer ledger release')).toBe(OBJECT_CALL_DEADLINE_MS)
    expect(deadline('lead sale free')).toBe(OBJECT_CALL_DEADLINE_MS)
  })

  it('a pre-call operation is never given more than the standard object deadline, and never less than a millisecond', async () => {
    const h = harness()
    await run(h)
    const deadline = h.ledgerClientOpts[0]?.deadlineMs
    expect(deadline).toBeTypeOf('function')
    if (typeof deadline !== 'function') return
    // After the buyer call the phase has moved on: commit and mark sold get the standard deadline.
    expect(deadline('buyer ledger commit')).toBe(OBJECT_CALL_DEADLINE_MS)
    expect(deadline('buyer ledger reserve')).toBe(OBJECT_CALL_DEADLINE_MS)
  })

  it('a sale that fits inside the budget is unchanged: claim, reserve, call, commit, mark sold, mirror', async () => {
    const h = harness()
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'sold', reason: 'sold', mode_effective: 'live' })
    expect(h.ledgers.get('p-1')!.calls).toEqual(['reserve:live:2190', 'commit'])
    expect(h.sales[0].state).toBe('sold')
  })

  it('profiles that take the whole budget route no_sale with object_deadline and call nobody', async () => {
    const h = harness()
    const slowProfiles = async () => { h.clockMs += BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS + 1; return snapshot(buyer('p-1', 'tripoint', 1)) }
    h.deps.loadProfiles = slowProfiles
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'no_sale', reason: 'object_deadline' })
    expect(h.buyerCalls).toEqual([])
    expect(h.sales).toHaveLength(0)
    expect(r.failure).toBeUndefined()
  })

  it('a breaker that cannot be read skips the buyer as breaker_unreadable, never as an open breaker and never as an allow (#1530)', async () => {
    const h = harness({ profiles: snapshot(buyer('p-1', 'tripoint', 1), buyer('p-2', 'liberty', 2)), breakerError: { tripoint: new DeadlineError('circuit check tripoint', 206) } })
    const r = await run(h)
    expect(out(r).considered[0]).toMatchObject({ partner: 'tripoint', outcome: 'skipped', reason: 'breaker_unreadable', detail: 'circuit check tripoint did not answer within 206 ms' })
    expect(out(r)).toMatchObject({ _route: 'sold', sale: { partner_slug: 'liberty' } })
    expect(h.buyerCalls.map((c) => c.slug)).toEqual(['liberty'])
  })
})

// ── Claim heals and expirations on the output (#1643) ─────────────────────────

/**
 * A lead sale claim scripted by the test: each claim answers the next result in
 * the queue (the last one repeats), and heal and free move the generation on.
 */
class ScriptedSale implements SaleApi {
  calls: string[] = []
  generation = 10
  constructor(private readonly answers: Array<ClaimResult | Error>) {}
  async claim(body: ClaimBody): Promise<ClaimResult> {
    this.calls.push(`claim:${body.execution_id}`)
    const next = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]
    if (next instanceof Error) throw next
    return next
  }
  async sold(generation: number): Promise<number> { this.calls.push(`sold:${generation}`); return ++this.generation }
  async free(generation: number): Promise<number> { this.calls.push(`free:${generation}`); return ++this.generation }
  async heal(generation: number): Promise<number> { this.calls.push(`heal:${generation}`); return ++this.generation }
}

/** The claim's answer when THIS claim found the holder past its deadline and moved it to in_doubt. */
const EXPIRED_NOW: ClaimResult = { state: 'in_doubt', partner_id: 'p-1', generation: 2, expired_in_flight: true }
/** The claim's answer when it was already in doubt before this execution arrived. */
const ALREADY_IN_DOUBT: ClaimResult = { state: 'in_doubt', partner_id: 'p-1', generation: 2 }

function withSale(h: Harness, sale: ScriptedSale): Harness {
  h.deps.saleClient = () => sale
  return h
}

/** Seeds an entry on buyer p-1's ledger for lead-1, as an earlier attempt that died would have left it. */
function seedEntry(h: Harness, status: LedgerEntry['status']) {
  const ledger = new FakeLedger('p-1')
  ledger.entries.set('lead-1|engine|rehearsal', {
    lead_key: 'lead-1', population: 'engine', kind: 'rehearsal', payout_cents: 2190, status, et_day: '2027-09-20', hour_bucket: 0, reserved_at: NOW - 60_000,
    resolved_at: status === 'reserved' ? null : NOW - 59_000, mirrored: false, execution_id: 'exec-0',
    outcome: status === 'accepted' ? { buyer_reference: 'L-0', result_code: '1000', http_status: 200, payout_cents: 2190 } : null,
    resolution_source: null, resolved_by: null,
  })
  h.ledgers.set('p-1', ledger)
}

describe('the claim heals and expirations the parity reader sums (#1643)', () => {
  it('a claim that finds an expired in_flight claim and heals it from the ledger records one of each', async () => {
    const sale = new ScriptedSale([EXPIRED_NOW])
    const h = withSale(harness(), sale)
    seedEntry(h, 'accepted')
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'decide_only', replay: true })
    expect(sale.calls).toEqual(['claim:exec-1', 'heal:2'])
    expect(out(r).rehearsal_expired_in_flight).toBe(1)
    expect(out(r).rehearsal_in_doubt_heals).toBe(1)
  })

  it('an expired claim whose ledger holds nothing is freed and claimed again: one expiration, no heal', async () => {
    const sale = new ScriptedSale([EXPIRED_NOW, { state: 'claimed', generation: 12 }])
    const h = withSale(harness(), sale)
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r)).toMatchObject({ _route: 'deferred', reason: 'decide_only' })
    expect(sale.calls).toEqual(['claim:exec-1', 'free:2', 'claim:exec-1', 'sold:12'])
    expect(out(r).rehearsal_expired_in_flight).toBe(1)
    expect(out(r).rehearsal_in_doubt_heals).toBe(0)
  })

  it('a claim already in doubt before this execution arrived is healed without counting an expiration it did not cause', async () => {
    const h = withSale(harness(), new ScriptedSale([ALREADY_IN_DOUBT]))
    seedEntry(h, 'accepted')
    const r = await run(h, ctx(), node({ mode: 'decide_only' }))
    expect(out(r).rehearsal_expired_in_flight).toBe(0)
    expect(out(r).rehearsal_in_doubt_heals).toBe(1)
  })

  it('an expiration found by the waiter, whose holder died while it waited, is counted once', async () => {
    const holder: ClaimResult = { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW, generation: 1 }
    const sale = new ScriptedSale([holder, EXPIRED_NOW, ALREADY_IN_DOUBT, { state: 'claimed', generation: 12 }])
    const h = withSale(harness(), sale)
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'sold' })
    expect(out(r).rehearsal_expired_in_flight).toBe(1)
    expect(out(r).rehearsal_in_doubt_heals).toBe(0)
  })

  it('an ordinary claim records a measured zero for both, in decide only and in live', async () => {
    const rehearsal = await run(harness(), ctx(), node({ mode: 'decide_only' }))
    expect(out(rehearsal)).toMatchObject({ rehearsal_expired_in_flight: 0, rehearsal_in_doubt_heals: 0 })
    const live = await run(harness())
    expect(out(live)).toMatchObject({ _route: 'sold', rehearsal_expired_in_flight: 0, rehearsal_in_doubt_heals: 0 })
  })

  it('a lead that never reached a claim leaves both unrecorded, so it is not counted as measured', async () => {
    const notForSale = await run(harness(), ctx({ sellOff: false }), node({ mode: 'decide_only' }))
    expect(out(notForSale)).not.toHaveProperty('rehearsal_in_doubt_heals')
    expect(out(notForSale)).not.toHaveProperty('rehearsal_expired_in_flight')
    // A claim call that never answered measured nothing either: the object may or may not have moved.
    const unanswered = await run(withSale(harness(), new ScriptedSale([new Error('lead sale claim answered 500: boom')])), ctx(), node({ mode: 'decide_only' }))
    expect(out(unanswered)).toMatchObject({ _route: 'deferred', reason: 'cap_check_error' })
    expect(out(unanswered)).not.toHaveProperty('rehearsal_in_doubt_heals')
    expect(out(unanswered)).not.toHaveProperty('rehearsal_expired_in_flight')
  })

  it('the parity reader sums what the node wrote and no longer lists either as unmeasured', async () => {
    const healed = withSale(harness(), new ScriptedSale([EXPIRED_NOW]))
    seedEntry(healed, 'accepted')
    const a = out(await run(healed, ctx(), node({ mode: 'decide_only' })))
    const b = out(await run(harness(), ctx(), node({ mode: 'decide_only' })))
    const counts = summariseParityDay(
      [a, b].map((o, i) => ({ execution_id: `e${i}`, started_at: new Date(NOW).toISOString(), node: o, node_duration_ms: o.duration_ms, incumbent: null })),
      { accept: [], decline: [] },
    )
    expect(counts.rehearsal_in_doubt_heals).toBe(1)
    expect(counts.rehearsal_expired_in_flight).toBe(1)
    expect(counts.unmeasured).not.toContain('rehearsal_in_doubt_heals')
    expect(counts.unmeasured).not.toContain('rehearsal_expired_in_flight')
  })
})

/**
 * The live arm's added latency could not be attributed at Stage B 1 percent, because the step's
 * duration and the bid row both span claim, reserve, the call, commit, mark sold and the mirror
 * together (#1804). Each live attempt therefore records the buyer call by itself and the time
 * spent before and after it, and the output carries the calls' total, so the node's own cost is
 * duration_ms minus buyer_call_ms on one row.
 */
describe('the time of each phase of a live attempt (#1804)', () => {
  it('records the time before the call, the call itself, and the time after it, on the attempt row, the output and a log line', async () => {
    const h = harness({ slowReserveMs: 300, advanceOnBuyerCall: 2500, advanceOnBreakerRecord: 40, advanceOnMirror: 200 })
    const r = await run(h)
    expect(out(r)._route).toBe('sold')
    // The breaker's record of the answer is our work, so it counts after the call, never inside it.
    expect(r.attempts[0].output.timing).toMatchObject({ before_call_ms: 300, call_ms: 2500, after_call_ms: 240 })
    expect(out(r).buyer_call_ms).toBe(2500)
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'buyer_select_attempt_timing', partner_slug: 'tripoint', outcome: 'accepted', before_call_ms: 300, call_ms: 2500, after_call_ms: 240 }))
  })

  it('a call that throws is still timed up to the throw, so a slow failure is visible as the buyer\'s time', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const h = harness({ answers: { tripoint: [abort] }, advanceOnBuyerCall: 5000 })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'transient' })
    expect(r.attempts[0].output.timing).toMatchObject({ call_ms: 5000 })
    expect(out(r).buyer_call_ms).toBe(5000)
  })

  it('a decline is timed the same way as a sale', async () => {
    const h = harness({ answers: { tripoint: [DUPLICATE] }, advanceOnBuyerCall: 1800 })
    const r = await run(h)
    expect(out(r)._route).toBe('no_sale')
    expect(r.attempts[0].output.timing).toMatchObject({ call_ms: 1800 })
    expect(out(r).buyer_call_ms).toBe(1800)
  })

  it('a cascade adds every buyer\'s call into buyer_call_ms and keeps each attempt\'s own figure', async () => {
    const h = harness({ profiles: snapshot(buyer('p-2', 'liberty', 2), buyer('p-1', 'tripoint', 1)), answers: { tripoint: [DUPLICATE], liberty: [ACCEPTED] }, advanceOnBuyerCall: 1000 })
    const r = await run(h)
    expect(r.attempts.map((a) => (a.output.timing as { call_ms: number }).call_ms)).toEqual([1000, 1000])
    expect(out(r).buyer_call_ms).toBe(2000)
  })

  it('records nothing when no buyer was called, so an unmeasured lead is never read as a zero (L90)', async () => {
    const decide = harness()
    const rehearsed = await run(decide, ctx(), node({ mode: 'decide_only' }))
    expect(out(rehearsed).buyer_call_ms).toBeUndefined()
    expect(rehearsed.attempts[0].output.timing).toBeUndefined()

    const counts = { hour_leads: 50, day_leads: 50, hour_spend_cents: 0, day_spend_cents: 0, et_day: '2027-09-20', hour_bucket: 0 }
    const capped = harness({ refuse: { 'p-1': { reserved: false, reason: 'hourly_lead_cap', limit: 50, counts } } })
    const refused = await run(capped)
    expect(out(refused).buyer_call_ms).toBeUndefined()
    expect(capped.logs.filter((l) => l.event === 'buyer_select_attempt_timing')).toEqual([])
  })
})

/**
 * The phase split showed the live arm's added time is our own work around the call, p50 769 ms
 * before plus after over 27 attempts, with the call itself level with the legacy step (#1804).
 * Each object call in those phases is therefore timed on its own, so the one costing the most
 * can be named from production rather than guessed from the code.
 */
describe('the time of each object call around a live buyer call (#1804)', () => {
  const COSTS = { claim: 120, commit: 90, sold: 70, release: 60, free: 15 }

  it('an accepted sale records the claim, reserve, breaker, commit, mark sold and mirror, adding up to the before and after figures', async () => {
    const h = harness({ advanceOnObject: COSTS, slowReserveMs: 300, advanceOnBuyerCall: 2500, advanceOnBreakerRecord: 40, advanceOnMirror: 200 })
    const r = await run(h)
    expect(out(r)._route).toBe('sold')
    expect(r.attempts[0].output.timing).toEqual({
      before_call_ms: 420, call_ms: 2500, after_call_ms: 400,
      claim_ms: 120, reserve_ms: 300, breaker_ms: 40, commit_ms: 90, mark_sold_ms: 70, mirror_ms: 200,
    })
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'buyer_select_attempt_timing', claim_ms: 120, reserve_ms: 300, breaker_ms: 40, commit_ms: 90, mark_sold_ms: 70, mirror_ms: 200 }))
  })

  it('a decline records the release and its mirror in place of commit and mark sold, which it never reached', async () => {
    const h = harness({ answers: { tripoint: [DUPLICATE] }, advanceOnObject: COSTS, slowReserveMs: 300, advanceOnBuyerCall: 1800, advanceOnBreakerRecord: 40, advanceOnMirror: 150 })
    const r = await run(h)
    expect(out(r)._route).toBe('no_sale')
    // Releasing a declined attempt gives back the reservation and frees the claim (60 + 15); the decline is then copied too.
    expect(r.attempts[0].output.timing).toEqual({ before_call_ms: 420, call_ms: 1800, after_call_ms: 265, claim_ms: 120, reserve_ms: 300, breaker_ms: 40, release_ms: 75, mirror_ms: 150 })
  })

  it('a call that throws still records the claim, reserve and breaker, and nothing it did not reach', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const h = harness({ answers: { tripoint: [abort] }, advanceOnObject: COSTS, slowReserveMs: 300, advanceOnBuyerCall: 5000, advanceOnBreakerRecord: 40 })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'transient' })
    const timing = r.attempts[0].output.timing as Record<string, number>
    expect(timing).toMatchObject({ claim_ms: 120, reserve_ms: 300, call_ms: 5000, breaker_ms: 40 })
    for (const absent of ['commit_ms', 'mark_sold_ms', 'mirror_ms', 'release_ms']) expect(timing).not.toHaveProperty(absent)
  })

  it('a mirror that fails is still timed, since the lead waited for it all the same', async () => {
    const h = harness({ advanceOnObject: COSTS, mirrorError: new Error('insert failed'), advanceOnMirror: 900 })
    const r = await run(h)
    expect(out(r)._route).toBe('sold')
    expect(r.attempts[0].output.timing).toMatchObject({ mirror_ms: 900 })
  })
})

/**
 * The buyer_sales copy is a database write the lead waits on after the buyer
 * accepted (#1849). It had no deadline, so in a database hang the sold lead
 * waited for ever. record_buyer_sale is idempotent and the minute drain delivers
 * any entry left unmirrored, so the wait is bounded, and a copy that ran out of
 * time is reported as outcome unknown: the write may have landed, so it is not
 * reported as not recorded, and nothing undoes it.
 */
describe('the buyer_sales copy is bounded (#1849)', () => {
  it('a copy that does not answer in time ends the wait, keeps the sale, and is reported as outcome unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = harness({ mirrorHangs: true })
      let settled = false
      const pending = run(h).then((r) => { settled = true; return r })
      // Let the attempt reach the copy before any time passes.
      // The row id is a WebCrypto digest, which settles off the microtask queue.
      for (let i = 0; i < 1_000 && h.mirrorsHanging === 0; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(h.mirrorsHanging).toBe(1)
      await vi.advanceTimersByTimeAsync(BUYER_SALE_MIRROR_DEADLINE_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const r = await pending
      expect(out(r)).toMatchObject({ _route: 'sold', reason: 'sold', mirrored: 'outcome_unknown' })
      expect(r.attempts[0].output).toMatchObject({ outcome: 'accepted', mirrored: 'outcome_unknown' })
      expect(h.logs).toContainEqual(expect.objectContaining({ event: 'buyer_select_mirror_failed', mirror_outcome: 'outcome_unknown' }))
      // The database is not answering, so the lead's later reads take their copies at once.
      expect(h.unanswered).toEqual(['buyer_sales copy'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rehearsal copy cut short by its own spent budget is outcome unknown, but is no evidence the database is down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = harness({ mirrorHangs: true })
      // The rehearsal's budget is all but spent by the time it reaches the copy.
      const slowProfiles = async () => { h.clockMs += BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS - 20; return snapshot(buyer('p-1', 'tripoint', 1)) }
      const pending = executeBuyerSelectNode(node({ mode: 'decide_only' }), ctx(), env, { ...h.deps, loadProfiles: slowProfiles })
      for (let i = 0; i < 1_000 && h.mirrorsHanging === 0; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(h.mirrorsHanging).toBe(1)
      await vi.advanceTimersByTimeAsync(BUYER_SALE_MIRROR_DEADLINE_MS)
      expect(out(await pending)).toMatchObject({ mirrored: 'outcome_unknown' })
      expect(h.unanswered).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a sold lead answers with the database hung beneath the real supabase-js client: the production copy is bounded too', async () => {
    // The outage drill's hung shape (#1851): a request ends only when its signal aborts.
    let requests = 0
    const hung = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as typeof globalThis.fetch
    const supabase = createLeadSupabaseClient({ SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env, { fetch: hung })
    const objects = { idFromName: () => 'id', get: () => ({}) }
    const production = productionDeps(ctx(), { BUYER_LEDGER: objects, LEAD_SALE: objects, CIRCUIT_BREAKER: objects } as unknown as Env, supabase)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = harness()
      h.deps = { ...h.deps, mirror: production.mirror }
      const pending = run(h)
      for (let i = 0; i < 1_000 && requests === 0; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(requests).toBe(1)
      await vi.advanceTimersByTimeAsync(BUYER_SALE_MIRROR_DEADLINE_MS)
      expect(out(await pending)).toMatchObject({ _route: 'sold', mirrored: 'outcome_unknown' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the production copy is not sent into a database the lead has already seen fail; the minute drain delivers it', async () => {
    let requests = 0
    const counting = (async () => { requests++; return new Response('null', { status: 200 }) }) as typeof globalThis.fetch
    const supabase = createLeadSupabaseClient({ SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env, { fetch: counting })
    noteLeadWriteUnanswered(supabase, 'buyer profiles')
    const objects = { idFromName: () => 'id', get: () => ({}) }
    const production = productionDeps(ctx(), { BUYER_LEDGER: objects, LEAD_SALE: objects, CIRCUIT_BREAKER: objects } as unknown as Env, supabase)
    await expect(production.mirror({} as never, {} as never, 'p-1')).rejects.toThrow(/record_buyer_sale not sent: an earlier database call in this lead failed \(buyer profiles/)
    expect(requests).toBe(0)
  })

  it('a copy the database refused is reported as not mirrored, because a refused write did not land', async () => {
    const h = harness({ mirrorError: new Error('record_buyer_sale failed: connection refused') })
    const r = await run(h)
    expect(out(r)).toMatchObject({ _route: 'sold', mirrored: false })
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'buyer_select_mirror_failed', mirror_outcome: 'not_mirrored' }))
    expect(h.unanswered).toEqual([])
  })

  it('the deadline sits well above the healthy write: record_buyer_sale took at most 488 ms over the 24 hours to 2026-10-07 (p99 403 ms, 50 calls)', () => {
    expect(BUYER_SALE_MIRROR_DEADLINE_MS).toBeGreaterThanOrEqual(2 * 488)
    expect(BUYER_SALE_MIRROR_DEADLINE_MS).toBeLessThanOrEqual(OBJECT_CALL_DEADLINE_MS)
  })
})
