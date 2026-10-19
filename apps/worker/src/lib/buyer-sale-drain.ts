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
 * (L13); a ledger that has been unreadable for OUTBOX_BACKLOG_MS, as unmeasured
 * rather than as empty (L98, L215); and a buyer list that could not be read, as
 * a failed run rather than an empty one. An empty page list clears the standing
 * condition.
 *
 * A ledger read that got no answer (a deadline or a call lost in transit) is
 * asked once more on a fresh stub before the ledger counts as unreadable, and an
 * unreadable ledger pages on how long it has been unreadable, never on how many
 * runs saw it (#1895). On 2026-10-08 two runs 24 seconds apart each lost one
 * call while the object answered every lead call around them, and the old rule,
 * two failed runs in a row, paged for it because the cron was firing twice a
 * minute.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapLimits, LedgerEntry, MarkMirroredResult, MirroredStamp, UnmirroredResult } from '../durable-objects/buyer-ledger'
import type { Env } from '../index'
import { BuyerLedgerClient, gotNoAnswer, LEDGER_UNMIRRORED_OP, MEASURED_OBJECT_CALL_P99_MS, OBJECT_CALL_DEADLINE_MS, type ClientOptions } from './buyer-object-clients'
import { chunk } from './chunk'
import { buildBuyerSaleRow, buyerSaleRowId, mirrorBuyerSale, type BuyerSaleRowMeta } from './buyer-sale-mirror'
import { notifyExportFailure, type TitledRemedy } from './export-alerts'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { describeDuration } from './incident-span'
import { etTime } from './slack'

export const BUYER_SALE_DRAIN_JOB = 'buyer-sale-drain'

/** Delivered row ids kept per buyer in a tick's run record, so one long backlog cannot make a huge row (#1810). */
export const RUN_RECORD_ROW_IDS = 50

/** Errors named in a tick's run record detail; the rest are counted. */
const RUN_RECORD_ERRORS = 5

/**
 * Five ticks of the minute cron: a backlog older than this is a standing failure, not a blip.
 * A ledger unreadable for this long pages too (#1895), because this is the
 * earliest a backlog behind it could have paged had the ledger been readable.
 */
export const OUTBOX_BACKLOG_MS = 5 * 60 * 1000

/**
 * The minute cron's interval (#1895). The drain had no budget of its own beyond
 * each object call's deadline, so a second ask of a ledger is given only what is
 * left of the minute the run started in, and none when less than one measured
 * worst call is left. A retry therefore never carries a run's reads into the
 * next run's minute.
 */
export const DRAIN_TICK_MS = 60_000

/**
 * Where the drain keeps, by partner id, the moment each ledger was first found
 * unreadable with no good read since (#1895). A run that finds a ledger
 * unreadable adds it if absent; a run that reads it removes it; a buyer no longer
 * listed is dropped. KV can take up to a minute to show a write to a run in
 * another data centre, so a run can miss the moment and set a later one: the
 * page can then come a minute or two past the limit, never early.
 */
export const UNREADABLE_SINCE_KEY = 'buyer-sale-drain:unreadable-since'

/**
 * Refreshed by every run that finds a ledger unreadable, so it lapses only when
 * the drain itself stops running for a day. A run after that starts the clock
 * again rather than paging on a moment whose stretch nobody watched.
 */
const UNREADABLE_SINCE_TTL_S = 24 * 60 * 60

const UNLISTED_KEY = 'buyers-unlisted'

/** What every drain page says under its findings (Dan, 2026-10-01: plain title, full sentences, one fix line). */
const SELLING_UNAFFECTED =
  'Selling is not affected, because the ledger decides caps. The partner page and the sales checks read the sales table, so they may be behind until it catches up.'
/**
 * Said only where the ledger itself could not be read (#835): every sale to the
 * buyer reserves its cap slot through that same ledger, so "selling is not
 * affected" is not something this check measured there.
 */
const LEDGER_DOWN =
  'Every sale to that buyer reserves its cap slot through this ledger, so its sales may be failing too, and its sales table copy cannot catch up until the ledger answers.'
const BACKLOG_FIX = 'Read the last error on each line. A database error clears on its own: once the database answers, the next minute copies everything waiting.'
/**
 * The drill exercises a throwaway drill buyer's ledger, never this buyer's, so
 * it cannot say whether this one answers (#835). The partner page's usage panel
 * reads this buyer's own ledger.
 */
const LEDGER_FIX =
  "Check the worker logs for that buyer's ledger. The buyer's partner page reads the same ledger for its usage counts, so counts there mean it answers again."

export const BUYER_SALE_DRAIN_BACKLOG_REMEDY: TitledRemedy = {
  title: 'Buyer sales are not reaching the sales table',
  context: SELLING_UNAFFECTED,
  fixHint: BACKLOG_FIX,
}

export const BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY: TitledRemedy = {
  title: "A buyer ledger can't be read",
  context: LEDGER_DOWN,
  fixHint: LEDGER_FIX,
}

export const BUYER_SALE_DRAIN_MIXED_REMEDY: TitledRemedy = {
  title: "Buyer sales are behind, and a buyer ledger can't be read",
  context: `For the buyer whose ledger can't be read: ${LEDGER_DOWN.charAt(0).toLowerCase()}${LEDGER_DOWN.slice(1)}`,
  fixHint: `${BACKLOG_FIX} ${LEDGER_FIX}`,
}

/**
 * The row reached the sales table and only the ledger's note that it had was
 * refused (#835), so the sales table is not behind for it; the ledger hands it
 * back every minute until the note lands.
 */
export const BUYER_SALE_DRAIN_UNMARKED_REMEDY: TitledRemedy = {
  title: "A buyer ledger isn't recording its sales as copied",
  context: 'These sales are already in the sales table. The ledger keeps offering them to be copied again each minute until it records them.',
  fixHint: LEDGER_FIX,
}

/** An unmarked page beside a backlog or an unreadable ledger: a title true of every line, and every fix they need. */
export const BUYER_SALE_DRAIN_SEVERAL_REMEDY: TitledRemedy = {
  title: 'The buyer sales copy has more than one problem',
  fixHint: `${BACKLOG_FIX} ${LEDGER_FIX}`,
}

export const BUYER_SALE_DRAIN_UNLISTED_REMEDY: TitledRemedy = {
  title: "The buyer sales copy couldn't run",
  context: SELLING_UNAFFECTED,
  fixHint: 'Check that the database is answering. The next minute tries again on its own.',
}

/** One title per kind of page, so a title never claims what the lines under it do not say (L11). */
export function drainRemedyFor(keys: readonly string[]): TitledRemedy {
  if (keys.includes(UNLISTED_KEY)) return BUYER_SALE_DRAIN_UNLISTED_REMEDY
  const unreadable = keys.some((k) => k.endsWith(':unmeasured'))
  const backlog = keys.some((k) => k.endsWith(':backlog'))
  const unmarked = keys.some((k) => k.endsWith(':unmarked'))
  if (unmarked) return unreadable || backlog ? BUYER_SALE_DRAIN_SEVERAL_REMEDY : BUYER_SALE_DRAIN_UNMARKED_REMEDY
  if (unreadable && backlog) return BUYER_SALE_DRAIN_MIXED_REMEDY
  return unreadable ? BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY : BUYER_SALE_DRAIN_BACKLOG_REMEDY
}

/** The drain's page through the shared alerter, with the title its lines earn. An empty list is the clear. */
export function notifyBuyerSaleDrain(
  supabase: SupabaseClient,
  kv: Parameters<typeof notifyExportFailure>[3],
  lines: string[],
  keys: readonly string[] | undefined,
  nowMs: number,
): Promise<void> {
  return notifyExportFailure(supabase, BUYER_SALE_DRAIN_JOB, lines, kv, drainRemedyFor(keys ?? []), nowMs, { keys })
}

export interface DrainBuyer {
  partner_id: string
  organization_id: string
  slug: string
}

/** The two ledger calls the drain makes. */
export interface DrainLedger {
  unmirrored(): Promise<UnmirroredResult>
  markMirrored(stamps: MirroredStamp[]): Promise<MarkMirroredResult>
}

/** What a second client is told: the outbox read's own deadline. Every other call keeps the client's default. */
export interface LedgerOptions {
  unmirroredDeadlineMs: number
}

/** By partner id, the moment (epoch ms) a ledger was first found unreadable with no good read since. */
export type UnreadableStamps = Record<string, number>

export interface UnreadableSinceStore {
  /** Throws when the record cannot be read or does not parse; never answers empty for a failure (L105). */
  read(): Promise<UnreadableStamps>
  /** An empty record removes it. */
  write(stamps: UnreadableStamps): Promise<void>
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
  /** A new client, and so a new stub, on every call: the drain asks again on a fresh one (#1895). */
  ledger(partnerId: string, opts?: LedgerOptions): DrainLedger
  unreadableSince: UnreadableSinceStore
  readExistingRows(ids: string[]): Promise<Map<string, ExistingRowMeta>>
  supabase: SupabaseClient
  /**
   * Receives the page lines; an empty list clears the standing condition.
   * `keys` names each paged line's problem for the alerter (#1768): the buyer and
   * what is wrong, never the age or the last error, which move every tick. An
   * empty list, the clear, carries none.
   */
  notify(lines: string[], keys?: readonly string[]): Promise<void>
  /**
   * Records a tick that had work as one finished job_runs row (#1810). Never
   * called for a quiet tick, because the job runs every minute. A throw here is
   * logged and never fails the drain or its page.
   */
  recordRun(startedAtMs: number, ending: JobRunEnding): Promise<void>
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
  /** The buyer_sales row id of every entry this tick delivered, in delivery order. */
  delivered_row_ids: string[]
  /** The age of the oldest entry still undelivered after this tick; null when nothing is left. */
  remaining_oldest_age_ms: number | null
  /** Set when the ledger could not be read; the counts above are then meaningless and zero. */
  unmeasured?: string
  /** Set when the first read got no answer and the second read succeeded, naming the first ask's error. */
  first_read_failed?: string
  /**
   * Of `failed`, the entries whose row WAS written and only the ledger's mark
   * failed (#835). Set only when above zero. Counted in `failed` as before; it
   * decides which words the page uses, never whether it pages.
   */
  unmarked?: number
  /**
   * Entries whose row was written but which the ledger left unmarked because
   * their state changed between this tick's read and its mark (#2422), so the
   * row holds the earlier state and the next tick copies the newer one. Set only
   * when above zero. Not delivered and not failed: nothing went wrong, and they
   * are not held against the backlog page, because the change is seconds old.
   */
  changed_since_read?: number
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
/** An error message closed as a sentence, so a page line reads as full sentences. */
const sentence = (text: string): string => `${text.replace(/[\s.]+$/, '')}.`

function sameStamps(a: UnreadableStamps, b: UnreadableStamps): boolean {
  const ak = Object.keys(a)
  return ak.length === Object.keys(b).length && ak.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

export async function runBuyerSaleDrain(deps: DrainDeps): Promise<DrainSummary> {
  if (deps.localDev) {
    deps.log(`[${BUYER_SALE_DRAIN_JOB}] skipped: local dev must not write buyer_sales in production (#669)`)
    return { skipped: 'local_dev', buyers: [], paged: [], errors: [] }
  }

  const startedAtMs = deps.now()
  let buyers: DrainBuyer[]
  try {
    buyers = await deps.listBuyers()
  } catch (err) {
    const reason = `The buyer list could not be read, so no buyer ledger was copied. The error was: ${sentence(messageOf(err))}`
    const result: DrainSummary = { unmeasured: reason, buyers: [], paged: [reason], errors: [reason] }
    // Recorded before the page, so an alerter that throws cannot take the record with it.
    await recordTick(deps, startedAtMs, result)
    await deps.notify([reason], [UNLISTED_KEY])
    return result
  }

  // Read before any ledger, so a store that cannot be read is known before a
  // write could replace a record nobody saw (L105).
  let stamps: UnreadableStamps | null
  let stampProblem: string | null = null
  try {
    stamps = await deps.unreadableSince.read()
  } catch (err) {
    stamps = null
    stampProblem = `could not be read (${messageOf(err)})`
    deps.log(`[${BUYER_SALE_DRAIN_JOB}] the record of when each buyer ledger became unreadable ${stampProblem}`)
  }

  const summaries: DrainBuyerSummary[] = []
  const paged: string[] = []
  const keys: string[] = []
  const errors: string[] = []
  const next: UnreadableStamps = {}
  const tickEndsAt = startedAtMs + DRAIN_TICK_MS

  for (const buyer of buyers) {
    const readAt = deps.now()
    const summary = await drainBuyer(deps, buyer, errors, tickEndsAt)
    summaries.push(summary)
    // The first moment is kept where it was first seen; a good read leaves the buyer out, which clears it.
    if (summary.unmeasured !== undefined) next[buyer.partner_id] = stamps?.[buyer.partner_id] ?? readAt
  }

  // Never written after a failed read, which would replace moments nobody saw.
  // Written while any ledger is unreadable, so its expiry stays a day ahead.
  let saveFailed = false
  if (stamps !== null && (Object.keys(next).length > 0 || !sameStamps(stamps, next))) {
    try {
      await deps.unreadableSince.write(next)
    } catch (err) {
      saveFailed = true
      stampProblem = `could not be saved (${messageOf(err)})`
      deps.log(`[${BUYER_SALE_DRAIN_JOB}] the record of when each buyer ledger became unreadable ${stampProblem}`)
    }
  }

  for (let i = 0; i < buyers.length; i++) {
    const buyer = buyers[i]
    const summary = summaries[i]
    if (summary.unmeasured !== undefined) {
      // A moment no later run can see cannot be timed, so it pages now rather
      // than never. A moment an earlier run saved still times the stretch.
      const untimed = stamps === null || (saveFailed && stamps[buyer.partner_id] === undefined)
      const lastError = `The last error was: ${sentence(summary.unmeasured)}`
      if (untimed) {
        paged.push(`${buyer.slug}'s buyer ledger could not be read, and how long that has lasted is unknown because the record of when it started ${stampProblem}. ${lastError}`)
        keys.push(`${buyer.slug}:unmeasured`)
        continue
      }
      const since = next[buyer.partner_id]
      const age = deps.now() - since
      if (age >= OUTBOX_BACKLOG_MS) {
        paged.push(`${buyer.slug}'s buyer ledger has not been readable for ${describeDuration(age) ?? `${age} ms`}, since ${etTime(since)}, so its copy cannot be checked. ${lastError}`)
        keys.push(`${buyer.slug}:unmeasured`)
      }
    } else if (summary.remaining_oldest_age_ms !== null && summary.remaining_oldest_age_ms > OUTBOX_BACKLOG_MS) {
      // The page is about what is LEFT after this tick's attempts, so it is
      // judged on the oldest entry still undelivered, never on the age the
      // ledger reported before delivery.
      const lastError = errors.filter((e) => e.startsWith(`${buyer.slug}:`)).at(-1)
      // An entry whose row was written and whose ledger mark failed is not
      // missing from the sales table, so it is said apart (#835). Which words is
      // all this decides: the page itself was decided on the age above.
      // An entry that changed since the read is neither undelivered nor unmarked (#2422).
      const left = summary.pending - summary.delivered - (summary.changed_since_read ?? 0)
      const unmarked = summary.unmarked ?? 0
      const unwritten = left - unmarked
      const age = `The oldest is ${describeDuration(summary.remaining_oldest_age_ms) ?? `${summary.remaining_oldest_age_ms} ms`} old.`
      const last = lastError ? ` The last error was: ${sentence(lastError.slice(buyer.slug.length + 2))}` : ''
      if (unwritten === 0) {
        paged.push(`${buyer.slug} has ${plural(unmarked, 'ledger entry', 'ledger entries')} in the sales table that the ledger could not mark as copied. ${age}${last}`)
        keys.push(`${buyer.slug}:unmarked`)
      } else {
        const also = unmarked === 0 ? '' : ` ${unmarked} more ${unmarked === 1 ? 'is' : 'are'} in the sales table but the ledger could not mark ${unmarked === 1 ? 'it' : 'them'} as copied.`
        paged.push(`${buyer.slug} has ${plural(unwritten, 'ledger entry', 'ledger entries')} not yet copied to the sales table.${also} ${age}${last}`)
        keys.push(`${buyer.slug}:backlog`)
      }
    }
  }

  const result: DrainSummary = { buyers: summaries, paged, errors }
  // Recorded before the page, so an alerter that throws cannot take the record
  // with it; recordTick never throws, so it cannot hold the page back either.
  await recordTick(deps, startedAtMs, result)
  // An empty list is the clear, and carries no keys.
  if (paged.length === 0) await deps.notify(paged)
  else await deps.notify(paged, keys)
  return result
}

/**
 * Records the tick if it had work: an entry pending, a failure, a ledger or
 * buyer list it could not read (#1810), or a ledger read only on its second ask
 * (#1895), which no page reports, so this record is the only count of how often
 * the first ask fails. A quiet tick records nothing.
 */
async function recordTick(deps: DrainDeps, startedAtMs: number, result: DrainSummary): Promise<void> {
  const hadWork =
    result.unmeasured !== undefined ||
    result.errors.length > 0 ||
    result.buyers.some((b) => b.pending > 0 || b.unmeasured !== undefined || b.first_read_failed !== undefined)
  if (!hadWork) return
  const unmeasured = result.unmeasured !== undefined || result.buyers.some((b) => b.unmeasured !== undefined)
  const outcome = unmeasured ? 'unmeasured' : result.errors.length > 0 ? 'partial' : 'ok'
  const named = result.errors.slice(0, RUN_RECORD_ERRORS)
  const more = result.errors.length - named.length
  const detail = result.errors.length === 0 ? undefined : named.join(' | ') + (more > 0 ? ` | and ${more} more` : '')
  const buyers = result.buyers.map((b) => ({ ...b, delivered_row_ids: b.delivered_row_ids.slice(0, RUN_RECORD_ROW_IDS) }))
  try {
    await deps.recordRun(startedAtMs, { outcome, detail, summary: { buyers, paged: result.paged.length } })
  } catch (err) {
    deps.log(`[${BUYER_SALE_DRAIN_JOB}] the run record could not be written: ${messageOf(err)}`)
  }
}

type OutboxRead = { outbox: UnmirroredResult; ledger: DrainLedger; firstFailed?: string } | { unmeasured: string }

/**
 * Reads a buyer's outbox, asking once more when the first ask got no answer
 * (#1895). The second ask is a new client, so a new stub, because a stub whose
 * call was lost can stay broken, and it is given only what is left of the run's
 * minute. An answer, even an error status, is never asked again: the ledger said
 * what it had to say.
 */
async function readOutbox(deps: DrainDeps, buyer: DrainBuyer, tickEndsAt: number): Promise<OutboxRead> {
  const first = deps.ledger(buyer.partner_id)
  try {
    return { outbox: await first.unmirrored(), ledger: first }
  } catch (err) {
    const firstReason = messageOf(err)
    if (!gotNoAnswer(err)) return { unmeasured: firstReason }
    const left = tickEndsAt - deps.now()
    if (left < MEASURED_OBJECT_CALL_P99_MS) return { unmeasured: `${firstReason}; not asked again, because too little of this minute was left` }
    const again = deps.ledger(buyer.partner_id, { unmirroredDeadlineMs: Math.min(OBJECT_CALL_DEADLINE_MS, left) })
    try {
      return { outbox: await again.unmirrored(), ledger: again, firstFailed: firstReason }
    } catch (err2) {
      return { unmeasured: `${firstReason}; asked again, and ${messageOf(err2)}` }
    }
  }
}

async function drainBuyer(deps: DrainDeps, buyer: DrainBuyer, errors: string[], tickEndsAt: number): Promise<DrainBuyerSummary> {
  const base: DrainBuyerSummary = { partner_id: buyer.partner_id, slug: buyer.slug, pending: 0, delivered: 0, failed: 0, oldest_age_ms: null, delivered_row_ids: [], remaining_oldest_age_ms: null }
  const now = deps.now()
  let oldestRemaining: number | null = null
  const leave = (entry: LedgerEntry) => { if (oldestRemaining === null || entry.reserved_at < oldestRemaining) oldestRemaining = entry.reserved_at }

  const read = await readOutbox(deps, buyer, tickEndsAt)
  if ('unmeasured' in read) {
    errors.push(`${buyer.slug}: ledger unreadable: ${read.unmeasured}`)
    return { ...base, unmeasured: read.unmeasured }
  }
  const { outbox, ledger } = read
  if (read.firstFailed !== undefined) {
    base.first_read_failed = read.firstFailed
    deps.log(`[${BUYER_SALE_DRAIN_JOB}] ${buyer.slug}: the first ledger read got no answer and the second read it: ${read.firstFailed}`)
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
    // mirrorBuyerSale marks only after the row it wrote came back as the one sent,
    // so reaching the mark means the sales table holds the row (#835).
    let written = false
    let changed = false
    try {
      const row = await buildBuyerSaleRow(entry, meta)
      await mirrorBuyerSale(deps.supabase, row, entry, {
        markMirrored: async (stamp) => {
          written = true
          const r = await ledger.markMirrored([stamp])
          changed = r.changed > 0
        },
      })
      if (changed) {
        // The entry moved while its row was being written (#2422): the ledger left
        // it unmarked, and the next tick copies the state it holds now.
        base.changed_since_read = (base.changed_since_read ?? 0) + 1
        continue
      }
      base.delivered += 1
      base.delivered_row_ids.push(ids[i])
    } catch (err) {
      base.failed += 1
      if (written) base.unmarked = (base.unmarked ?? 0) + 1
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

/**
 * Ids per buyer_sales lookup. Every id rides in the request URL, 37 characters
 * each, so 200 keep the URL near 7.5 KB and the answer well under the 1,000 row
 * cap. The outbox itself has no bound: a Supabase outage of a day leaves
 * thousands of entries uncopied, and one request naming them all is refused as
 * too long on every tick, so the drain would never catch up.
 */
export const EXISTING_ROWS_PER_READ = 200

/** The earlier copy of each row the drain is about to deliver, read in bounded batches. */
export async function readExistingBuyerSaleRows(supabase: SupabaseClient, ids: string[]): Promise<Map<string, ExistingRowMeta>> {
  const out = new Map<string, ExistingRowMeta>()
  for (const batch of chunk(ids, EXISTING_ROWS_PER_READ)) {
    const { data, error } = await supabase
      .from('buyer_sales')
      .select('id, workflow_id, trace_id, debt, multiplier, live_percent_in_force, caps_in_force')
      .in('id', batch) // paginate-ok .in(id): at most EXISTING_ROWS_PER_READ ids of the primary key, one row each
    if (error) throw new Error(`buyer_sales: ${error.message}`)
    for (const r of (data ?? []) as unknown as ExistingRowRecord[]) {
      out.set(r.id, { workflow_id: r.workflow_id, trace_id: r.trace_id, debt: num(r.debt), multiplier: num(r.multiplier), live_percent_in_force: r.live_percent_in_force, caps_in_force: r.caps_in_force })
    }
  }
  return out
}

/** The outbox read's own deadline on a second client; every other call keeps the default (#1895). */
export function ledgerClientOptions(opts: LedgerOptions | undefined): ClientOptions {
  if (opts === undefined) return {}
  return { deadlineMs: (op) => (op === LEDGER_UNMIRRORED_OP ? opts.unmirroredDeadlineMs : OBJECT_CALL_DEADLINE_MS) }
}

/** A stored record that will not parse throws, so the drain pages rather than reading it as no ledger unreadable (L105, L50). */
export function parseUnreadableStamps(raw: string): UnreadableStamps {
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`the stored record is not an object: ${raw.slice(0, 80)}`)
  const out: UnreadableStamps = {}
  for (const [partnerId, at] of Object.entries(parsed)) {
    if (typeof at !== 'number' || !Number.isFinite(at)) throw new Error(`the stored moment for ${partnerId} is not a time: ${JSON.stringify(at)}`)
    out[partnerId] = at
  }
  return out
}

export function kvUnreadableSince(kv: KVNamespace): UnreadableSinceStore {
  return {
    async read() {
      const raw = await kv.get(UNREADABLE_SINCE_KEY)
      return raw === null ? {} : parseUnreadableStamps(raw)
    },
    async write(stamps) {
      if (Object.keys(stamps).length === 0) await kv.delete(UNREADABLE_SINCE_KEY)
      else await kv.put(UNREADABLE_SINCE_KEY, JSON.stringify(stamps), { expirationTtl: UNREADABLE_SINCE_TTL_S })
    },
  }
}

export function productionDrainDeps(supabase: SupabaseClient, env: Env): DrainDeps {
  return {
    listBuyers: async () => {
      // Every offer buyer with a profile, enabled or not: a disabled buyer can
      // still hold entries from before it was disabled. A click sold buyer
      // (#1541) never reserves in the ledger, so it has no outbox here.
      const { data, error } = await supabase
        .from('buyer_profiles')
        .select('partner_id, partner_configs!inner(organization_id, slug), organizations!inner(is_synthetic)')
        .eq('sold_on', 'offer')
        // Never a synthetic organization's buyer (#2135): the one predicate that
        // marks the partners page delivery monitor's organization (L261).
        .eq('organizations.is_synthetic', false)
      if (error) throw new Error(`buyer_profiles: ${error.message}`)
      return ((data ?? []) as unknown as Array<{ partner_id: string; partner_configs: { organization_id: string; slug: string } }>).map((r) => ({
        partner_id: r.partner_id,
        organization_id: r.partner_configs.organization_id,
        slug: r.partner_configs.slug,
      }))
    },
    ledger: (partnerId, opts) => new BuyerLedgerClient(env.BUYER_LEDGER, partnerId, ledgerClientOptions(opts)),
    unreadableSince: kvUnreadableSince(env.IDEMPOTENCY),
    readExistingRows: (ids) => readExistingBuyerSaleRows(supabase, ids),
    supabase,
    notify: (lines, keys) => notifyBuyerSaleDrain(supabase, env.IDEMPOTENCY, lines, keys, Date.now()),
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, BUYER_SALE_DRAIN_JOB, startedAtMs, ending),
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    log: (line) => console.log(line),
  }
}

export function runBuyerSaleDrainForEnv(supabase: SupabaseClient, env: Env): Promise<DrainSummary> {
  return runBuyerSaleDrain(productionDrainDeps(supabase, env))
}
