/**
 * Typed clients for the two buyer selection objects (#1410).
 *
 * Every call carries a deadline (L110) through the shared withDeadline, with
 * injectable timers so a test proves the deadline without waiting (L524). The
 * objects are named by the partner id and the lead key, never a slug (L15).
 * The objects' named refusals become typed errors the attempt branches on;
 * anything else is an ObjectCallError naming the call and the status, so no
 * failure can read as an answer (L11).
 */
import { PACIFIC, withDeadline, zonedParts, type Timers, type LedgerKind, type Population, type SaleStatus } from '@bidspoke/buyer-profile'
import type { AddMemberResult, MembersResult } from '../durable-objects/daily-cap'
import type {
  CapLimits,
  Counts,
  EntryKey,
  EntryResult,
  LedgerEntry,
  ReserveBody,
  ReserveResult,
  SaleOutcomeRecord,
  Summary,
  UnmirroredResult,
} from '../durable-objects/buyer-ledger'
import type { ClaimBody, ClaimResult, SaleState } from '../durable-objects/lead-sale'
import { GenerationMovedError, WrongStateError, type LedgerApi, type SaleApi } from './buyer-sale-attempt'

export type { CapLimits }

/**
 * The worst p99 of one object call the deployed drill has measured (#1428).
 * Measured 2026-09-21 against worker 24889e70 over six drill runs: warm calls
 * about 25 ms, the first call on a new object 160 to 330 ms, and one run with a
 * claim at 1,492 ms and a release past 2,000 ms. Update this from the drill's
 * latency table when a worse figure is seen; the test beside the clients says
 * whether the deadline below still clears it.
 */
export const MEASURED_OBJECT_CALL_P99_MS = 1_492

/**
 * How long one object call may take before it is a DeadlineError (L110). Three
 * times the worst measured p99 and a quarter of the 20 s buyer budget, so a
 * latency spike on the objects does not read as a false cap_check_error while
 * a hung object still cannot eat the attempt (#1428).
 */
export const OBJECT_CALL_DEADLINE_MS = 5_000

export interface ClientOptions {
  /**
   * How long one call may take. A function is read at EVERY call and told which
   * operation is asking, so a caller spending one budget across several calls
   * hands in what is left of it, each later call is bounded more tightly than
   * the one before (#1491), and a cleanup call after the budget has ended can be
   * given a real deadline instead of the spent budget's floor (#1512). A number
   * is the same bound on every call.
   */
  deadlineMs?: number | ((operation: string) => number)
  timers?: Timers
}

/** The operation names a cleanup after an abandoned attempt uses; a caller exempts these from its budget (#1512). */
export const SALE_FREE_OP = 'lead sale free'
export const LEDGER_RELEASE_OP = 'buyer ledger release'

function deadlineOf(opts: ClientOptions, op: string): number {
  const d = opts.deadlineMs
  if (d === undefined) return OBJECT_CALL_DEADLINE_MS
  return typeof d === 'function' ? Math.max(1, d(op)) : d
}

/** An object answered with a status the client does not know how to read. */
export class ObjectCallError extends Error {
  readonly status: number
  readonly body: string
  constructor(op: string, status: number, body: string) {
    super(`${op} answered ${status}: ${body}`)
    this.name = 'ObjectCallError'
    this.status = status
    this.body = body
  }
}

type Refusal = (body: unknown) => Error | null

async function call<T>(stub: DurableObjectStub, op: string, url: string, init: RequestInit | undefined, opts: ClientOptions, refusal?: Refusal): Promise<T> {
  const res = await withDeadline(stub.fetch(url, init), deadlineOf(opts, op), op, opts.timers)
  if (res.ok) return res.json<T>()
  const text = await res.text()
  if (res.status === 409 && refusal) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const mapped = parsed === null ? null : refusal(parsed)
    if (mapped) throw mapped
  }
  throw new ObjectCallError(op, res.status, text)
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function query(path: string, params: Record<string, string>): string {
  const url = new URL(`http://do${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

// ── LeadSaleObject ─────────────────────────────────────────────────────────────

export interface LeadSaleKey {
  kind: LedgerKind
  population: Population
  lead_key: string
}

/**
 * The click claim's kind (#1542). Deliberately NOT a ledger kind: a click sold
 * buyer is paid per click, has no reservation in the ledger, and its claim is
 * keyed by the buyer and the prospect rather than a population and a lead, so
 * a click claim can never share an object with a sale.
 */
export const CLICK_CLAIM_KIND = 'click'

/** One claim per buyer per prospect: a second click on the same prospect for the same buyer finds it. */
export interface ClickClaimKey {
  kind: typeof CLICK_CLAIM_KIND
  partner_slug: string
  prospect_id: string
}

export function leadSaleObjectName(key: LeadSaleKey | ClickClaimKey): string {
  if (key.kind === CLICK_CLAIM_KIND) return `sale:${CLICK_CLAIM_KIND}:${key.partner_slug}:${key.prospect_id}`
  return `sale:${key.kind}:${key.population}:${key.lead_key}`
}

const claimRefusal: Refusal = (body) => {
  const b = body as { error?: unknown; current?: SaleState }
  if (b.error === 'generation_moved' && b.current) return new GenerationMovedError(b.current)
  if (b.error === 'wrong_state' && b.current) return new WrongStateError(b.current)
  return null
}

export class LeadSaleClient implements SaleApi {
  private readonly stub: DurableObjectStub
  constructor(ns: DurableObjectNamespace, key: LeadSaleKey | ClickClaimKey, private readonly opts: ClientOptions = {}) {
    this.stub = ns.get(ns.idFromName(leadSaleObjectName(key)))
  }

  claim(body: ClaimBody): Promise<ClaimResult> {
    return call<ClaimResult>(this.stub, 'lead sale claim', 'http://do/claim', postJson(body), this.opts)
  }

  async sold(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    const r = await call<{ generation: number }>(this.stub, 'lead sale sold', 'http://do/sold', postJson({ generation, outcome }), this.opts, claimRefusal)
    return r.generation
  }

  async free(generation: number): Promise<number> {
    const r = await call<{ generation: number }>(this.stub, SALE_FREE_OP, 'http://do/free', postJson({ generation }), this.opts, claimRefusal)
    return r.generation
  }

  async heal(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    const r = await call<{ generation: number }>(this.stub, 'lead sale heal', 'http://do/heal', postJson({ generation, outcome }), this.opts, claimRefusal)
    return r.generation
  }

  read(): Promise<SaleState> {
    return call<SaleState>(this.stub, 'lead sale read', 'http://do/read', undefined, this.opts)
  }
}

// ── The click counter (a DailyCapObject) ───────────────────────────────────────

/**
 * The one derivation of a click sold buyer's counter name (#1542):
 * `clicks-{slug}-{YYYY-MM-DD}` on the PACIFIC date, so the count resets at
 * midnight Pacific (Dan). Clicks arrive after offers, so an Eastern day would
 * move a late evening click into the next day's count. The date comes back with
 * the name so a caller can say which day it counted (L589).
 */
export function clickCounterObjectName(slug: string, nowMs: number): { name: string; date: string } {
  const { date } = zonedParts(nowMs, PACIFIC)
  return { name: `clicks-${slug}-${date}`, date }
}

function isAddMemberResult(v: unknown): v is AddMemberResult {
  const r = v as AddMemberResult | null
  return r !== null && typeof r === 'object' && typeof r.added === 'boolean' && typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0
}

/** The day's distinct set of prospects a click sold buyer was sent, one object per buyer per Pacific day. */
export class ClickCounterClient {
  private readonly stub: DurableObjectStub
  readonly name: string
  readonly date: string
  constructor(ns: DurableObjectNamespace, slug: string, nowMs: number, private readonly opts: ClientOptions = {}) {
    const n = clickCounterObjectName(slug, nowMs)
    this.name = n.name
    this.date = n.date
    this.stub = ns.get(ns.idFromName(n.name))
  }

  /** Adds the member once; a repeat answers added false with the unchanged count. */
  async addMember(member: string): Promise<AddMemberResult> {
    const r = await call<unknown>(this.stub, 'click counter add', 'http://do/add-member', postJson({ member }), this.opts)
    if (!isAddMemberResult(r)) throw new Error(`click counter add answered an unreadable body: ${JSON.stringify(r)}`)
    return r
  }

  members(): Promise<MembersResult> {
    return call<MembersResult>(this.stub, 'click counter members', 'http://do/members', undefined, this.opts)
  }
}

// ── BuyerLedgerObject ──────────────────────────────────────────────────────────

export function buyerLedgerObjectName(partnerId: string): string {
  return `buyer:${partnerId}`
}

export class BuyerLedgerClient implements LedgerApi {
  private readonly stub: DurableObjectStub
  constructor(ns: DurableObjectNamespace, partnerId: string, private readonly opts: ClientOptions = {}) {
    this.stub = ns.get(ns.idFromName(buyerLedgerObjectName(partnerId)))
  }

  reserve(body: ReserveBody): Promise<ReserveResult> {
    return call<ReserveResult>(this.stub, 'buyer ledger reserve', 'http://do/reserve', postJson(body), this.opts)
  }

  async commit(key: EntryKey, outcome: SaleOutcomeRecord): Promise<LedgerEntry> {
    const r = await call<{ entry: LedgerEntry }>(this.stub, 'buyer ledger commit', 'http://do/commit', postJson({ ...key, outcome }), this.opts)
    return r.entry
  }

  async release(key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry> {
    const r = await call<{ entry: LedgerEntry }>(this.stub, LEDGER_RELEASE_OP, 'http://do/release', postJson({ ...key, status }), this.opts)
    return r.entry
  }

  /** A person's settlement; `resolvedBy` is their user id, kept on the entry for the mirror (#1412). */
  async settle(key: EntryKey, status: Extract<SaleStatus, 'accepted' | 'declined' | 'released'>, outcome?: SaleOutcomeRecord, resolvedBy?: string): Promise<LedgerEntry> {
    const r = await call<{ entry: LedgerEntry }>(this.stub, 'buyer ledger settle', 'http://do/settle', postJson({ ...key, status, outcome, resolved_by: resolvedBy }), this.opts)
    return r.entry
  }

  entry(key: EntryKey): Promise<EntryResult> {
    return call<EntryResult>(this.stub, 'buyer ledger entry', query('/entry', { ...key }), undefined, this.opts)
  }

  peek(kind: LedgerKind): Promise<Counts> {
    return call<Counts>(this.stub, 'buyer ledger peek', query('/peek', { kind }), undefined, this.opts)
  }

  summary(kind: LedgerKind, day?: string): Promise<Summary> {
    return call<Summary>(this.stub, 'buyer ledger summary', query('/summary', day ? { kind, day } : { kind }), undefined, this.opts)
  }

  /** Every entry of one kind for one Eastern day, for the sales checks (#1413). */
  async entries(kind: LedgerKind, day: string): Promise<LedgerEntry[]> {
    const r = await call<{ entries: LedgerEntry[] }>(this.stub, 'buyer ledger entries', query('/entries', { kind, day }), undefined, this.opts)
    return r.entries
  }

  unmirrored(): Promise<UnmirroredResult> {
    return call<UnmirroredResult>(this.stub, 'buyer ledger unmirrored', 'http://do/unmirrored', undefined, this.opts)
  }

  async unresolved(): Promise<LedgerEntry[]> {
    const r = await call<{ entries: LedgerEntry[] }>(this.stub, 'buyer ledger unresolved', 'http://do/unresolved', undefined, this.opts)
    return r.entries
  }

  async markMirrored(keys: EntryKey[]): Promise<number> {
    const r = await call<{ marked: number }>(this.stub, 'buyer ledger mark-mirrored', 'http://do/mark-mirrored', postJson({ keys }), this.opts)
    return r.marked
  }
}
