/**
 * The buyer_select executor (#1411 PR B), unit level with every dependency
 * injected: the profile snapshot, the two objects, the buyer call, the breaker,
 * the mirror, the bid logger and the clock. What the walker does with the
 * result (step rows, routing) is covered in engine/__tests__/buyer-select-walk.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { DeadlineError } from '@bidspoke/buyer-profile'
import type { ClientOptions } from '../../../lib/buyer-object-clients'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'
import type { BuyerProfilesSnapshot, LoadedBuyer } from '../../../lib/buyer-profile-loader'
import type { PartnerCallResult } from '../../../lib/post-to-partner'
import type { ClaimBody, ClaimResult } from '../../../durable-objects/lead-sale'
import type { EntryKey, EntryResult, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../../../durable-objects/buyer-ledger'
import type { LedgerApi, SaleApi } from '../../../lib/buyer-sale-attempt'
import { canaryBucket } from '@bidspoke/buyer-profile'
import { ENGINE_TRIPOINT_SALE_PAYLOAD } from '../buyer-select-payload'
import { BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS, executeBuyerSelectNode, type BuyerSelectDeps, type BuyerSelectOutput } from '../buyer-select'

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
      circuit_enabled: true, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
    },
    profile: {
      partnerId, isEnabled: true, priority, allowedStates: ['TX'], debtMin: 15000, debtMax: null, loanAmountMin: null,
      hourlyLeadCap: null, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: null,
      windows: ALL_WEEK, blackoutDates: [], tiers: [{ population: 'engine', debtFrom: 12500, debtTo: null, multiplier: 0.0012 }],
      ...over,
    },
    version: 1,
    updated_at: '2027-09-20T10:00:00.000Z',
  }
}

const snapshot = (...buyers: LoadedBuyer[]): BuyerProfilesSnapshot => ({ org_id: 'org-1', loaded_at: new Date(NOW).toISOString(), updated_at_max: null, served_from: 'database', buyers })

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

class FakeSale implements SaleApi {
  state: 'free' | 'in_flight' | 'sold' = 'free'
  generation = 0
  outcome: SaleOutcomeRecord | null = null
  calls: string[] = []
  constructor(readonly key: { kind: string; population: string; lead_key: string }) {}
  async claim(body: ClaimBody): Promise<ClaimResult> {
    this.calls.push(`claim:${body.execution_id}`)
    if (this.state === 'sold') return { state: 'sold', partner_id: 'p', outcome: this.outcome!, generation: this.generation }
    this.state = 'in_flight'
    this.generation += 1
    return { state: 'claimed', generation: this.generation }
  }
  async sold(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    this.calls.push(`sold:${generation}`)
    this.state = 'sold'
    this.outcome = outcome
    return ++this.generation
  }
  async free(generation: number): Promise<number> {
    this.calls.push(`free:${generation}`)
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
  constructor(readonly partnerId: string, private readonly refuse: ReserveResult | Error | null = null) {}
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
    const e = this.entries.get(this.k(key))!
    const next = { ...e, status: 'accepted' as const, outcome, resolved_at: NOW }
    this.entries.set(this.k(key), next)
    return next
  }
  async release(key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry> {
    this.calls.push(`release:${status}`)
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
  bidRows: Array<Record<string, unknown>>
  breakerCalls: string[]
  logs: Array<Record<string, unknown>>
  clockMs: number
  /** The options each ledger client was built with, in order; undefined when the node passed none. */
  ledgerClientOpts: Array<ClientOptions | undefined>
}

function harness(opts: {
  profiles?: BuyerProfilesSnapshot | Error
  answers?: Record<string, BuyerAnswer[]>
  refuse?: Record<string, ReserveResult | Error>
  breakerOpen?: string[]
  mirrorError?: Error
  ledgerError?: Error
  advanceOnBuyerCall?: number
  /** A reserve that takes this long: past the deadline the client was given, it throws the client's DeadlineError at that deadline. */
  slowReserveMs?: number
} = {}): Harness {
  const h: Harness = { sales: [], ledgers: new Map(), buyerCalls: [], mirrored: [], bidRows: [], breakerCalls: [], logs: [], clockMs: NOW, ledgerClientOpts: [], deps: undefined as unknown as BuyerSelectDeps }
  const answers = { ...(opts.answers ?? {}) }
  h.deps = {
    loadProfiles: async () => {
      if (opts.profiles instanceof Error) throw opts.profiles
      return opts.profiles ?? snapshot(buyer('p-1', 'tripoint', 1))
    },
    saleClient: (key) => {
      const s = new FakeSale(key)
      h.sales.push(s)
      return s
    },
    ledgerClient: (partnerId, clientOpts) => {
      h.ledgerClientOpts.push(clientOpts)
      const ledgerError = opts.ledgerError
      if (ledgerError) {
        const reject = () => Promise.reject(ledgerError)
        return { reserve: reject, commit: reject, release: reject, entry: reject }
      }
      let l = h.ledgers.get(partnerId)
      if (!l) {
        l = new FakeLedger(partnerId, opts.refuse?.[partnerId] ?? null)
        h.ledgers.set(partnerId, l)
      }
      const slow = opts.slowReserveMs
      if (!slow) return l
      const ledger = l
      return {
        reserve: async (body) => {
          const d = clientOpts?.deadlineMs
          const limit = typeof d === 'function' ? d() : d
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
      check: async () => { h.breakerCalls.push(`check:${slug}`); return { allowed: !(opts.breakerOpen ?? []).includes(slug), state: (opts.breakerOpen ?? []).includes(slug) ? 'open' : 'closed' } },
      recordSuccess: async () => { h.breakerCalls.push(`success:${slug}`) },
      recordError: async () => { h.breakerCalls.push(`error:${slug}`) },
      releaseProbe: async () => { h.breakerCalls.push(`release:${slug}`) },
    }),
    mirror: async (row) => {
      if (opts.mirrorError) throw opts.mirrorError
      h.mirrored.push(row)
    },
    logBid: (row) => { h.bidRows.push(row as unknown as Record<string, unknown>) },
    clock: () => h.clockMs,
    sleep: async (ms) => { h.clockMs += ms },
    log: (event) => { h.logs.push(event) },
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

  it('in live mode the ledger client keeps its own deadline: no budget function is handed to it', async () => {
    const h = harness()
    await run(h)
    expect(h.ledgerClientOpts).toHaveLength(1)
    expect(h.ledgerClientOpts[0]?.deadlineMs).toBeUndefined()
  })
})
