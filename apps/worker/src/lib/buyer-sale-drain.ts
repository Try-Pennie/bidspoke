/**
 * The minute drain of the buyer ledgers into buyer_sales (#1413, Phase 6).
 *
 * The ledger is the outbox. After every state change the node (or the settle
 * route) copies the entry to buyer_sales inline and marks it mirrored only when
 * the returned row is the one it sent; a copy that fails, or a state that
 * changed since the last copy, leaves the entry unmirrored. This job asks every
 * buyer's ledger for those entries once a minute and delivers them through the
 * SAME write (record_buyer_sale, upsert on a row id derived from the entry's
 * key), so a Supabase outage never stops selling and never loses a row (L33,
 * L258, L15).
 *
 * The row's pricing and provenance (workflow, trace, debt, multiplier) live in
 * the attempt that reserved the entry, not in the ledger, so a re-delivered row
 * takes them from the copy the inline mirror already wrote, and a row that was
 * never copied carries explicit nulls for them (L705). The upsert leaves those
 * columns alone on conflict, so a null here can never blank a stored value.
 *
 * Pages, once per job through the shared export alerter so it is muted by the
 * same keys as every other job: a buyer whose oldest uncopied entry is older
 * than OUTBOX_BACKLOG_MS (five ticks), naming the buyer and the last error
 * (L13); a ledger that could not be read, as unmeasured rather than as empty
 * (L98, L215); and a buyer list that could not be read, as a failed run rather
 * than an empty one. An empty page list clears the standing condition.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapLimits, EntryKey, LedgerEntry, UnmirroredResult } from '../durable-objects/buyer-ledger'
import type { Env } from '../index'
import { BuyerLedgerClient } from './buyer-object-clients'
import { buildBuyerSaleRow, buyerSaleRowId, mirrorBuyerSale, type BuyerSaleRowMeta } from './buyer-sale-mirror'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { describeDuration } from './slack'

export const BUYER_SALE_DRAIN_JOB = 'buyer-sale-drain'

/** Five ticks of the minute cron: a backlog older than this is a standing failure, not a blip. */
export const OUTBOX_BACKLOG_MS = 5 * 60 * 1000

export const BUYER_SALE_DRAIN_REMEDY: AlertRemedy = {
  consequence:
    'Buyer ledger entries are not reaching the buyer_sales table, so the partner page, the unresolved list and ' +
    'the sales checks are reading an incomplete copy. Selling itself is unaffected: the ledger, not the table, decides caps. ' +
    'The lines below name each buyer and the last error the copy hit:',
  fixHint:
    'Read the error on each line. A database error (connection, statement timeout, a refused constraint) is the copy ' +
    'failing; fix that and the next minute delivers the backlog on its own, nothing needs re-running. A ledger that ' +
    'could not be read is the Durable Object refusing; check the worker logs for the buyer ledger and the drill at ' +
    'POST /api/admin/buyer-objects/drill.',
  headlineVerb: 'has a backlog',
  itemNoun: { one: 'buyer', many: 'buyers' },
}

export interface DrainBuyer {
  partner_id: string
  organization_id: string
  slug: string
}

/** The two ledger calls the drain makes. */
export interface DrainLedger {
  unmirrored(): Promise<UnmirroredResult>
  markMirrored(keys: EntryKey[]): Promise<number>
}

/** The columns of an existing buyer_sales row that the ledger does not hold. */
export interface ExistingRowMeta {
  workflow_id: string | null
  trace_id: string | null
  debt: number | null
  multiplier: number | null
  live_percent_in_force: number | null
  caps_in_force: CapLimits | null
}

export interface DrainDeps {
  listBuyers(): Promise<DrainBuyer[]>
  ledger(partnerId: string): DrainLedger
  readExistingRows(ids: string[]): Promise<Map<string, ExistingRowMeta>>
  supabase: SupabaseClient
  /** Receives the page lines; an empty list clears the standing condition. */
  notify(lines: string[]): Promise<void>
  now(): number
  localDev: boolean
  log(line: string): void
}

export interface DrainBuyerSummary {
  partner_id: string
  slug: string
  pending: number
  delivered: number
  failed: number
  oldest_age_ms: number | null
  /** The age of the oldest entry still undelivered after this tick; null when nothing is left. */
  remaining_oldest_age_ms: number | null
  /** Set when the ledger could not be read; the counts above are then meaningless and zero. */
  unmeasured?: string
}

export interface DrainSummary {
  skipped?: 'local_dev'
  /** Set when the buyer list could not be read, so no ledger was asked. */
  unmeasured?: string
  buyers: DrainBuyerSummary[]
  /** The lines paged this tick, one per buyer with a standing problem. Empty is the all clear. */
  paged: string[]
  errors: string[]
}

const NO_META: ExistingRowMeta = { workflow_id: null, trace_id: null, debt: null, multiplier: null, live_percent_in_force: null, caps_in_force: null }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'non Error thrown')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export async function runBuyerSaleDrain(deps: DrainDeps): Promise<DrainSummary> {
  if (deps.localDev) {
    deps.log(`[${BUYER_SALE_DRAIN_JOB}] skipped: local dev must not write buyer_sales in production (#669)`)
    return { skipped: 'local_dev', buyers: [], paged: [], errors: [] }
  }

  let buyers: DrainBuyer[]
  try {
    buyers = await deps.listBuyers()
  } catch (err) {
    const reason = `the buyer list could not be read, so no ledger was drained: ${messageOf(err)}`
    await deps.notify([reason])
    return { unmeasured: reason, buyers: [], paged: [reason], errors: [reason] }
  }

  const summaries: DrainBuyerSummary[] = []
  const paged: string[] = []
  const errors: string[] = []

  for (const buyer of buyers) {
    const summary = await drainBuyer(deps, buyer, errors)
    summaries.push(summary)
    if (summary.unmeasured) {
      paged.push(`${buyer.slug}: the buyer ledger could not be read, so its backlog is unmeasured (${summary.unmeasured})`)
    } else if (summary.remaining_oldest_age_ms !== null && summary.remaining_oldest_age_ms > OUTBOX_BACKLOG_MS) {
      // The page is about what is LEFT after this tick's attempts, so it is
      // judged on the oldest entry still undelivered, never on the age the
      // ledger reported before delivery.
      const lastError = errors.filter((e) => e.startsWith(`${buyer.slug}:`)).at(-1)
      paged.push(
        `${buyer.slug}: ${plural(summary.pending - summary.delivered, 'entry', 'entries')} not yet copied to buyer_sales, ` +
          `oldest ${describeDuration(summary.remaining_oldest_age_ms) ?? `${summary.remaining_oldest_age_ms} ms`} old` +
          (lastError ? `; last error: ${lastError.slice(buyer.slug.length + 2)}` : ''),
      )
    }
  }

  await deps.notify(paged)
  return { buyers: summaries, paged, errors }
}

async function drainBuyer(deps: DrainDeps, buyer: DrainBuyer, errors: string[]): Promise<DrainBuyerSummary> {
  const ledger = deps.ledger(buyer.partner_id)
  const base: DrainBuyerSummary = { partner_id: buyer.partner_id, slug: buyer.slug, pending: 0, delivered: 0, failed: 0, oldest_age_ms: null, remaining_oldest_age_ms: null }
  const now = deps.now()
  let oldestRemaining: number | null = null
  const leave = (entry: LedgerEntry) => { if (oldestRemaining === null || entry.reserved_at < oldestRemaining) oldestRemaining = entry.reserved_at }

  let outbox: UnmirroredResult
  try {
    outbox = await ledger.unmirrored()
  } catch (err) {
    const reason = messageOf(err)
    errors.push(`${buyer.slug}: ledger unreadable: ${reason}`)
    return { ...base, unmeasured: reason }
  }
  base.pending = outbox.entries.length
  base.oldest_age_ms = outbox.oldest_age_ms
  if (outbox.entries.length === 0) return base

  const ids = await Promise.all(outbox.entries.map((e) => buyerSaleRowId(buyer.partner_id, e)))
  let existing: Map<string, ExistingRowMeta>
  try {
    existing = await deps.readExistingRows(ids)
  } catch (err) {
    // Without the earlier copy a never-copied row would be blanked of nothing (the
    // upsert leaves those columns alone), but a first copy would lose its pricing
    // for good, so the tick waits rather than writing nulls it cannot justify.
    const reason = messageOf(err)
    errors.push(`${buyer.slug}: existing buyer_sales rows unreadable, nothing delivered this tick: ${reason}`)
    for (const entry of outbox.entries) leave(entry)
    return { ...base, failed: outbox.entries.length, remaining_oldest_age_ms: oldestRemaining === null ? null : now - oldestRemaining }
  }

  for (let i = 0; i < outbox.entries.length; i++) {
    const entry: LedgerEntry = outbox.entries[i]
    const meta: BuyerSaleRowMeta = { partner_id: buyer.partner_id, organization_id: buyer.organization_id, ...(existing.get(ids[i]) ?? NO_META) }
    try {
      const row = await buildBuyerSaleRow(entry, meta)
      await mirrorBuyerSale(deps.supabase, row, entry, { markMirrored: (key) => ledger.markMirrored([key]).then(() => undefined) })
      base.delivered += 1
    } catch (err) {
      base.failed += 1
      leave(entry)
      errors.push(`${buyer.slug}: ${entry.lead_key} (${entry.status}): ${messageOf(err)}`)
    }
  }
  base.remaining_oldest_age_ms = oldestRemaining === null ? null : now - oldestRemaining
  return base
}

// ── Production wiring ─────────────────────────────────────────────────────────

interface ExistingRowRecord {
  id: string
  workflow_id: string | null
  trace_id: string | null
  debt: number | string | null
  multiplier: number | string | null
  live_percent_in_force: number | null
  caps_in_force: CapLimits | null
}

/**
 * A numeric column comes back as a string from PostgREST. A value that does not
 * parse is null, never NaN, so it cannot ride into the row as a number that
 * compares false against everything (L50).
 */
export function numericOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const num = numericOrNull

export function productionDrainDeps(supabase: SupabaseClient, env: Env): DrainDeps {
  return {
    listBuyers: async () => {
      // Every partner with a buyer profile, enabled or not: a disabled buyer can
      // still hold entries from before it was disabled.
      const { data, error } = await supabase
        .from('buyer_profiles')
        .select('partner_id, partner_configs!inner(organization_id, slug)')
      if (error) throw new Error(`buyer_profiles: ${error.message}`)
      return ((data ?? []) as unknown as Array<{ partner_id: string; partner_configs: { organization_id: string; slug: string } }>).map((r) => ({
        partner_id: r.partner_id,
        organization_id: r.partner_configs.organization_id,
        slug: r.partner_configs.slug,
      }))
    },
    ledger: (partnerId) => new BuyerLedgerClient(env.BUYER_LEDGER, partnerId),
    readExistingRows: async (ids) => {
      if (ids.length === 0) return new Map()
      const { data, error } = await supabase
        .from('buyer_sales')
        .select('id, workflow_id, trace_id, debt, multiplier, live_percent_in_force, caps_in_force')
        .in('id', ids)
      if (error) throw new Error(`buyer_sales: ${error.message}`)
      const out = new Map<string, ExistingRowMeta>()
      for (const r of (data ?? []) as unknown as ExistingRowRecord[]) {
        out.set(r.id, { workflow_id: r.workflow_id, trace_id: r.trace_id, debt: num(r.debt), multiplier: num(r.multiplier), live_percent_in_force: r.live_percent_in_force, caps_in_force: r.caps_in_force })
      }
      return out
    },
    supabase,
    notify: (lines) => notifyExportFailure(supabase, BUYER_SALE_DRAIN_JOB, lines, env.IDEMPOTENCY, BUYER_SALE_DRAIN_REMEDY),
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    log: (line) => console.log(line),
  }
}

export function runBuyerSaleDrainForEnv(supabase: SupabaseClient, env: Env): Promise<DrainSummary> {
  return runBuyerSaleDrain(productionDrainDeps(supabase, env))
}
