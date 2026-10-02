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
import { isPartnerId, PACIFIC, withDeadline, zonedParts, type Timers, type LedgerKind, type Population, type SaleStatus } from '@bidspoke/buyer-profile'
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

/**
 * One claim per buyer per prospect: a second click on the same prospect for the
 * same buyer finds it. Keyed on the partner_configs id, never the slug (#1553,
 * L15), so renaming a buyer's slug keeps every claim it holds.
 */
export interface ClickClaimKey {
  kind: typeof CLICK_CLAIM_KIND
  partner_id: string
  prospect_id: string
}

/** The one partner id rule, shared with save validation through the package (#1543). */
export { isPartnerId }

/**
 * Refuses to name a click object by anything but a partner id (#1553): a slug
 * passed where the id belongs would silently open a different, empty object.
 */
function assertPartnerId(value: string, what: string): void {
  if (!isPartnerId(value)) throw new Error(`${what}: ${JSON.stringify(value)} is not a partner id`)
}

export function leadSaleObjectName(key: LeadSaleKey | ClickClaimKey): string {
  if (key.kind === CLICK_CLAIM_KIND) {
    assertPartnerId(key.partner_id, 'click claim name')
    return `sale:${CLICK_CLAIM_KIND}:${key.partner_id}:${key.prospect_id}`
  }
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
 * `clicks-{partner_id}-{YYYY-MM-DD}` on the PACIFIC date, keyed on the
 * partner_configs id so a slug rename keeps the day's count (#1553, L15), so the count resets at
 * midnight Pacific (Dan). Clicks arrive after offers, so an Eastern day would
 * move a late evening click into the next day's count. The date comes back with
 * the name so a caller can say which day it counted (L589).
 */
export function clickCounterObjectName(partnerId: string, nowMs: number): { name: string; date: string } {
  assertPartnerId(partnerId, 'click counter name')
  const { date } = zonedParts(nowMs, PACIFIC)
  return { name: `clicks-${partnerId}-${date}`, date }
}

function isAddMemberResult(v: unknown): v is AddMemberResult {
  const r = v as AddMemberResult | null
  return r !== null && typeof r === 'object' && typeof r.added === 'boolean' && typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'non Error thrown')

/**
 * The saved copy of a buyer's click count for one Pacific day (#1632), in the
 * worker's KV store. The offer check reads it instead of the object, because
 * reaching one object from wherever Engine's request lands took 130 to 760 ms
 * on 2026-09-29 while the object itself answered in 5. The object stays the
 * truth, but nothing downstream refuses a click past the cap: buyer_click_send
 * sends it, counts it and pages over the cap. So a copy that lags (KV takes up
 * to a minute to reach every data centre, and accepts about one write a second
 * to a key) can let a few clicks past the cap be offered and sold. Dan accepted
 * that on 2026-09-29 for a fast check all day. To keep the lag short, a write
 * only ever raises the copy, so two adds landing out of order cannot lower it.
 */
export function clickCountCopyKey(partnerId: string, date: string): string {
  return `click-count:${partnerId}:${date}`
}

/** Kept past the Pacific day it counts, then left to expire; nothing reads another day's key. */
export const CLICK_COUNT_COPY_TTL_S = 3 * 24 * 60 * 60

/**
 * The copy's read and write together, bounded so a slow store cannot spend the
 * deadline buyer_click_send and the held click release size for the add itself.
 */
export const CLICK_COUNT_COPY_WRITE_DEADLINE_MS = 500

/**
 * The day's distinct set of prospects a click sold buyer was sent, one object
 * per buyer per Pacific day, and its saved copy. The copy store is a required
 * argument rather than an option, so no caller can add a click without the copy
 * following (L621): a forgotten copy would leave the offer check trusting a
 * count that never moves.
 */
export class ClickCounterClient {
  private readonly stub: DurableObjectStub
  private readonly copyKey: string
  readonly name: string
  readonly date: string
  constructor(ns: DurableObjectNamespace, private readonly copyStore: KVNamespace, partnerId: string, nowMs: number, private readonly opts: ClientOptions = {}) {
    const n = clickCounterObjectName(partnerId, nowMs)
    this.name = n.name
    this.date = n.date
    this.copyKey = clickCountCopyKey(partnerId, n.date)
    this.stub = ns.get(ns.idFromName(n.name))
  }

  /**
   * Adds the member once; a repeat answers added false with the unchanged count.
   * Then writes the count the object answered to the copy. A copy that fails to
   * write never fails the add, because the click was counted; it is logged, and
   * the next offer check reads the object while the copy is missing.
   */
  async addMember(member: string): Promise<AddMemberResult> {
    const r = await call<unknown>(this.stub, 'click counter add', 'http://do/add-member', postJson({ member }), this.opts)
    if (!isAddMemberResult(r)) throw new Error(`click counter add answered an unreadable body: ${JSON.stringify(r)}`)
    await this.writeCopy(r.count)
    return r
  }

  /** The saved count, or null when there is none or it is not a whole number: null is never zero clicks. */
  async copyCount(): Promise<number | null> {
    const raw = await this.copyStore.get(this.copyKey)
    if (raw === null || !/^\d+$/.test(raw)) return null
    return Number(raw)
  }

  /** Writes a count the object answered, so the first check of a day seeds the copy for the rest; never lowers it. */
  seedCopy(count: number): Promise<void> {
    return this.writeCopy(count)
  }

  /**
   * Raises the copy to `count`, never lowers it. KV has no compare and set, so
   * two writers can still race between the read and the put; the window is the
   * read's few milliseconds rather than the whole add. Never rejects.
   */
  private async writeCopy(count: number): Promise<void> {
    try {
      await withDeadline((async () => {
        const stored = await this.copyCount().catch((err: unknown) => {
          console.error(`[click-counter] the saved copy ${this.copyKey} could not be read before saving: ${messageOf(err)}`)
          return null
        })
        if (stored !== null && stored >= count) return
        await this.copyStore.put(this.copyKey, String(count), { expirationTtl: CLICK_COUNT_COPY_TTL_S })
      })(), CLICK_COUNT_COPY_WRITE_DEADLINE_MS, 'click count copy', this.opts.timers)
    } catch (err) {
      console.error(`[click-counter] the saved copy ${this.copyKey} could not be written: ${messageOf(err)}`)
    }
  }

  members(): Promise<MembersResult> {
    return call<MembersResult>(this.stub, 'click counter members', 'http://do/members', undefined, this.opts)
  }

  /** The day's distinct count, a pure read that adds nothing (#1543). An unreadable answer throws, never reads as zero. */
  async memberCount(): Promise<number> {
    const r = await call<unknown>(this.stub, 'click counter count', 'http://do/member-count', undefined, this.opts)
    const count = (r as { count?: unknown } | null)?.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error(`click counter count answered an unreadable body: ${JSON.stringify(r)}`)
    return count
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

  async release(key: EntryKey, status: 'declined' | 'released', outcome?: SaleOutcomeRecord): Promise<LedgerEntry> {
    const r = await call<{ entry: LedgerEntry }>(this.stub, LEDGER_RELEASE_OP, 'http://do/release', postJson({ ...key, status, ...(outcome ? { outcome } : {}) }), this.opts)
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
