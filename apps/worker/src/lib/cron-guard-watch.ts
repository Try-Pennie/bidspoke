/**
 * Tell someone when the cron tick guard stops guarding, or Cloudflare doubles
 * every tick again (#1904).
 *
 * The guard (cron-once.ts, #1899) logs `FAILED OPEN` when its claim object does
 * not answer, and the jobs then run unguarded, and `skipped duplicate` for each
 * second copy of a tick it drops. Both lived only in Workers Logs, and neither
 * job_runs nor the cron heartbeat has a place for them (L13, L77).
 *
 * Each event is recorded in KV as its OWN key, so two at once cannot overwrite
 * one count, and the hourly check counts the last 24 hours. KV and not the claim
 * object holds them, because a fail-open IS the claim object being unreachable,
 * and it cannot count its own outage (L345). The check pages once a day per
 * kind, the day's quiet armed only on delivery, and a count it cannot read is
 * reported as unreadable, never as zero (L98).
 *
 * KV shares the outage too (#2166): on 2026-10-14 the KV writes failed in the
 * blip that made the guard fail open, and 9 fail-opens were counted as 3. So a
 * failed write is retried and held until it lands (cron-guard-record.ts), and
 * fail-opens have a SECOND record written by a different path: the tail worker
 * copies each `FAILED OPEN` log line into cron_guard_fail_opens by the event id
 * the line carries. Fail-opens are counted as the union of the two by id. When
 * the two disagree, or one cannot be read, the page says what it counted from
 * where, and a count from one record alone is a floor (L11).
 *
 * A fail-open does no harm by itself (#2284): harm needs its tick to be run by a
 * second delivery as well. Measured 2026-10-15 to 17, fail-opens came at about
 * 4 a day from ordinary platform delays, every tick ran once, and the page fired
 * most days with nothing to do. So fail-opens page only on a rate well above
 * that, and a tick that may really have run twice pages at once, read from the
 * durable record of every delivery (cron_tick_deliveries, which the tail worker
 * writes from the guard's delivery lines). A skip count cannot show it, since a
 * second delivery that ran leaves no skip, and a Workers Logs search missed
 * known lines. A record of deliveries that cannot be read, or is not whole, is
 * paged as a check that could not be made, never read as no tick ran twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { anyDelivered, forEachSlackOrg } from './alert-fanout'
import { etTime, sendExportFailureAlert } from './slack'
import { cronTickKey } from './cron-once'
import { scheduleInWords } from './schedule-words'

export type CronGuardKind = 'failed_open' | 'skipped_duplicate'

const KINDS: CronGuardKind[] = ['failed_open', 'skipped_duplicate']

/** What the check can page: a kind of guard event, or a tick that may have run twice. */
export type CronGuardPage = CronGuardKind | 'double_run'

/**
 * Fail-opens in a normal day, measured (#2284, L172). The guard's KV record and
 * the tail copy held 6 in about 33 hours on 2026-10-15 to 16, 3 on 2026-10-16
 * and 2 by 15:30 UTC on 2026-10-17; the highest any 24 hours reached was 5.
 * Every one was a claim timeout on a tick that ran once. Named in the page, so
 * the reader can weigh the count.
 */
export const FAIL_OPENS_PER_DAY_MEASURED = 4

/**
 * Fail-opens: 20 in 24 hours (#2284). Four times the highest normal day (5) and
 * five times the usual 4, so an ordinary day never reaches it, while a claim
 * store that is really failing reaches it fast: down outright, the minute tick
 * alone fails open 60 times an hour. A fail-open below this is recorded and
 * logged, and pages only when its tick was also run by another delivery
 * (double_run below). It replaces the 3 agreed on 2026-10-14, which paged on
 * most ordinary days. The 2026-10-14 blip, 9 fail-opens, would not page on its
 * rate; a tick it doubled would page on its own.
 *
 * Duplicates (agreed 2026-10-14): a duplicate is absorbed, so only a sustained
 * stretch is worth a page: 30 is about half an hour of the minute cron
 * doubling, and the 2026-10-08 doubling produced well over a thousand a day.
 */
export const CRON_GUARD_THRESHOLDS: Record<CronGuardKind, number> = { failed_open: 20, skipped_duplicate: 30 }

const DAY_SECONDS = 24 * 60 * 60
const WINDOW_MS = DAY_SECONDS * 1000
/** Twice the window, so every event in the window is still there to count. */
const RECORD_TTL_SECONDS = 2 * DAY_SECONDS
/** 10 pages of 1000 keys, the newest; past that the count is a floor and says so. */
const MAX_LIST_PAGES = 10

const eventPrefix = (kind: CronGuardKind) => `cron-guard:event:${kind}:`
export const cronGuardPagedKey = (kind: CronGuardKind) => `cron-guard:paged:${kind}`

export interface RecordKv {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

interface ListKv {
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>
}

export interface CronGuardKv extends RecordKv, ListKv {
  get(key: string): Promise<string | null>
}

/**
 * Keys carry the time counted DOWN from this ceiling, so KV, which lists in
 * ascending name order, lists the newest first. Named by plain time they listed
 * oldest first, and a count that reached its page limit had spent it on the 24
 * to 48 hour old keys the window then discarded. Fixed width, so the names sort
 * as the numbers do (the ceiling is in the year 2286).
 */
const TIME_CEILING_MS = 9_999_999_999_999
const TIME_WIDTH = 13

/**
 * One key per event, named by its time and its id so the count needs no reads.
 * The same event always names the same key, so writing it again (a late write
 * of one that had landed after all) counts it once (#2166).
 */
export async function recordCronGuardEvent(
  kv: RecordKv,
  kind: CronGuardKind,
  atMs: number,
  id: string = crypto.randomUUID(),
): Promise<void> {
  const countdown = String(TIME_CEILING_MS - Math.floor(atMs)).padStart(TIME_WIDTH, '0')
  await kv.put(`${eventPrefix(kind)}${countdown}:${id}`, '1', { expirationTtl: RECORD_TTL_SECONDS })
}

/** One recorded guard event: its id (from its key) and when it happened. */
export interface RecordedGuardEvent {
  id: string
  atMs: number
}

/** Events of one kind in the 24 hours to `nowMs`, newest first. A failed list THROWS (L98). */
export async function listCronGuardEvents(
  kv: ListKv,
  kind: CronGuardKind,
  nowMs: number,
  opts: { maxPages?: number } = {},
): Promise<{ events: RecordedGuardEvent[]; capped: boolean }> {
  const prefix = eventPrefix(kind)
  const since = nowMs - WINDOW_MS
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES
  const events: RecordedGuardEvent[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const res = await kv.list({ prefix, cursor })
    for (const { name } of res.keys) {
      const countdown = Number(name.slice(prefix.length, prefix.length + TIME_WIDTH))
      // A name that does not parse is not ours to count, and is skipped rather
      // than read as a time (L50).
      if (!Number.isFinite(countdown)) continue
      const at = TIME_CEILING_MS - countdown
      // Newest first, so the first key older than the window ends the count.
      if (at <= since) return { events, capped: false }
      // The id follows the time and its colon; a key from before ids were
      // shared still ends in a random one, which is unique all the same.
      if (at <= nowMs) events.push({ id: name.slice(prefix.length + TIME_WIDTH + 1), atMs: at })
    }
    if (res.list_complete || !res.cursor) return { events, capped: false }
    cursor = res.cursor
  }
  return { events, capped: true }
}

/** How many events of one kind in the 24 hours to `nowMs`. A failed list THROWS (L98). */
export async function countCronGuardEvents(
  kv: ListKv,
  kind: CronGuardKind,
  nowMs: number,
  opts: { maxPages?: number } = {},
): Promise<{ count: number; capped: boolean }> {
  const { events, capped } = await listCronGuardEvents(kv, kind, nowMs, opts)
  return { count: events.length, capped }
}

/**
 * Reads the tail worker's copy of the `FAILED OPEN` lines (#2166) for the
 * window (sinceMs, nowMs]. A failed read THROWS, so it is reported as
 * unreadable and never as zero (L98).
 */
export type TailCopyReader = (sinceMs: number, nowMs: number) => Promise<{ events: RecordedGuardEvent[]; capped: boolean }>

/**
 * A KV record younger than this may not be in the tail copy YET: the tail
 * worker is handed the guard's log lines only once that invocation and its
 * waitUntil work have finished. So only older ones are reported missing from it.
 */
export const TAIL_COPY_LAG_MS = 10 * 60 * 1000

/** What a fail-open count was read from, so the page can say (L11). */
export interface CronGuardSources {
  /** Fail-opens in the guard's own KV record; absent when it could not be read. */
  guardRecord?: number
  /** Fail-opens in the tail worker's copy; absent when it could not be read. */
  tailCopy?: number
  /** In the tail copy only: the guard's own record of them failed. */
  onlyInTailCopy?: number
  /** In the guard's record, old enough to have been copied, and not in the tail copy. */
  missingFromTailCopy?: number
  /** The record that could not be read, and why. */
  unread?: { record: 'guard_record' | 'tail_copy'; why: string }
}

const PAGE_SIZE = 1000

/** The live tail copy reader: newest first, 1,000 rows a page, so PostgREST's row cap cannot shorten it silently. */
export function supabaseTailCopyReader(supabase: SupabaseClient, opts: { maxPages?: number } = {}): TailCopyReader {
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES
  return async (sinceMs, nowMs) => {
    const events: RecordedGuardEvent[] = []
    for (let page = 0; page < maxPages; page++) {
      const { data, error } = await supabase
        .from('cron_guard_fail_opens')
        .select('event_id, occurred_at')
        .gt('occurred_at', new Date(sinceMs).toISOString())
        .lte('occurred_at', new Date(nowMs).toISOString())
        .order('occurred_at', { ascending: false })
        .order('event_id', { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
      if (error) throw new Error(`cron_guard_fail_opens read failed: ${error.message}`)
      const rows = (data ?? []) as Array<{ event_id: string; occurred_at: string }>
      for (const row of rows) events.push({ id: row.event_id, atMs: Date.parse(row.occurred_at) })
      if (rows.length < PAGE_SIZE) return { events, capped: false }
    }
    return { events, capped: true }
  }
}

export interface CronGuardMessage {
  title: string
  errors: string[]
  context: string
  fixHint?: string
}

const TAIL_COPY = 'the copy the tail worker keeps of the guard\'s log lines'

/**
 * What a fail-open page adds about where its count came from (#2166, L11): only
 * when the two records disagree or one could not be read, so a page on a day
 * both records agree carries the one sentence it always did (L605).
 */
function sourceLines(s: CronGuardSources | undefined): string[] {
  if (!s) return []
  const lines: string[] = []
  const of = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} of them ${n === 1 ? one : many}`
  if (s.unread?.record === 'tail_copy') {
    lines.push(`This counts the guard's own record alone: the tail worker's copy of its log lines could not be read (${s.unread.why}), so a fail-open whose own record also failed is not in this count.`)
  }
  if (s.unread?.record === 'guard_record') {
    lines.push(`This counts the tail worker's copy of the guard's log lines alone: the guard's own record could not be read (${s.unread.why}).`)
  }
  if (s.onlyInTailCopy) {
    lines.push(`The guard could not write its own record of ${s.onlyInTailCopy.toLocaleString('en-US')} of them, because its store failed too. They were counted from ${TAIL_COPY}.`)
  }
  if (s.missingFromTailCopy) {
    lines.push(`${of(s.missingFromTailCopy, 'is', 'are')} not in the tail worker's copy of the guard's log lines.`)
  }
  return lines
}

/**
 * The page for one kind of guard event, in the titled alert shape. A fail-open
 * page points at the durable record of fail-opens, never at a Workers Logs
 * search, which on 2026-10-17 missed two known FAILED OPEN lines (#2284).
 */
export function cronGuardMessage(kind: CronGuardKind, count: number, capped: boolean, sources?: CronGuardSources): CronGuardMessage {
  const n = `${capped ? 'at least ' : ''}${count.toLocaleString('en-US')}`
  if (kind === 'failed_open') {
    const times = count === 1 && !capped ? 'once' : `${n} times`
    return {
      title: 'Cron guard keeps failing open',
      errors: [
        `The cron guard could not reach its claim store ${times} in the last 24 hours, so those ticks ran without it. About ${FAIL_OPENS_PER_DAY_MEASURED} a day is normal.`,
        ...sourceLines(sources),
      ],
      context: 'A count this high means the claim store itself is failing, not a passing delay. A tick that ran twice is paged on its own.',
      fixHint: 'Each one is a row in the cron_guard_fail_opens table, with its tick and why the claim did not answer.',
    }
  }
  return {
    title: 'Cloudflare is delivering cron ticks twice',
    errors: [`Cloudflare delivered ${n} cron ${count === 1 && !capped ? 'tick' : 'ticks'} a second time in the last 24 hours.`],
    context: 'The cron guard skipped every second copy, so no job ran twice. This is Cloudflare\'s doing. Nothing here needs fixing.',
  }
}

// ── A tick that may have run twice (#2284) ────────────────────────────────────

/** What the guard decided for one delivery, as cron_tick_deliveries holds it. */
export type DeliveryOutcome = 'ran' | 'took_over' | 'failed_open' | 'skipped' | 'no_decision'

const OUTCOMES: ReadonlySet<string> = new Set<DeliveryOutcome>(['ran', 'took_over', 'failed_open', 'skipped', 'no_decision'])

/** The decisions under which a delivery ran the tick's jobs. */
const RAN: ReadonlySet<DeliveryOutcome> = new Set<DeliveryOutcome>(['ran', 'took_over', 'failed_open'])

/**
 * How Cloudflare says an invocation ended when it was cut short: killed, or the
 * jobs threw before they could run (the tick is then released). A later delivery
 * running such a tick is the retry working, not a second run of finished work.
 * Anything else, `ok` and no outcome at all included, may have finished.
 */
const CUT_SHORT: ReadonlySet<string> = new Set(['canceled', 'exceededCpu', 'exceededMemory', 'exception'])

/** One delivery of a cron tick, read from the record of deliveries. */
export interface TickDelivery {
  id: string
  cron: string
  scheduledAtMs: number
  outcome: DeliveryOutcome
  invocationOutcome: string | null
  /** When the guard decided, by the delivery's own log line. */
  atMs: number
}

/** A row of cron_tick_deliveries, the shape the tail worker writes (apps/worker-tail/src/deliveries.ts). */
export interface DeliveryRecordRow {
  delivery_id: string
  cron: string
  scheduled_at: string
  outcome: string
  invocation_outcome: string | null
  occurred_at: string
}

/** One row as a delivery. An outcome or a time it cannot read THROWS, never counted as something else (L50). */
export function deliveryFromRow(row: DeliveryRecordRow): TickDelivery {
  if (!OUTCOMES.has(row.outcome)) throw new Error(`cron_tick_deliveries row ${row.delivery_id} has outcome "${row.outcome}", which this check does not know`)
  const scheduledAtMs = Date.parse(row.scheduled_at)
  const atMs = Date.parse(row.occurred_at)
  if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(atMs)) throw new Error(`cron_tick_deliveries row ${row.delivery_id} has a time that does not parse`)
  return { id: row.delivery_id, cron: row.cron, scheduledAtMs, outcome: row.outcome as DeliveryOutcome, invocationOutcome: row.invocation_outcome, atMs }
}

/** Reads the deliveries in the window (sinceMs, nowMs]. A failed read THROWS (L98). */
export type DeliveryReader = (sinceMs: number, nowMs: number) => Promise<{ deliveries: TickDelivery[]; capped: boolean }>

/** The live reader: newest first, 1,000 rows a page, so PostgREST's row cap cannot shorten it silently. */
export function supabaseDeliveryReader(supabase: SupabaseClient, opts: { maxPages?: number } = {}): DeliveryReader {
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES
  return async (sinceMs, nowMs) => {
    const deliveries: TickDelivery[] = []
    for (let page = 0; page < maxPages; page++) {
      const { data, error } = await supabase
        .from('cron_tick_deliveries')
        .select('delivery_id, cron, scheduled_at, outcome, invocation_outcome, occurred_at')
        .gt('occurred_at', new Date(sinceMs).toISOString())
        .lte('occurred_at', new Date(nowMs).toISOString())
        .order('occurred_at', { ascending: false })
        .order('delivery_id', { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
      if (error) throw new Error(`cron_tick_deliveries read failed: ${error.message}`)
      const rows = (data ?? []) as DeliveryRecordRow[]
      for (const row of rows) deliveries.push(deliveryFromRow(row))
      if (rows.length < PAGE_SIZE) return { deliveries, capped: false }
    }
    return { deliveries, capped: true }
  }
}

/** A tick two or more deliveries ran, and how. */
export interface DoubledTick {
  /** The guard's claim key: the cron and the scheduled minute. */
  tick: string
  cron: string
  scheduledAtMs: number
  how: 'failed_open' | 'took_over' | 'ran_twice'
  /** Every delivery that ran it, oldest first. */
  runs: TickDelivery[]
}

/**
 * Ticks that may have run twice: two or more deliveries ran the same tick (the
 * guard's own key, cron and scheduled minute), and one that was followed by
 * another had not been cut short. That covers a fail-open whose tick another
 * delivery also ran, and a takeover of a run that was still alive because its
 * lease lapsed (its renewals failed, as the daily tick's did six times in a row
 * at 09:00 UTC on 2026-10-17). The retry of a run Cloudflare killed is excluded:
 * running it again is the point.
 */
export function findDoubledTicks(deliveries: TickDelivery[]): DoubledTick[] {
  const byTick = new Map<string, TickDelivery[]>()
  for (const d of deliveries) {
    if (!RAN.has(d.outcome)) continue
    const tick = cronTickKey(d.cron, d.scheduledAtMs)
    const runs = byTick.get(tick) ?? []
    runs.push(d)
    byTick.set(tick, runs)
  }
  const doubled: DoubledTick[] = []
  for (const [tick, runs] of byTick) {
    if (runs.length < 2) continue
    runs.sort((a, b) => a.atMs - b.atMs)
    const finishedThenRanAgain = runs.slice(0, -1).some((r) => r.invocationOutcome === null || !CUT_SHORT.has(r.invocationOutcome))
    if (!finishedThenRanAgain) continue
    const how = runs.some((r) => r.outcome === 'failed_open') ? 'failed_open' : runs.some((r) => r.outcome === 'took_over') ? 'took_over' : 'ran_twice'
    doubled.push({ tick, cron: runs[0].cron, scheduledAtMs: runs[0].scheduledAtMs, how, runs })
  }
  return doubled.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs)
}

/** The cron every minute tick is delivered on: the measure of whether the record is whole. */
const MINUTE_CRON = '* * * * *'
const MINUTE_MS = 60_000

/**
 * Below this share of the minute tick's minutes, the record is not whole enough
 * to say no tick ran twice. Cloudflare delivers that tick every minute, so a
 * record holding fewer than 9 in 10 of them is missing deliveries, not quiet.
 */
export const DELIVERY_COVERAGE_FLOOR = 0.9

/** Less than this span of record is too new to judge: right after the table starts filling. */
const MIN_JUDGED_MINUTES = 60

/**
 * How much of the minute tick the record holds, from the first minute it holds
 * (or the window's start) to the tail copy's lag before now. Measured from the
 * first minute held, so a record that has only just started filling is judged on
 * what it could hold; a record that stopped part way is judged on the gap.
 */
function minuteCoverage(deliveries: TickDelivery[], sinceMs: number, nowMs: number): { present: number; expected: number } {
  const endMinute = Math.floor((nowMs - TAIL_COPY_LAG_MS) / MINUTE_MS)
  const minutes = new Set<number>()
  let first = Infinity
  for (const d of deliveries) {
    if (d.cron !== MINUTE_CRON) continue
    const m = Math.floor(d.scheduledAtMs / MINUTE_MS)
    if (m > endMinute) continue
    minutes.add(m)
    if (m < first) first = m
  }
  const windowStart = Math.floor(sinceMs / MINUTE_MS) + 1
  const startMinute = Number.isFinite(first) ? Math.max(first, windowStart) : windowStart
  const expected = Math.max(0, endMinute - startMinute + 1)
  let present = 0
  for (const m of minutes) if (m >= startMinute && m <= endMinute) present++
  return { present, expected }
}

/** What the double run check found, for the page. */
export type DoubleRunFinding =
  | { kind: 'doubled'; ticks: DoubledTick[] }
  | { kind: 'unreadable'; why: string }
  | { kind: 'incomplete'; present: number; expected: number }

const MAX_TICKS_NAMED = 5

const timesWord = (n: number) => (n === 2 ? 'twice' : `${n.toLocaleString('en-US')} times`)

function tickLine(t: DoubledTick): string {
  const words = scheduleInWords(t.cron, new Date(t.scheduledAtMs))
  const which = `The ${etTime(t.scheduledAtMs)} run of the cron that runs ${words ?? `on \`${t.cron}\``} happened ${timesWord(t.runs.length)}`
  if (t.how === 'failed_open') return `${which}: the claim store could not be reached for one delivery, which ran it without the claim, and another delivery ran it too.`
  if (t.how === 'took_over') return `${which}: a second delivery took it over while the first was still running, because the first had stopped renewing its claim.`
  return `${which}.`
}

const DELIVERY_RECORD = 'The record of cron deliveries'

/** The page for a tick that may have run twice, or for a check that could not be made. */
export function doubleRunMessage(f: DoubleRunFinding): CronGuardMessage {
  if (f.kind === 'doubled') {
    const named = f.ticks.slice(0, MAX_TICKS_NAMED).map(tickLine)
    const rest = f.ticks.length - named.length
    return {
      title: f.ticks.length === 1 ? 'A cron tick may have run twice' : `${f.ticks.length.toLocaleString('en-US')} cron ticks may have run twice`,
      errors: rest > 0 ? [...named, `And ${rest.toLocaleString('en-US')} more.`] : named,
      context: 'The jobs on those ticks may have done their work twice, such as an export, a purge or an alert.',
      fixHint: 'Each delivery is a row in the cron_tick_deliveries table. Check what those jobs wrote at those times.',
    }
  }
  const errors = f.kind === 'unreadable'
    ? [`${DELIVERY_RECORD} could not be read (${f.why}), so a tick that ran twice in the last 24 hours would not be seen.`]
    : f.expected === 0
      ? [`${DELIVERY_RECORD} holds no deliveries for the last 24 hours, so a tick that ran twice would not be seen.`]
      : [`${DELIVERY_RECORD} holds ${f.present.toLocaleString('en-US')} of the last ${f.expected.toLocaleString('en-US')} minutes of the every minute cron, so a tick that ran twice could be missed.`]
  return {
    title: 'Cron guard could not check for a tick run twice',
    errors,
    context: 'The tail worker writes this record. Until it is whole again, a tick that runs twice is not paged.',
    fixHint: 'Check that bidspoke-worker-tail is deployed and is writing rows to the cron_tick_deliveries table.',
  }
}

export interface CronGuardWatchDeps {
  kv: CronGuardKv
  now: () => number
  /** The fail-opens' second record, the tail worker's copy of their log lines (#2166). */
  tailFailOpens: TailCopyReader
  /** Every cron delivery and what the guard decided (#2284), the record a doubled tick is read from. */
  deliveries: DeliveryReader
  /** Delivers one page; true when anyone was told. */
  send: (page: CronGuardPage, message: CronGuardMessage) => Promise<boolean>
  log: (line: string) => void
  error: (line: string) => void
}

export type CronGuardResult =
  | { kind: CronGuardKind; status: 'unreadable' }
  | { kind: CronGuardKind; status: 'under' | 'over'; count: number; capped: boolean; alerted: boolean }
  | { kind: 'double_run'; status: 'none' | 'doubled' | 'unreadable' | 'incomplete'; doubled: number; alerted: boolean }

interface Counted {
  count: number
  capped: boolean
  sources?: CronGuardSources
}

const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))

/** Kept short: the reason goes into a Slack page. */
const shortWhy = (e: unknown) => {
  const s = formatErr(e)
  return s.length > 200 ? `${s.slice(0, 199)}…` : s
}

/**
 * Fail-opens are counted from BOTH records, by event id, so one the guard could
 * not write is still counted from the tail copy and one in both counts once
 * (#2166). One unreadable record leaves the other's count standing, as a floor.
 */
async function countFailOpens(deps: CronGuardWatchDeps, nowMs: number): Promise<Counted | null> {
  const [guard, tail] = await Promise.all([
    settle(listCronGuardEvents(deps.kv, 'failed_open', nowMs)),
    settle(deps.tailFailOpens(nowMs - WINDOW_MS, nowMs)),
  ])
  if (!guard.ok) deps.error(`[cron-guard-watch] could not count failed_open: ${formatErr(guard.error)}`)
  if (!tail.ok) deps.error(`[cron-guard-watch] could not read the tail worker's copy of failed_open: ${formatErr(tail.error)}`)
  if (!tail.ok) {
    if (!guard.ok) return null
    const n = guard.value.events.length
    return { count: n, capped: true, sources: { guardRecord: n, unread: { record: 'tail_copy', why: shortWhy(tail.error) } } }
  }
  if (!guard.ok) {
    const n = tail.value.events.length
    return { count: n, capped: true, sources: { tailCopy: n, unread: { record: 'guard_record', why: shortWhy(guard.error) } } }
  }
  const g = guard.value
  const t = tail.value
  const inGuard = new Set(g.events.map((e) => e.id))
  const inTail = new Set(t.events.map((e) => e.id))
  const union = new Set([...inGuard, ...inTail])
  const onlyInTailCopy = [...inTail].filter((id) => !inGuard.has(id)).length
  const missingFromTailCopy = g.events.filter((e) => !inTail.has(e.id) && e.atMs <= nowMs - TAIL_COPY_LAG_MS).length
  return {
    count: union.size,
    capped: g.capped || t.capped,
    sources: { guardRecord: inGuard.size, tailCopy: inTail.size, onlyInTailCopy, missingFromTailCopy },
  }
}

function sourcesForLog(s: CronGuardSources | undefined): string {
  if (!s) return ''
  const n = (v: number | undefined) => (v === undefined ? 'unreadable' : String(v))
  return ` guard_record=${n(s.guardRecord)} tail_copy=${n(s.tailCopy)}` +
    (s.unread ? '' : ` only_in_tail_copy=${s.onlyInTailCopy ?? 0} missing_from_tail_copy=${s.missingFromTailCopy ?? 0}`)
}

/** Posts `message` unless the quiet says it was posted in the last day; the quiet is armed only on delivery. */
async function pageOncePerDay(deps: CronGuardWatchDeps, page: CronGuardKind, message: CronGuardMessage, nowMs: number): Promise<boolean> {
  try {
    // A quiet we could not read lets the page through: a duplicate page beats a missed one.
    const quiet = await deps.kv.get(cronGuardPagedKey(page)).catch(() => null)
    if (quiet !== null) return false
    const alerted = await deps.send(page, message)
    // Armed only on delivery, so a Slack outage does not buy a day of silence.
    if (alerted) await deps.kv.put(cronGuardPagedKey(page), new Date(nowMs).toISOString(), { expirationTtl: DAY_SECONDS })
    return alerted
  } catch (e) {
    deps.error(`[cron-guard-watch] could not page ${page}: ${formatErr(e)}`)
    return false
  }
}

/**
 * Each double run signal keeps its OWN quiet key, so paging one never moves
 * another's (#2284 lessons review: one shared key, rewritten with a fresh day on
 * every newly paged tick, pushed the could-not-check page back a day each time).
 *
 * A doubled tick is paged once, under a key named for the tick, kept two days so
 * it outlives the 24 hour window the tick is judged in. The could-not-check page
 * goes out at most once a day, under its own key, written only when it is sent.
 */
export const doubleRunTickPagedKey = (tick: string) => `cron-guard:paged:double_run:${tick}`
export const DOUBLE_RUN_UNCHECKED_PAGED_KEY = 'cron-guard:paged:double_run_unchecked'
const TICK_QUIET_SECONDS = 2 * DAY_SECONDS

/** Whether a quiet key is set. One it cannot read counts as unset: a duplicate page beats a missed one. */
const quietSet = (kv: CronGuardKv, key: string) => kv.get(key).then((v) => v !== null, () => false)

async function judgeDoubleRuns(deps: CronGuardWatchDeps, nowMs: number): Promise<CronGuardResult> {
  const sinceMs = nowMs - WINDOW_MS
  let read: { deliveries: TickDelivery[]; capped: boolean } | null = null
  let finding: DoubleRunFinding | null = null
  let doubled: DoubledTick[] = []
  let status: 'none' | 'doubled' | 'unreadable' | 'incomplete' = 'none'
  try {
    read = await deps.deliveries(sinceMs, nowMs)
  } catch (e) {
    deps.error(`[cron-guard-watch] could not read the record of cron deliveries: ${formatErr(e)}`)
    deps.log('[cron-guard-watch] kind=double_run deliveries=unreadable')
    finding = { kind: 'unreadable', why: shortWhy(e) }
    status = 'unreadable'
  }
  if (read) {
    doubled = findDoubledTicks(read.deliveries)
    const coverage = minuteCoverage(read.deliveries, sinceMs, nowMs)
    const ran = read.deliveries.filter((d) => RAN.has(d.outcome)).length
    // Logged on every run, a quiet one included, so a record that stops keeping up shows on a quiet day too.
    deps.log(
      `[cron-guard-watch] kind=double_run deliveries=${read.deliveries.length}${read.capped ? '+' : ''} ran=${ran} doubled=${doubled.length}` +
        ` minute_coverage=${coverage.present}/${coverage.expected}` +
        (doubled.length ? ` ticks=${doubled.map((d) => `${d.tick}:${d.how}`).join(',')}` : ''),
    )
    if (read.deliveries.length === 0) {
      finding = { kind: 'incomplete', present: 0, expected: 0 }
      status = 'incomplete'
    } else if (coverage.expected >= MIN_JUDGED_MINUTES && coverage.present < coverage.expected * DELIVERY_COVERAGE_FLOOR) {
      finding = { kind: 'incomplete', present: coverage.present, expected: coverage.expected }
      status = 'incomplete'
    }
    if (doubled.length) status = 'doubled'
  }

  let alerted = false
  // Each signal is paged on its own, so a failure paging one never stops the other (L71).
  try {
    // A tick is paged once; a tick it has not paged pages at once, whatever else was paged today.
    const paged = await Promise.all(doubled.map((d) => quietSet(deps.kv, doubleRunTickPagedKey(d.tick))))
    const fresh = doubled.filter((_, i) => !paged[i])
    if (fresh.length && (await deps.send('double_run', doubleRunMessage({ kind: 'doubled', ticks: fresh })))) {
      alerted = true
      // Armed only on delivery, so a Slack outage does not buy a day of silence.
      await Promise.all(fresh.map((d) => deps.kv.put(doubleRunTickPagedKey(d.tick), new Date(nowMs).toISOString(), { expirationTtl: TICK_QUIET_SECONDS })))
    }
  } catch (e) {
    deps.error(`[cron-guard-watch] could not page double_run: ${formatErr(e)}`)
  }
  try {
    // A check that could not be made is said once a day, never read as "nothing ran twice" (L98).
    if (finding && !(await quietSet(deps.kv, DOUBLE_RUN_UNCHECKED_PAGED_KEY)) && (await deps.send('double_run', doubleRunMessage(finding)))) {
      alerted = true
      await deps.kv.put(DOUBLE_RUN_UNCHECKED_PAGED_KEY, new Date(nowMs).toISOString(), { expirationTtl: DAY_SECONDS })
    }
  } catch (e) {
    deps.error(`[cron-guard-watch] could not page the double_run check that could not be made: ${formatErr(e)}`)
  }
  return { kind: 'double_run', status, doubled: doubled.length, alerted }
}

export async function runCronGuardWatch(deps: CronGuardWatchDeps): Promise<CronGuardResult[]> {
  const nowMs = deps.now()
  const results: CronGuardResult[] = []
  // Each kind is judged on its own, so a failure on one never silences the others (L71).
  for (const kind of KINDS) {
    const threshold = CRON_GUARD_THRESHOLDS[kind]
    let counted: Counted
    if (kind === 'failed_open') {
      const c = await countFailOpens(deps, nowMs)
      if (!c) {
        results.push({ kind, status: 'unreadable' })
        continue
      }
      counted = c
    } else {
      try {
        counted = await countCronGuardEvents(deps.kv, kind, nowMs)
      } catch (e) {
        deps.error(`[cron-guard-watch] could not count ${kind}: ${formatErr(e)}`)
        results.push({ kind, status: 'unreadable' })
        continue
      }
    }
    const { count, capped, sources } = counted
    // Logged on every run, a quiet one included, so the thresholds can be checked
    // against real days (L172), and so a second record that stops keeping up shows
    // on a quiet day too.
    deps.log(`[cron-guard-watch] kind=${kind} count=${count}${capped ? '+' : ''} threshold=${threshold}${sourcesForLog(sources)}`)
    if (count < threshold) {
      results.push({ kind, status: 'under', count, capped, alerted: false })
      continue
    }
    const alerted = await pageOncePerDay(deps, kind, cronGuardMessage(kind, count, capped, sources), nowMs)
    results.push({ kind, status: 'over', count, capped, alerted })
  }
  results.push(await judgeDoubleRuns(deps, nowMs))
  return results
}

/** Wire the live dependencies and run the check. */
export async function runCronGuardWatchLive(supabase: SupabaseClient, kv: KVNamespace): Promise<CronGuardResult[]> {
  return runCronGuardWatch({
    kv,
    now: () => Date.now(),
    tailFailOpens: supabaseTailCopyReader(supabase),
    deliveries: supabaseDeliveryReader(supabase),
    send: (_page, message) =>
      forEachSlackOrg(supabase, 'cron-guard-watch', 'tell-only', (orgId) =>
        sendExportFailureAlert(supabase, orgId, null, { jobName: 'cron-guard-watch', ...message }),
      ).then(anyDelivered),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}
