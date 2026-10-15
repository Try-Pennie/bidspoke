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
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { forEachSlackOrg } from './alert-fanout'
import { sendExportFailureAlert } from './slack'

export type CronGuardKind = 'failed_open' | 'skipped_duplicate'

const KINDS: CronGuardKind[] = ['failed_open', 'skipped_duplicate']

/**
 * Agreed with Dan on 2026-10-14. A fail-open is rare and each one risks a job
 * running twice, so three in a day is a guard that has stopped working. A
 * duplicate is absorbed, so only a sustained stretch is worth a page: 30 is
 * about half an hour of the minute cron doubling, and the 2026-10-08 doubling
 * produced well over a thousand a day.
 */
export const CRON_GUARD_THRESHOLDS: Record<CronGuardKind, number> = { failed_open: 3, skipped_duplicate: 30 }

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

/** The page for one kind, in the titled alert shape. */
export function cronGuardMessage(kind: CronGuardKind, count: number, capped: boolean, sources?: CronGuardSources): CronGuardMessage {
  const n = `${capped ? 'at least ' : ''}${count.toLocaleString('en-US')}`
  if (kind === 'failed_open') {
    const times = count === 1 && !capped ? 'once' : `${n} times`
    return {
      title: 'Cron guard ran ticks unguarded',
      errors: [
        `The cron guard could not reach its claim store ${times} in the last 24 hours, so those ticks ran without it.`,
        ...sourceLines(sources),
      ],
      context: 'A tick Cloudflare delivered twice in that time may have run its jobs twice.',
      fixHint: 'Search Workers Logs for "[cron-once] FAILED OPEN". Each line says why the claim did not answer.',
    }
  }
  return {
    title: 'Cloudflare is delivering cron ticks twice',
    errors: [`Cloudflare delivered ${n} cron ${count === 1 && !capped ? 'tick' : 'ticks'} a second time in the last 24 hours.`],
    context: 'The cron guard skipped every second copy, so no job ran twice. This is Cloudflare\'s doing. Nothing here needs fixing.',
  }
}

export interface CronGuardWatchDeps {
  kv: CronGuardKv
  now: () => number
  /** The fail-opens' second record, the tail worker's copy of their log lines (#2166). */
  tailFailOpens: TailCopyReader
  /** Delivers one page; true when anyone was told. `sources` is set for fail-opens. */
  send: (kind: CronGuardKind, count: number, capped: boolean, sources?: CronGuardSources) => Promise<boolean>
  log: (line: string) => void
  error: (line: string) => void
}

export type CronGuardResult =
  | { kind: CronGuardKind; status: 'unreadable' }
  | { kind: CronGuardKind; status: 'under' | 'over'; count: number; capped: boolean; alerted: boolean }

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

export async function runCronGuardWatch(deps: CronGuardWatchDeps): Promise<CronGuardResult[]> {
  const nowMs = deps.now()
  const results: CronGuardResult[] = []
  // Each kind is judged on its own, so a failure on one never silences the other (L71).
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
    let alerted = false
    try {
      // A quiet we could not read lets the page through: a duplicate page beats a missed one.
      const quiet = await deps.kv.get(cronGuardPagedKey(kind)).catch(() => null)
      if (quiet === null) {
        alerted = await deps.send(kind, count, capped, sources)
        // Armed only on delivery, so a Slack outage does not buy a day of silence.
        if (alerted) await deps.kv.put(cronGuardPagedKey(kind), new Date(nowMs).toISOString(), { expirationTtl: DAY_SECONDS })
      }
    } catch (e) {
      deps.error(`[cron-guard-watch] could not page ${kind}: ${formatErr(e)}`)
    }
    results.push({ kind, status: 'over', count, capped, alerted })
  }
  return results
}

/** Wire the live dependencies and run the check. */
export async function runCronGuardWatchLive(supabase: SupabaseClient, kv: KVNamespace): Promise<CronGuardResult[]> {
  return runCronGuardWatch({
    kv,
    now: () => Date.now(),
    tailFailOpens: supabaseTailCopyReader(supabase),
    send: (kind, count, capped, sources) =>
      forEachSlackOrg(supabase, 'cron-guard-watch', (orgId) =>
        sendExportFailureAlert(supabase, orgId, null, { jobName: 'cron-guard-watch', ...cronGuardMessage(kind, count, capped, sources) }),
      ).then((rs) => rs.some(Boolean)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}
