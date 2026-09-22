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
import { withDeadline, type Timers, type LedgerKind, type Population, type SaleStatus } from '@bidspoke/buyer-profile'
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
  deadlineMs?: number
  timers?: Timers
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
  const res = await withDeadline(stub.fetch(url, init), opts.deadlineMs ?? OBJECT_CALL_DEADLINE_MS, op, opts.timers)
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

export function leadSaleObjectName(key: LeadSaleKey): string {
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
  constructor(ns: DurableObjectNamespace, key: LeadSaleKey, private readonly opts: ClientOptions = {}) {
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
    const r = await call<{ generation: number }>(this.stub, 'lead sale free', 'http://do/free', postJson({ generation }), this.opts, claimRefusal)
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
    const r = await call<{ entry: LedgerEntry }>(this.stub, 'buyer ledger release', 'http://do/release', postJson({ ...key, status }), this.opts)
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
