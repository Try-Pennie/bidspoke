/**
 * runBuyerSaleAttempt (#1410, milestone 52): the six step attempt the
 * buyer_select node drives for one buyer, against the two objects.
 *
 *   1. claim the lead        (LeadSaleObject)   a timeout is cap_check_error, claim untouched
 *   2. reserve at the buyer  (BuyerLedgerObject) a timeout is cap_check_error, claim freed
 *   3. call the buyer
 *   4. commit                (ledger)           a timeout after an accept is outcome_unknown, everything held, page
 *   5. mark sold             (claim)            the same
 *   6. mirror                (record_buyer_sale) a failure leaves the sale sold and is reported
 *
 * Every object call goes through a client that carries a deadline (L110), so
 * this module sees a DeadlineError rather than a hang. Every answer the claim
 * and the ledger can give is enumerated here (L151, L105): nothing falls
 * through to a default that looks like success.
 *
 * The waiter for a lead another execution holds takes its sleep and clock from
 * `deps`, so a test asserts its schedule instead of living through it (L524).
 */
import type { OutReason, SaleOutcome } from '@bidspoke/buyer-profile'
import type { ClaimBody, ClaimResult, SaleState } from '../durable-objects/lead-sale'
import type { CapLimits, CapReason, Counts, EntryKey, EntryResult, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../durable-objects/buyer-ledger'
import type { LedgerKind, Population } from '@bidspoke/buyer-profile'

// ── The two object surfaces the attempt speaks to ──────────────────────────────

export interface SaleApi {
  claim(body: ClaimBody): Promise<ClaimResult>
  /** Returns the new generation. Throws GenerationMovedError or WrongStateError on a refusal. */
  sold(generation: number, outcome: SaleOutcomeRecord): Promise<number>
  free(generation: number): Promise<number>
  heal(generation: number, outcome: SaleOutcomeRecord): Promise<number>
}

export interface LedgerApi {
  reserve(body: ReserveBody): Promise<ReserveResult>
  commit(key: EntryKey, outcome: SaleOutcomeRecord): Promise<LedgerEntry>
  release(key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry>
  entry(key: EntryKey): Promise<EntryResult>
}

/** The claim refused a mutation because its generation moved; `current` is what it holds now. */
export class GenerationMovedError extends Error {
  readonly current: SaleState
  constructor(current: SaleState) {
    super(`claim generation moved; it is now ${current.state} at generation ${current.generation}`)
    this.name = 'GenerationMovedError'
    this.current = current
  }
}

/** The claim refused a mutation because it is not in a state that allows it. */
export class WrongStateError extends Error {
  readonly current: SaleState
  constructor(current: SaleState) {
    super(`claim is ${current.state}, which does not allow this transition`)
    this.name = 'WrongStateError'
    this.current = current
  }
}

// ── Inputs and outputs ─────────────────────────────────────────────────────────

export interface AttemptInput {
  partner_id: string
  execution_id: string
  lead_key: string
  population: Population
  kind: LedgerKind
  payout_cents: number
  limits: CapLimits
}

export interface BuyerCall {
  outcome: SaleOutcome
  record: SaleOutcomeRecord
}

export type AttemptStep = 'claimed' | 'reserved' | 'buyer_called' | 'committed' | 'marked_sold' | 'mirrored'

export interface AttemptDeps {
  sale: SaleApi
  ledger: LedgerApi
  /** The bounded buyer call. Throwing means the buyer was never reached. */
  callBuyer: () => Promise<BuyerCall>
  /** Writes the ledger entry to buyer_sales. Throwing is reported, not fatal. */
  mirror: (entry: LedgerEntry) => Promise<void>
  clock: () => number
  sleep: (ms: number) => Promise<void>
  /** The whole budget for the buyer call, and so for waiting on another holder. */
  buyerTimeoutMs: number
  /** How often the waiter re-reads a claim another execution holds. */
  waitIntervalMs: number
  /** Called after each step lands. A throw here aborts the attempt like a crash would. */
  onStep?: (step: AttemptStep) => void | Promise<void>
}

export type AttemptResult =
  | { result: 'sold'; outcome: SaleOutcomeRecord; replay: boolean; mirrored: boolean }
  | { result: 'no_sale'; reason: OutReason; detail?: string; page?: boolean }

/** How many times the in_doubt resolution may re-read the claim before giving up. */
const MAX_CLAIM_ROUNDS = 5

export async function runBuyerSaleAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptResult> {
  const startedAt = deps.clock()
  const key: EntryKey = { lead_key: input.lead_key, population: input.population, kind: input.kind }
  const step = async (s: AttemptStep) => { await deps.onStep?.(s) }

  // ── 1. claim ────────────────────────────────────────────────────────────────
  const claimed = await acquireClaim(input, deps, startedAt)
  if (claimed.kind !== 'claimed') return claimed.result
  let generation = claimed.generation
  await step('claimed')

  // ── 2. reserve ──────────────────────────────────────────────────────────────
  let reservation: ReserveResult
  try {
    reservation = await deps.ledger.reserve({ ...key, payout_cents: input.payout_cents, execution_id: input.execution_id, limits: input.limits })
  } catch (err) {
    await freeQuietly(deps, generation)
    return { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) }
  }
  if (!reservation.reserved) {
    await freeQuietly(deps, generation)
    return { result: 'no_sale', reason: reservation.reason, detail: `${countFor(reservation.reason, reservation.counts)} of ${reservation.limit}` }
  }
  if (reservation.repeat) {
    return handleRepeat(input, deps, generation, reservation.entry)
  }
  await step('reserved')

  // ── 3. call the buyer ───────────────────────────────────────────────────────
  let call: BuyerCall
  try {
    call = await deps.callBuyer()
  } catch (err) {
    await deps.ledger.release(key, 'released').catch(() => undefined)
    await freeQuietly(deps, generation)
    return { result: 'no_sale', reason: 'buyer_error', detail: messageOf(err) }
  }
  await step('buyer_called')

  switch (call.outcome) {
    case 'declined_by_buyer':
      await deps.ledger.release(key, 'declined').catch(() => undefined)
      await freeQuietly(deps, generation)
      return { result: 'no_sale', reason: 'declined_by_buyer', detail: call.record.result_code ?? `http ${call.record.http_status}` }
    case 'buyer_error':
      await deps.ledger.release(key, 'released').catch(() => undefined)
      await freeQuietly(deps, generation)
      return { result: 'no_sale', reason: 'buyer_error', detail: call.record.result_code ?? `http ${call.record.http_status}` }
    case 'outcome_unknown':
      // The buyer may have taken the lead: hold the reservation (the alarm makes
      // it unresolved) and the claim (it becomes in_doubt), and page.
      return { result: 'no_sale', reason: 'outcome_unknown', page: true, detail: `buyer answered http ${call.record.http_status} and no rule matched` }
    case 'accepted':
      break
  }

  // ── 4. commit ───────────────────────────────────────────────────────────────
  let entry: LedgerEntry
  try {
    entry = await deps.ledger.commit(key, call.record)
  } catch (err) {
    return { result: 'no_sale', reason: 'outcome_unknown', page: true, detail: messageOf(err) }
  }
  await step('committed')

  // ── 5. mark sold ────────────────────────────────────────────────────────────
  try {
    generation = await deps.sale.sold(generation, call.record)
  } catch (err) {
    return { result: 'no_sale', reason: 'outcome_unknown', page: true, detail: messageOf(err) }
  }
  await step('marked_sold')

  // ── 6. mirror ───────────────────────────────────────────────────────────────
  const mirrored = await mirrorQuietly(deps, entry)
  if (mirrored) await step('mirrored')
  return { result: 'sold', outcome: call.record, replay: false, mirrored }
}

// ── Claim acquisition, including the waiter and the in_doubt resolution ────────

type Acquired =
  | { kind: 'claimed'; generation: number }
  | { kind: 'done'; result: AttemptResult }

async function acquireClaim(input: AttemptInput, deps: AttemptDeps, startedAt: number): Promise<Acquired> {
  const body: ClaimBody = { partner_id: input.partner_id, execution_id: input.execution_id, deadline_ms: deps.buyerTimeoutMs }
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    let claim: ClaimResult
    try {
      claim = await deps.sale.claim(body)
    } catch (err) {
      return { kind: 'done', result: { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) } }
    }
    switch (claim.state) {
      case 'claimed':
        return { kind: 'claimed', generation: claim.generation }
      case 'sold':
        return { kind: 'done', result: { result: 'sold', outcome: claim.outcome, replay: true, mirrored: false } }
      case 'in_flight': {
        const waited = await waitForHolder(deps, body, startedAt, claim)
        if (waited.kind !== 'retry') return waited
        continue
      }
      case 'in_doubt': {
        const resolved = await resolveInDoubt(input, deps, claim)
        if (resolved.kind !== 'retry') return resolved
        continue
      }
    }
  }
  return { kind: 'done', result: { result: 'no_sale', reason: 'cap_check_error', detail: `claim did not settle in ${MAX_CLAIM_ROUNDS} rounds` } }
}

type Next = Acquired | { kind: 'retry' }

/**
 * Another execution holds the lead. Poll the claim on the interval until the
 * holder lands somewhere or the remaining buyer budget is spent (L524: the
 * schedule is what a test asserts).
 */
async function waitForHolder(deps: AttemptDeps, body: ClaimBody, startedAt: number, first: Extract<ClaimResult, { state: 'in_flight' }>): Promise<Next> {
  let current: ClaimResult = first
  while (current.state === 'in_flight') {
    const elapsed = deps.clock() - startedAt
    if (elapsed + deps.waitIntervalMs > deps.buyerTimeoutMs) {
      return {
        kind: 'done',
        result: { result: 'no_sale', reason: 'sale_in_flight', detail: `${current.holder_execution_id} held the lead past the ${deps.buyerTimeoutMs} ms budget` },
      }
    }
    await deps.sleep(deps.waitIntervalMs)
    try {
      current = await deps.sale.claim(body)
    } catch (err) {
      return { kind: 'done', result: { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) } }
    }
  }
  if (current.state === 'claimed') return { kind: 'claimed', generation: current.generation }
  if (current.state === 'sold') return { kind: 'done', result: { result: 'sold', outcome: current.outcome, replay: true, mirrored: false } }
  // in_doubt: hand back to the round loop, which resolves it.
  return { kind: 'retry' }
}

/**
 * The claim is in doubt: an earlier attempt held it past its deadline. Ask that
 * buyer's ledger what it recorded and act by compare and set on the generation
 * we read. Every ledger answer is enumerated (L151, L105).
 */
async function resolveInDoubt(input: AttemptInput, deps: AttemptDeps, claim: Extract<ClaimResult, { state: 'in_doubt' }>): Promise<Next> {
  const key: EntryKey = { lead_key: input.lead_key, population: input.population, kind: input.kind }
  let found: EntryResult
  try {
    found = await deps.ledger.entry(key)
  } catch (err) {
    // Unreadable: keep the claim, refuse. Nothing is known about the lead.
    return { kind: 'done', result: { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) } }
  }
  if (found.found && found.entry.status === 'accepted') {
    const outcome = found.entry.outcome ?? recordFromEntry(found.entry)
    try {
      await deps.sale.heal(claim.generation, outcome)
    } catch (err) {
      if (err instanceof GenerationMovedError || err instanceof WrongStateError) return { kind: 'retry' }
      return { kind: 'done', result: { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) } }
    }
    return { kind: 'done', result: { result: 'sold', outcome, replay: true, mirrored: false } }
  }
  if (found.found && (found.entry.status === 'reserved' || found.entry.status === 'unresolved')) {
    return { kind: 'done', result: { result: 'no_sale', reason: 'outcome_unknown', page: true, detail: `${claim.partner_id} ledger entry is ${found.entry.status}` } }
  }
  // released, declined, or absent (the crash came between the claim and the reserve): free it and try again.
  try {
    await deps.sale.free(claim.generation)
  } catch (err) {
    if (err instanceof GenerationMovedError || err instanceof WrongStateError) return { kind: 'retry' }
    return { kind: 'done', result: { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) } }
  }
  return { kind: 'retry' }
}

/**
 * The ledger already held an entry for this lead at this buyer. What it says
 * decides: an accepted entry is the earlier sale, a pending one is unknown, a
 * closed one is the buyer's earlier answer. The buyer is never called twice.
 */
async function handleRepeat(input: AttemptInput, deps: AttemptDeps, generation: number, entry: LedgerEntry): Promise<AttemptResult> {
  switch (entry.status) {
    case 'accepted': {
      const outcome = entry.outcome ?? recordFromEntry(entry)
      try {
        await deps.sale.sold(generation, outcome)
      } catch (err) {
        if (!(err instanceof GenerationMovedError) && !(err instanceof WrongStateError)) {
          return { result: 'no_sale', reason: 'outcome_unknown', page: true, detail: messageOf(err) }
        }
      }
      return { result: 'sold', outcome, replay: true, mirrored: false }
    }
    case 'reserved':
    case 'unresolved':
      return { result: 'no_sale', reason: 'outcome_unknown', page: true, detail: `${input.partner_id} ledger entry is ${entry.status}` }
    case 'declined':
      await freeQuietly(deps, generation)
      return { result: 'no_sale', reason: 'declined_by_buyer', detail: 'earlier attempt declined' }
    case 'released':
      await freeQuietly(deps, generation)
      return { result: 'no_sale', reason: 'buyer_error', detail: 'earlier attempt released' }
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────────

async function freeQuietly(deps: AttemptDeps, generation: number): Promise<void> {
  // A refusal here means the claim already moved on, which is the state we wanted.
  await deps.sale.free(generation).catch(() => undefined)
}

async function mirrorQuietly(deps: AttemptDeps, entry: LedgerEntry): Promise<boolean> {
  try {
    await deps.mirror(entry)
    return true
  } catch {
    return false
  }
}

function recordFromEntry(entry: LedgerEntry): SaleOutcomeRecord {
  return { buyer_reference: null, result_code: null, http_status: null, payout_cents: entry.payout_cents }
}

function countFor(reason: CapReason, counts: Counts): number {
  switch (reason) {
    case 'hourly_lead_cap': return counts.hour_leads
    case 'daily_lead_cap': return counts.day_leads
    case 'hourly_spend_cap': return counts.hour_spend_cents
    case 'daily_spend_cap': return counts.day_spend_cents
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'non Error thrown'
}
