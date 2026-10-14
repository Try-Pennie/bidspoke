/**
 * The incident drain (#2100, under #818): moves the incident outbox's events
 * (incident-outbox.ts) from KV into the alert_incidents table, every five minutes.
 *
 * One event at a time, in the order the keys sort (the order they were written):
 *  - read with a direct get, because a KV list is eventually consistent and can
 *    name a key another run has already drained;
 *  - written through the transition's SQL function, which returns the row it
 *    wrote. supabase-js reports no error for a write that touched nothing, so a
 *    write counts as landed only when a row id came back (L583, #583);
 *  - removed only after that, so a failed or unconfirmed write is retried next
 *    run, and a failure never stops the events behind it;
 *  - set aside (copied to incident-outbox-refused:, then removed) when the
 *    database refuses it outright or it cannot be read as an event, so one bad
 *    event cannot hold the drain or its alert for ever. Set aside events are
 *    reported at once.
 *
 * Then every open incident in the record has its KV marker read directly. A
 * marker gone (or holding a later incident's start) is reported to the database,
 * which closes the row as lapsed, with no end time, the second time in a row it
 * is told so (record_alert_incident_marker_check). Two drains, not one, because
 * the incident's own ended event can lag the deletion of its marker in a list.
 *
 * It alerts (a titled alert, under the standing backoff, to every organization's
 * Slack) when events have waited over an hour, when two drains in a row failed,
 * or when an event was set aside, and says so once the record has caught up.
 * The incidents themselves were alerted on whatever happens here: this is only
 * their record.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { recoveryKey } from './alert-recovery'
import { isIncidentSignal } from './incident-signals'
import { INCIDENT_OUTBOX_PREFIX, outboxKeyTime, parseIncidentEvent, type IncidentEvent } from './incident-outbox'
import { clearCondition, readCondition, type BackoffKv } from './alert-backoff'
import { deliverAll, postStanding, type SlackTarget } from './standing-alert'
import type { AlertClaims } from './alert-claim'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'

export const INCIDENT_DRAIN_JOB = 'incident-drain'
export const INCIDENT_OUTBOX_REFUSED_PREFIX = 'incident-outbox-refused:'
/** The drain's own standing alert, under the shared backoff. Mute it with `incident-drain-alert:cooldown`. */
export const INCIDENT_DRAIN_ALERT_KEY = 'incident-drain-alert'
/** Events waiting longer than this mean the record has fallen behind. */
export const OUTBOX_WAIT_ALERT_MS = 60 * 60 * 1000
/** How long a set aside event is kept for somebody to read. */
export const REFUSED_TTL_SECONDS = 30 * 24 * 60 * 60
const LAST_FAILED_KEY = 'incident-drain:last-failed'
/** Long enough to span one five minute gap and a late tick, short enough that a failure an hour ago is not "the last run". */
const LAST_FAILED_TTL_SECONDS = 12 * 60
const CONDITION_TTL_SECONDS = 2 * 24 * 60 * 60
/** Open incidents are a handful at a time (#2098: about 27 a month); the cap is far above that and under PostgREST's 1000. */
const OPEN_READ_LIMIT = 500

export interface DrainKv extends BackoffKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>
}

export interface TitledMessage {
  title: string
  errors: string[]
  context?: string
  fixHint?: string
  repeat?: string
}

export interface IncidentDrainDeps {
  /** IDEMPOTENCY: the outbox, the markers, and this drain's own alert state. */
  kv: DrainKv
  supabase: SupabaseClient
  now: () => number
  claims?: AlertClaims
  resolveSlack: () => Promise<SlackTarget[]>
  send: (slack: SlackTarget, message: TitledMessage) => Promise<boolean>
  log?: (line: string) => void
}

export interface IncidentDrainSummary {
  listed: number
  applied: number
  refused: number
  failed: number
  /** Events still in the outbox after this run, because their write failed. */
  waiting: number
  oldestWaitingMs: number | null
  suspect: number
  lapsed: number
  alerted: boolean
  allClear: boolean
  errors: string[]
}

type RpcResult = { data: unknown; error: { message: string; code?: string } | null }

/** A refusal the same event will meet again: bad data or a constraint (SQLSTATE classes 22 and 23). */
function isPermanent(code: string | undefined): boolean {
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))
}

function callFor(e: IncidentEvent): { fn: string; args: Record<string, unknown> } {
  const base = {
    p_signal: e.signal,
    p_subject: e.subject,
    p_subject_label: e.subjectLabel,
    p_scope: e.scope,
    p_organization_id: e.organizationId,
    p_started_at: e.startedAt,
  }
  if (e.type === 'opened') {
    return { fn: 'record_alert_incident_opened', args: { ...base, p_previous_started_at: e.previousStartedAt ?? null, p_window_minutes: e.windowMinutes } }
  }
  if (e.type === 'paged') {
    return { fn: 'record_alert_incident_paged', args: { ...base, p_paged_at: e.at, p_event_id: e.id, p_window_minutes: e.windowMinutes } }
  }
  return {
    fn: 'record_alert_incident_ended',
    args: { ...base, p_ended_at: e.endedAt, p_reason: e.reason, p_successor: e.successor ?? null, p_window_minutes: e.windowMinutes },
  }
}

async function listOutbox(kv: DrainKv): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: INCIDENT_OUTBOX_PREFIX, ...(cursor ? { cursor } : {}) })
    for (const k of page.keys) names.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return names.sort()
}

export async function runIncidentDrain(deps: IncidentDrainDeps): Promise<IncidentDrainSummary> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const nowMs = deps.now()
  const s: IncidentDrainSummary = { listed: 0, applied: 0, refused: 0, failed: 0, waiting: 0, oldestWaitingMs: null, suspect: 0, lapsed: 0, alerted: false, allClear: false, errors: [] }
  const refusedReasons: string[] = []
  const waitingSince: number[] = []

  const setAside = async (key: string, raw: string, reason: string) => {
    try {
      // Copied first, removed second: never destroy the only copy before its replacement exists (L5).
      await deps.kv.put(`${INCIDENT_OUTBOX_REFUSED_PREFIX}${key.slice(INCIDENT_OUTBOX_PREFIX.length)}`, JSON.stringify({ reason, raw }), { expirationTtl: REFUSED_TTL_SECONDS })
      await deps.kv.delete(key)
      s.refused += 1
      refusedReasons.push(reason)
      log(`[incident-drain] event=incident_event_set_aside key=${key} reason=${JSON.stringify(reason)}`)
    } catch (e) {
      s.failed += 1
      s.errors.push(`${key}: could not be set aside: ${formatErr(e)}`)
      const t = outboxKeyTime(key)
      if (t !== null) waitingSince.push(t)
    }
  }

  let listedOk = true
  let keys: string[] = []
  try {
    keys = await listOutbox(deps.kv)
  } catch (e) {
    listedOk = false
    s.errors.push(`the incident outbox could not be listed: ${formatErr(e)}`)
  }
  s.listed = keys.length

  for (const key of keys) {
    let raw: string | null
    try {
      raw = await deps.kv.get(key)
    } catch (e) {
      s.failed += 1
      s.errors.push(`${key}: could not be read: ${formatErr(e)}`)
      const t = outboxKeyTime(key)
      if (t !== null) waitingSince.push(t)
      continue
    }
    // Listed but gone: another run drained it after the list was taken.
    if (raw === null) continue

    const event = parseIncidentEvent(raw)
    if ('error' in event) {
      await setAside(key, raw, `not an event the record can take: ${event.error}`)
      continue
    }

    const { fn, args } = callFor(event)
    let result: RpcResult
    try {
      result = (await deps.supabase.rpc(fn, args)) as RpcResult
    } catch (e) {
      result = { data: null, error: { message: formatErr(e) } }
    }
    if (result.error) {
      if (isPermanent(result.error.code)) {
        await setAside(key, raw, `${fn} refused it: ${result.error.message}`)
        continue
      }
      s.failed += 1
      s.errors.push(`${event.type} ${event.signal} ${event.subject}: ${result.error.message}`)
      const t = outboxKeyTime(key)
      if (t !== null) waitingSince.push(t)
      continue
    }
    if (typeof result.data !== 'string' || result.data.length === 0) {
      s.failed += 1
      s.errors.push(`${event.type} ${event.signal} ${event.subject}: ${fn} returned no row, so the write is not known to have landed`)
      const t = outboxKeyTime(key)
      if (t !== null) waitingSince.push(t)
      continue
    }
    try {
      await deps.kv.delete(key)
      s.applied += 1
    } catch (e) {
      // Written but not removed: the next run writes it again, which every
      // transition function takes without counting it twice.
      s.applied += 1
      s.errors.push(`${key}: written but could not be removed: ${formatErr(e)}`)
    }
  }

  s.waiting = waitingSince.length
  s.oldestWaitingMs = waitingSince.length > 0 ? nowMs - Math.min(...waitingSince) : null

  // Lapses, judged only when the outbox was read: an unread outbox may hold the
  // very ended event that would have closed the row properly.
  if (listedOk) await checkOpenIncidents(deps, nowMs, s)

  await alertOnDrain(deps, nowMs, s, refusedReasons)
  return s
}

async function checkOpenIncidents(deps: IncidentDrainDeps, nowMs: number, s: IncidentDrainSummary): Promise<void> {
  const { data, error } = await deps.supabase
    .from('alert_incidents')
    .select('id, signal, subject, started_at')
    .is('ended_reason', null)
    .order('started_at', { ascending: true })
    .limit(OPEN_READ_LIMIT)
  if (error) {
    s.errors.push(`the open incidents could not be read, so none was checked for a lapse: ${error.message}`)
    return
  }
  const rows = (data ?? []) as Array<{ id: string; signal: string; subject: string; started_at: string }>
  if (rows.length >= OPEN_READ_LIMIT) s.errors.push(`${rows.length} open incidents, the most one run reads; the newest were not checked for a lapse`)
  for (const row of rows) {
    if (!isIncidentSignal(row.signal)) {
      s.errors.push(`open incident ${row.id} names signal ${row.signal}, which nothing arms any more, so its marker cannot be read`)
      continue
    }
    try {
      const marker = await deps.kv.get(recoveryKey(row.signal, row.subject))
      // Present when it holds this incident's start or an earlier one (a start
      // moved earlier); a later start is a different, newer incident.
      const present = marker !== null && !(Date.parse(marker) > Date.parse(row.started_at))
      const { data: verdict, error: checkError } = (await deps.supabase.rpc('record_alert_incident_marker_check', {
        p_id: row.id,
        p_marker_present: present,
        p_now: new Date(nowMs).toISOString(),
      })) as RpcResult
      if (checkError) {
        s.errors.push(`open incident ${row.id}: the lapse check failed: ${checkError.message}`)
        continue
      }
      if (verdict === 'lapsed') s.lapsed += 1
      else if (verdict === 'suspect') s.suspect += 1
    } catch (e) {
      s.errors.push(`open incident ${row.id}: the lapse check failed: ${formatErr(e)}`)
    }
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

async function alertOnDrain(deps: IncidentDrainDeps, nowMs: number, s: IncidentDrainSummary, refusedReasons: string[]): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const failedRun = s.errors.length > 0
  let failedLastRun = false
  try {
    failedLastRun = (await deps.kv.get(LAST_FAILED_KEY)) !== null
    if (failedRun) await deps.kv.put(LAST_FAILED_KEY, new Date(nowMs).toISOString(), { expirationTtl: LAST_FAILED_TTL_SECONDS })
    else if (failedLastRun) await deps.kv.delete(LAST_FAILED_KEY)
  } catch (e) {
    s.errors.push(`the drain's own failure stamp could not be read or written: ${formatErr(e)}`)
  }

  const backlog = s.oldestWaitingMs !== null && s.oldestWaitingMs > OUTBOX_WAIT_ALERT_MS
  const failing = failedRun && failedLastRun
  const setAside = s.refused > 0

  const claim = async (key: string) => (deps.claims ? deps.claims.claim(key, ALERT_CLAIM_TTL_SECONDS) : true)
  const release = async (key: string) => { if (deps.claims) await deps.claims.release(key) }

  try {
    if (backlog || failing || setAside) {
      const lines: string[] = []
      const problems: string[] = []
      if (backlog) {
        problems.push('backlog')
        lines.push(`${plural(s.waiting, 'incident event has', 'incident events have')} waited over an hour to be written to the record. The oldest has waited ${Math.round(s.oldestWaitingMs! / 60_000)} minutes.`)
      }
      if (failing) {
        problems.push('failing')
        lines.push(`The last two drains could not write to the record. The first error was: ${s.errors[0]}.`)
      }
      if (setAside) {
        problems.push('set-aside')
        lines.push(`${plural(s.refused, 'incident event', 'incident events')} could not be written and ${s.refused === 1 ? 'was' : 'were'} set aside. The first reason was: ${refusedReasons[0]}.`)
      }
      s.alerted = await postStanding({
        kv: deps.kv,
        key: INCIDENT_DRAIN_ALERT_KEY,
        claim,
        release,
        targets: deps.resolveSlack,
        nowMs,
        alert: { problem: problems.join('+'), details: [String(s.waiting), String(s.refused)] },
        conditionTtlSeconds: CONDITION_TTL_SECONDS,
        logPrefix: '[incident-drain]',
        log,
        send: async (slack, repeat) => (await deps.send(slack, {
          title: 'Incident record behind',
          errors: lines,
          context: 'The incidents themselves were still alerted on. Only their record is behind.',
          fixHint: 'Read the incident-drain log lines for the cause. Set aside events are kept for 30 days under incident-outbox-refused: in the IDEMPOTENCY KV.',
          ...(repeat ? { repeat } : {}),
        })) ? 'sent' : null,
      })
      return
    }
    // Healthy. If the alert stood, say the record caught up, then stand it down.
    if ((await readCondition(deps.kv, INCIDENT_DRAIN_ALERT_KEY)) !== null) {
      const delivered = await deliverAll(await deps.resolveSlack(), (slack) => deps.send(slack, {
        title: 'Incident record caught up',
        errors: ['Every waiting incident event has been written to the record.'],
      }))
      if (delivered) {
        await clearCondition(deps.kv, INCIDENT_DRAIN_ALERT_KEY)
        s.allClear = true
      }
    }
  } catch (e) {
    s.errors.push(`the drain's own alert failed: ${formatErr(e)}`)
  }
}
