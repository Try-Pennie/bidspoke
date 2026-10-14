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

interface RecordKv {
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

/** One key per event, named by its time so the count needs no reads. */
export async function recordCronGuardEvent(kv: RecordKv, kind: CronGuardKind, nowMs: number): Promise<void> {
  const countdown = String(TIME_CEILING_MS - Math.floor(nowMs)).padStart(TIME_WIDTH, '0')
  await kv.put(`${eventPrefix(kind)}${countdown}:${crypto.randomUUID()}`, '1', { expirationTtl: RECORD_TTL_SECONDS })
}

/** Events of one kind in the 24 hours to `nowMs`. A failed list THROWS (L98). */
export async function countCronGuardEvents(
  kv: ListKv,
  kind: CronGuardKind,
  nowMs: number,
  opts: { maxPages?: number } = {},
): Promise<{ count: number; capped: boolean }> {
  const prefix = eventPrefix(kind)
  const since = nowMs - WINDOW_MS
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES
  let count = 0
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
      if (at <= since) return { count, capped: false }
      if (at <= nowMs) count++
    }
    if (res.list_complete || !res.cursor) return { count, capped: false }
    cursor = res.cursor
  }
  return { count, capped: true }
}

export interface CronGuardMessage {
  title: string
  errors: string[]
  context: string
  fixHint?: string
}

/** The page for one kind, in the titled alert shape. */
export function cronGuardMessage(kind: CronGuardKind, count: number, capped: boolean): CronGuardMessage {
  const n = `${capped ? 'at least ' : ''}${count.toLocaleString('en-US')}`
  if (kind === 'failed_open') {
    const times = count === 1 && !capped ? 'once' : `${n} times`
    return {
      title: 'Cron guard ran ticks unguarded',
      errors: [`The cron guard could not reach its claim store ${times} in the last 24 hours, so those ticks ran without it.`],
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
  /** Delivers one page; true when anyone was told. */
  send: (kind: CronGuardKind, count: number, capped: boolean) => Promise<boolean>
  log: (line: string) => void
  error: (line: string) => void
}

export type CronGuardResult =
  | { kind: CronGuardKind; status: 'unreadable' }
  | { kind: CronGuardKind; status: 'under' | 'over'; count: number; capped: boolean; alerted: boolean }

export async function runCronGuardWatch(deps: CronGuardWatchDeps): Promise<CronGuardResult[]> {
  const nowMs = deps.now()
  const results: CronGuardResult[] = []
  // Each kind is judged on its own, so a failure on one never silences the other (L71).
  for (const kind of KINDS) {
    const threshold = CRON_GUARD_THRESHOLDS[kind]
    let counted: { count: number; capped: boolean }
    try {
      counted = await countCronGuardEvents(deps.kv, kind, nowMs)
    } catch (e) {
      deps.error(`[cron-guard-watch] could not count ${kind}: ${formatErr(e)}`)
      results.push({ kind, status: 'unreadable' })
      continue
    }
    const { count, capped } = counted
    // Logged on every run, a quiet one included, so the thresholds can be checked
    // against real days (L172).
    deps.log(`[cron-guard-watch] kind=${kind} count=${count}${capped ? '+' : ''} threshold=${threshold}`)
    if (count < threshold) {
      results.push({ kind, status: 'under', count, capped, alerted: false })
      continue
    }
    let alerted = false
    try {
      // A quiet we could not read lets the page through: a duplicate page beats a missed one.
      const quiet = await deps.kv.get(cronGuardPagedKey(kind)).catch(() => null)
      if (quiet === null) {
        alerted = await deps.send(kind, count, capped)
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
    send: (kind, count, capped) =>
      forEachSlackOrg(supabase, 'cron-guard-watch', (orgId) =>
        sendExportFailureAlert(supabase, orgId, null, { jobName: 'cron-guard-watch', ...cronGuardMessage(kind, count, capped) }),
      ).then((rs) => rs.some(Boolean)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
}
