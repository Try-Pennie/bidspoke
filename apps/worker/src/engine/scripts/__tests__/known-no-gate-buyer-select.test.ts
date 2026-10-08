/**
 * #1653: the known no gate judges a Tripoint answer the same whichever node
 * recorded it.
 *
 * Every Tripoint answer shape runs twice: through the kept tripoint_ping script
 * (Stage A), and through the real buyer_select node with Tripoint's LIVE rules
 * (Stage B), each answer being the captured fixture. The gate then reads each
 * node's output, and the two verdicts must agree wherever buyer_select's record
 * can tell the answers apart, and must never be a known no where it cannot.
 *
 * What buyer_select records under the live rules (read from partner_configs on
 * 2026-09-30): both known 502 answers (invalid data, the null id) match a decline
 * rule, so the node routes no_sale with declined_by_buyer, class Fail, no result
 * code and detail "http 502". A 1009 matches the `not_in` decline rule too, so it
 * is ALSO declined_by_buyer, while tripoint_ping calls it in_progress (a sale that
 * may yet happen). And because Tripoint's extra_extraction names no result_code
 * path, every Tripoint decline records a null result code with detail "http 200",
 * so a 1009 and a 1003 leave the same record.
 */
import { describe, expect, it } from 'vitest'
import success1001 from '../../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import duplicate1002 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1002.json'
import duplicate1003 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import duplicate1005 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1005.json'
import inProgress1009 from '../../../../../../packages/buyer-profile/fixtures/tripoint/in-progress-1009.json'
import invalid502 from '../../../../../../packages/buyer-profile/fixtures/tripoint/invalid-502.json'
import fixtures from './fixtures/engine-lead.json'
import { KEPT_ENGINE_SCRIPTS } from '../../../lib/engine-script-drift'
import { answerWith, runCanvasScript, type CanvasRun } from './canvas-script'
import { executeBuyerSelectNode, type BuyerSelectDeps, type BuyerSelectOutput } from '../../nodes/buyer-select'
import { ENGINE_TRIPOINT_SALE_PAYLOAD } from '../../nodes/buyer-select-payload'
import type { BuyerProfilesSnapshot, LoadedBuyer } from '../../../lib/buyer-profile-loader'
import type { PartnerCallResult } from '../../../lib/post-to-partner'
import type { ClaimBody, ClaimResult } from '../../../durable-objects/lead-sale'
import type { EntryKey, EntryResult, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../../../durable-objects/buyer-ledger'
import type { LedgerApi, SaleApi } from '../../../lib/buyer-sale-attempt'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'

const keptScript = (namespace: string): string => {
  const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script for ${namespace}`)
  return kept.script
}
const TRIPOINT_PING = keptScript('tripoint_ping')
const KNOWN_NO_GATE = keptScript('known_no_gate')

type Json = Record<string, unknown>
type Answer = { httpStatus: number; body: unknown }
type Verdict = { known_no: boolean; decided_by: string | null; answer: string | null }

/**
 * Tripoint's partner_configs row as read from production (xvrmivmpfykwwtriqwpg) on
 * 2026-09-30, the rules buyer_select sells by. extra_extraction carries Main Flow's
 * keys only, which is why the node records no result code for Tripoint.
 */
const LIVE_TRIPOINT = {
  accept_signals: [{ field: 'ok', equals: true }, { field: 'data.createLead.resultCode', in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] }],
  rejection_signals: [
    { field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] },
    { field: 'details[].message', any_item_contains: 'Cannot return null for non-nullable field CreateLeadResponse.id' },
    { field: 'details[].message', any_item_word_prefix_ci: 'invalid' },
  ],
  duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1002, 1003, 1004, 1005, 1020] }],
  extra_extraction: { leadId: 'data.createLead.id', result: { classifier: 'tripoint_result' } },
}
/** The same row with the result code path the node reads (the config change #1653 recommends). */
const WITH_RESULT_CODE_PATH = { ...LIVE_TRIPOINT.extra_extraction, result_code: 'data.createLead.resultCode', buyer_reference: 'data.createLead.id' }

const NOW = Date.UTC(2027, 8, 20, 15, 30)
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensMinute: 0, closesMinute: 1440 }))

function tripointBuyer(extraction: Record<string, unknown>): LoadedBuyer {
  return {
    partner: {
      id: 'p-tripoint', slug: 'tripoint', is_active: true, api_endpoint: 'https://tripoint.example/leads', cf_secret_key: null,
      outbound_field_mapping: null, extra_extraction: extraction, accept_signals: LIVE_TRIPOINT.accept_signals,
      response_classification: { rejection_signals: LIVE_TRIPOINT.rejection_signals as never },
      name: 'Tripoint', click_url: 'https://tripoint.example/apply', external_routing_code: 2,
      duplicate_signals: LIVE_TRIPOINT.duplicate_signals,
      circuit_enabled: true, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
    },
    profile: {
      partnerId: 'p-tripoint', soldOn: 'offer', isEnabled: true, priority: 1, allowedStates: ['TX'], debtMin: 15000, debtMax: null, loanAmountMin: null,
      hourlyLeadCap: null, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: null,
      windows: ALL_WEEK, blackoutDates: [], tiers: [{ population: 'engine', debtFrom: 12500, debtTo: null, multiplier: 0.0012 }],
    },
    version: 1,
    updated_at: '2027-09-20T10:00:00.000Z',
  } as LoadedBuyer
}

class FakeSale implements SaleApi {
  private generation = 0
  async claim(_body: ClaimBody): Promise<ClaimResult> { return { state: 'claimed', generation: ++this.generation } }
  async sold(): Promise<number> { return ++this.generation }
  async free(): Promise<number> { return ++this.generation }
  async heal(): Promise<number> { return ++this.generation }
}

class FakeLedger implements LedgerApi {
  private entries = new Map<string, LedgerEntry>()
  private k(key: EntryKey) { return `${key.lead_key}|${key.population}|${key.kind}` }
  async reserve(body: ReserveBody): Promise<ReserveResult> {
    const counts = { hour_leads: 1, day_leads: 1, hour_spend_cents: body.payout_cents, day_spend_cents: body.payout_cents, et_day: '2027-09-20', hour_bucket: 0 }
    const entry: LedgerEntry = { lead_key: body.lead_key, population: body.population, kind: body.kind, payout_cents: body.payout_cents, status: 'reserved', et_day: '2027-09-20', hour_bucket: 0, reserved_at: NOW, resolved_at: null, mirrored: false, execution_id: body.execution_id, outcome: null, resolution_source: null, resolved_by: null }
    this.entries.set(this.k(body), entry)
    return { reserved: true, repeat: false, entry, counts }
  }
  async commit(key: EntryKey, outcome: SaleOutcomeRecord): Promise<LedgerEntry> {
    const next = { ...this.entries.get(this.k(key))!, status: 'accepted' as const, outcome, resolved_at: NOW }
    this.entries.set(this.k(key), next)
    return next
  }
  async release(key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry> {
    const next = { ...this.entries.get(this.k(key))!, status, resolved_at: NOW }
    this.entries.set(this.k(key), next)
    return next
  }
  async entry(key: EntryKey): Promise<EntryResult> {
    const e = this.entries.get(this.k(key))
    return e ? { found: true, entry: e } : { found: false }
  }
}

/** Runs the real buyer_select node, live, with Tripoint answering `answer`. */
async function buyerSelectOn(answer: Answer, extraction: Record<string, unknown> = LIVE_TRIPOINT.extra_extraction): Promise<BuyerSelectOutput> {
  let clock = NOW
  const response: PartnerCallResult = { status: answer.httpStatus, text: JSON.stringify(answer.body), json: answer.body, isHtml: false, headers: {} }
  const snapshot: BuyerProfilesSnapshot = { org_id: 'org-1', loaded_at: new Date(NOW).toISOString(), content_hash: 'test', served_from: 'database', buyers: [tripointBuyer(extraction)] }
  const deps: BuyerSelectDeps = {
    loadProfiles: async () => snapshot,
    saleClient: () => new FakeSale(),
    wakeSale: async () => undefined,
    ledgerClient: () => new FakeLedger(),
    callBuyer: async () => response,
    breaker: () => ({ check: async () => ({ allowed: true, state: 'closed' }), recordSuccess: async () => undefined, recordError: async () => undefined, releaseProbe: async () => undefined }),
    mirror: async () => undefined,
    logBid: () => undefined,
    clock: () => clock,
    sleep: async (ms) => { clock += ms },
    log: () => undefined,
    writeUnanswered: () => undefined,
    localDev: false,
  }
  const node: NodeDefinition = {
    id: 'bs-1', namespace: 'buyer_select', type: 'buyer_select',
    config: {
      population: 'engine', mode: 'live', lead_key: '{{trigger.payload.leadUuid}}',
      sell_off_when: '{{steps.prospect_trades.output.body.sellOff}}', bid_when_positive: '{{steps.prospect_trades.output.body.engineBid}}',
      state: '{{trigger.payload.personalInformation.state}}', debt: '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}',
      sale_payload: ENGINE_TRIPOINT_SALE_PAYLOAD,
    },
  }
  const ctx = {
    trigger: {
      payload: { leadUuid: 'lead-1', personalInformation: { firstName: 'J', state: 'TX', ssn: '123-45-6789' } },
      source: 'engine', workflow_id: 'wf-engine', trace_id: 'trace-1', org_id: 'org-1', execution_id: 'exec-1', sighting_id: 'sighting-1',
    },
    steps: {
      prospect_trades: { status: 'completed', output: { body: { sellOff: true, engineBid: 0.65, tradeCalculations: { engineDebt: 18250, enrollableDebt: 22100 } } } },
      create_prospect: { status: 'completed', output: { body: { id: '003SF1' } } },
    },
    env: {},
    execution: { workflow_id: 'wf-engine', trace_id: 'trace-1', execution_id: 'exec-1' },
  } as unknown as ExecutionContext
  return (await executeBuyerSelectNode(node, ctx, {} as Env, deps)).output
}

const common = { payload: fixtures.payload, env: fixtures.env, execution: fixtures.execution }
const baseSteps = (): CanvasRun['steps'] => ({
  constants: { output: fixtures.constants },
  prospect_trades: { output: { body: fixtures.prospect_trades_sell_off } },
  create_prospect: { output: { body: fixtures.create_prospect } },
})
const gate = async (steps: CanvasRun['steps']) => (await runCanvasScript(KNOWN_NO_GATE, { ...common, steps })) as Verdict

async function viaTripointPing(answer: Answer): Promise<Verdict> {
  const steps = baseSteps()
  steps.tripoint_ping = { output: await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: answerWith(answer.httpStatus, answer.body) }) }
  return gate(steps)
}
async function viaBuyerSelect(answer: Answer, extraction?: Record<string, unknown>): Promise<{ verdict: Verdict; node: BuyerSelectOutput }> {
  const steps = baseSteps()
  const node = await buyerSelectOn(answer, extraction)
  steps.buyer_select = { output: node }
  return { verdict: await gate(steps), node }
}

const NULL_ID_502: Answer = { httpStatus: 502, body: fixtures.tripoint_null_id_502.body }

// ─── What the node records ───────────────────────────────────────────────────

describe('what buyer_select records for each Tripoint answer under the live rules', () => {
  it.each([
    ['the known invalid data 502', invalid502],
    ['the known null id 502 (synthetic, never captured)', NULL_ID_502],
  ])('%s: no_sale, declined_by_buyer, class Fail, no result code, detail http 502', async (_n, answer) => {
    const node = await buyerSelectOn(answer)
    expect(node).toMatchObject({ _route: 'no_sale', reason: 'declined_by_buyer', detail: 'http 502' })
    expect(node.sale).toMatchObject({ accepted: false, partner_slug: 'tripoint', result_code: null, response_class: 'Fail' })
  })

  it.each([
    ['1002', duplicate1002, 'Duplicate'],
    ['1003', duplicate1003, 'Duplicate'],
    ['1005', duplicate1005, 'Duplicate'],
    ['1009', inProgress1009, 'Fail'],
  ])('a %s is declined_by_buyer with no result code and detail http 200, because extra_extraction names no result_code path', async (_c, answer, cls) => {
    const node = await buyerSelectOn(answer)
    expect(node).toMatchObject({ _route: 'no_sale', reason: 'declined_by_buyer', detail: 'http 200' })
    expect(node.sale).toMatchObject({ result_code: null, response_class: cls })
  })

  it('with a result_code path the node records the code, so a 1009 is told from a 1003', async () => {
    expect((await buyerSelectOn(inProgress1009, WITH_RESULT_CODE_PATH)).sale.result_code).toBe('1009')
    expect((await buyerSelectOn(duplicate1003, WITH_RESULT_CODE_PATH)).sale.result_code).toBe('1003')
  })
})

// ─── The gate on both sides ─────────────────────────────────────────────────

describe('the gate on the same Tripoint answer through tripoint_ping and through buyer_select', () => {
  // [name, answer, tripoint_ping's word, known no, buyer_select answer with the live config, with a result code path]
  const arms: Array<[string, Answer, string, boolean, string, string]> = [
    ['the known invalid data 502', invalid502, 'invalid_data', true, 'declined', 'declined'],
    ['the known null id 502', NULL_ID_502, 'null_id_fault', true, 'declined', 'declined'],
    ['1002 duplicate', duplicate1002, 'declined', true, 'unknown', 'declined'],
    ['1003 duplicate', duplicate1003, 'declined', true, 'unknown', 'declined'],
    ['1005 duplicate', duplicate1005, 'declined', true, 'unknown', 'declined'],
    ['1009 in progress', inProgress1009, 'in_progress', false, 'unknown', 'in_progress'],
  ]

  for (const [name, answer, word, knownNo, liveWord, pathWord] of arms) {
    it(`${name}: tripoint_ping says ${word}, ${knownNo ? '' : 'not '}a known no`, async () => {
      expect(await viaTripointPing(answer)).toEqual({ known_no: knownNo, decided_by: 'tripoint_ping', answer: word })
    })

    it(`${name}: buyer_select with the live config says ${liveWord}, and is a known no only where it can be told from 1009`, async () => {
      const { verdict } = await viaBuyerSelect(answer)
      expect(verdict).toEqual({ known_no: liveWord === 'declined', decided_by: 'buyer_select', answer: liveWord })
      // Never a known no where tripoint_ping would say no: a buyer_select known no is always a tripoint_ping known no.
      if (verdict.known_no) expect(knownNo).toBe(true)
    })

    it(`${name}: buyer_select with a result code path agrees with tripoint_ping exactly`, async () => {
      const { verdict } = await viaBuyerSelect(answer, WITH_RESULT_CODE_PATH)
      expect(verdict).toEqual({ known_no: knownNo, decided_by: 'buyer_select', answer: pathWord })
    })
  }

  it('1001 accepted: neither side is a known no (buyer_select sells, so it decides)', async () => {
    expect((await viaTripointPing(success1001)).known_no).toBe(false)
    const { verdict, node } = await viaBuyerSelect(success1001)
    expect(node._route).toBe('sold')
    expect(verdict).toEqual({ known_no: false, decided_by: 'buyer_select', answer: 'sold' })
  })

  it('an unrecognised 504: tripoint_ping says unknown, buyer_select outcome_unknown, neither a known no', async () => {
    const answer: Answer = { httpStatus: 504, body: { message: 'gateway timeout' } }
    expect(await viaTripointPing(answer)).toEqual({ known_no: false, decided_by: 'tripoint_ping', answer: 'unknown' })
    const { verdict } = await viaBuyerSelect(answer)
    expect(verdict).toEqual({ known_no: false, decided_by: 'buyer_select', answer: 'outcome_unknown' })
  })
})

describe('buyer_select records the gate cannot read as an answer', () => {
  const declined = (sale: Json, detail?: string): Json => ({
    _route: 'no_sale', reason: 'declined_by_buyer', ...(detail ? { detail } : {}), mode_effective: 'live', population: 'engine', considered: [],
    sale: { skipped: false, accepted: false, buyer_reference: null, result_code: null, partner_slug: 'tripoint', partner_name: 'Tripoint', click_url: null, routing_code: null, response_class: 'Fail', ...sale },
  })
  const judge = async (output: Json) => {
    const steps = baseSteps()
    steps.buyer_select = { output }
    return gate(steps)
  }

  it('a decline replayed from an earlier attempt carries no answer (no class) and is not a known no', async () => {
    expect(await judge(declined({ response_class: null }, 'earlier attempt declined'))).toEqual({ known_no: false, decided_by: 'buyer_select', answer: 'unknown' })
  })

  it('a decline with no result code and no detail is not a known no', async () => {
    expect(await judge(declined({}))).toEqual({ known_no: false, decided_by: 'buyer_select', answer: 'unknown' })
  })

  it('another buyer\'s answered decline with no result code is a known no by its own rules', async () => {
    expect(await judge(declined({ partner_slug: 'otherbuyer' }, 'http 200'))).toEqual({ known_no: true, decided_by: 'buyer_select', answer: 'declined' })
  })

  it('another buyer\'s result code 1009 is not Tripoint\'s in progress code', async () => {
    expect(await judge(declined({ partner_slug: 'otherbuyer', result_code: '1009' }, '1009'))).toEqual({ known_no: true, decided_by: 'buyer_select', answer: 'declined' })
  })
})
