/**
 * The sf_limits sweep (#2336, phase 6 of #1689; plan: discussion #2329), one of
 * the ops minute tick's claimed sweeps (tick.ts TICK_SWEEPS).
 *
 * WHY. acquire_sf_lease refuses every ops Salesforce call but this one as
 * sf_budget_unmeasured once the org's sf_budget_readings row is missing or older
 * than 15 minutes, and as sf_budget_floor below the org's approved floor. The
 * Sforce-Limit-Info header on each ops response keeps the reading fresh while
 * ops is calling an org (connections/sf-budget-reading.ts), but an org ops has
 * not called for 15 minutes would refuse its next call for want of a reading,
 * and so never get one. This read is how a reading exists before the first
 * call and between calls. acquire_sf_lease exempts it from the budget checks
 * (L665): it still takes one lease of the org's pool, under its own approved
 * purpose share.
 *
 * WHAT. Once per measured Salesforce org (sf_limits_targets: orgs a
 * connection's verify measured, through one connection whose copy can serve
 * now), GET /services/data/vXX.X/limits through connectionFetch, purpose
 * sf_limits, and write the org's DailyApiRequests as its reading
 * (recordSfBudgetReading, source limits). Keyed on the MEASURED org (L66, L83).
 *
 * THE RESOURCE, as Salesforce documents it (REST API Developer Guide, version
 * 68.0, Winter '27, "Limits" and "List Org Limits", read 2026-10-19 from
 * https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_rest.pdf):
 *   "URI: /services/data/vXX.X/limits/", "HTTP Method: GET", "Formats: JSON".
 *   "Max is the limit for the org. Remaining is the number of calls or events
 *   left for the org." Example: "DailyApiRequests": { "Max": 5000,
 *   "Remaining": 4937 }, among many other limits each of the same shape.
 *   "Tabulated limits returned by the API are accurate within five minutes of
 *   resource consumption. For consistent values from this resource, avoid
 *   concurrent or rapid requests."
 *   "available in REST API version 29.0 and later for API users with the View
 *   Setup and Configuration permission", so a user without it is refused, which
 *   is a refusal by name here (http_403), never a reading.
 * Only the Versions URI does not count toward the org's allocation ("Limit Info
 * Header"), so each read costs one call: 360 a day per org at this interval.
 * Only DailyApiRequests is read, defensively: anything else in the body is
 * ignored, and a missing, non numeric, fractional, out of range or inconsistent
 * Max or Remaining is a named refusal, never a NaN in a comparison (L50).
 *
 * THE INTERVAL (SF_LIMITS_EVERY_SECONDS). Claimed every 240 s, so with the tick
 * landing once a minute the sweep runs every 4 minutes, or 5 when a tick's start
 * drifts a second early or one tick is missing (the tick logs about 14 to 37
 * percent fewer runs than a minute cron should, #2347). Two facts of
 * acquire_sf_lease bound it: a refusal at the floor answers retry_at = the
 * reading's measured_at plus 5 minutes, so a reading renewed every 5 minutes or
 * sooner is new by the time that retry comes; and a reading older than 15
 * minutes refuses every call, so three renewals in a row must fail before the
 * pool goes unmeasured. Faster gains nothing: Salesforce's figures are only
 * accurate within five minutes, and it asks not to be polled rapidly.
 *
 * FAILURES are keyed tick problems (OPS_TICK_PROBLEM_RULES), each at once,
 * because a sweep that runs every fourth tick can never be reported by three
 * ticks in a row (#2506): a held kind would be held for ever. So the hold is
 * done here instead, by the reading's age on the database clock. A failure the
 * next read may well not meet (a timeout, a busy pool, a 5xx, a rate limit, a
 * write the ops database did not take) is held, logged and counted while the
 * org's reading is younger than SF_LIMITS_HOLD_WHILE_YOUNGER_MS, which only the
 * last renewal (at most 6 minutes ago with a missed tick) can be; one older
 * than that means this is at least the second failure in a row, and it pages,
 * still minutes before the 15 minute mark. A reading kept fresh by other ops
 * traffic's Sforce-Limit-Info holds it too, which is right: the pool is
 * measured. A refusal the next read will meet again (a 4xx, a body that cannot
 * be read, a refusal by rule or state such as sf_cap_unset or needs_reauth)
 * pages at once.
 *
 * Each org is its own failure boundary with its own deadline, and the sweep
 * never throws. It stamps start and completion with the bidding Worker
 * (OpsGateway.opsJobStarted and opsJobCompleted, under SF_LIMITS_JOB); a stamp
 * that fails is counted and never stops the sweep, and a sweep that stops
 * stamping is the ops-sf-limits heartbeat's to page (cron-heartbeat.ts), on the
 * bidding Worker, which this Worker's health cannot silence (L71).
 */
import { SALESFORCE_API_VERSION } from '../lib/salesforce-api'
import { raceDeadline } from '../lib/alert-claim'
import { formatErr } from '../lib/format-error'
import { tickProblem, type OpsJobReport, type TickProblem } from '../lib/ops-gateway-contract'
import { salesforceInstanceOf } from './connections/minters/salesforce'
import { ConnectionRefusal, RequeueAt, type ConnectionRefusalCode } from './connections/refusals'
import type { SfLimitsTarget } from './ops-writes'

/** claim_ops_sweep's interval for sf_limits: see THE INTERVAL above. */
export const SF_LIMITS_EVERY_SECONDS = 240
/** The most measured orgs one sweep reads. One today (trypennie); each partner org joins only when its workflow is ported. */
export const SF_LIMITS_MAX_ORGS = 10
/** connectionFetch's own deadline for one read: the call is one small GET. */
export const SF_LIMITS_READ_DEADLINE_MS = 30_000
/** One org's whole read, the copy read, lease, login and write included. Past it the org's read is a failure of that org alone. */
export const SF_LIMITS_ORG_DEADLINE_MS = 45_000
/** A transient failure is held while the org's reading is younger than this: see FAILURES above. */
export const SF_LIMITS_HOLD_WHILE_YOUNGER_MS = 7 * 60_000
/** acquire_sf_lease's freshness bound, named in the page. */
export const SF_BUDGET_FRESH_MS = 15 * 60_000
/** A limits answer is a few kilobytes; past this the body is not one. */
export const SF_LIMITS_MAX_BODY_CHARS = 1_000_000

/** sf_budget_readings' columns are Postgres integers. */
const PG_INT_MAX = 2_147_483_647

/**
 * How the sweep treats each refusal connectionFetch can throw: transient when
 * the next read may well not meet it, refused when it will. Every code is
 * listed, so a new one fails to compile until it is decided here.
 */
export const SF_LIMITS_REFUSAL_KINDS = {
  connection_call_invalid: 'refused',
  connection_removed: 'refused',
  connection_withdrawn: 'refused',
  connection_copy_expired: 'refused',
  connection_not_found: 'refused',
  connection_copy_unreadable: 'transient',
  connection_service_unknown: 'refused',
  connection_service_mismatch: 'refused',
  connection_generation_older: 'refused',
  connection_candidate_not_allowed: 'refused',
  connection_seal_refused: 'refused',
  connection_target_invalid: 'refused',
  connection_url_invalid: 'refused',
  connection_host_not_declared: 'refused',
  sf_pool_busy: 'transient',
  sf_org_unmeasured: 'refused',
  sf_cap_unset: 'refused',
  sf_purpose_cap_unset: 'refused',
  // acquire_sf_lease exempts sf_limits from both budget checks; one reaching here is a defect.
  sf_budget_floor: 'refused',
  sf_budget_unmeasured: 'refused',
  sf_lease_unavailable: 'transient',
  connection_record_failed: 'refused',
  connection_needs_reauth: 'refused',
  connection_auth_unavailable: 'transient',
  connection_not_allowed: 'refused',
  connection_auth_check_unavailable: 'transient',
  connection_token_object_unavailable: 'transient',
  connection_auth_failed: 'refused',
  connection_network_error: 'transient',
  connection_aborted: 'transient',
  connection_timeout: 'transient',
  connection_body_not_resendable: 'refused',
  connection_rate_limited: 'transient',
} as const satisfies Record<ConnectionRefusalCode, 'transient' | 'refused'>

export type DailyApiRequestsRefusal =
  | 'not_json' | 'too_large' | 'not_an_object' | 'no_daily_api_requests' | 'not_whole' | 'out_of_range' | 'max_not_positive' | 'remaining_above_max'

export type DailyApiRequests =
  | { readonly ok: true; readonly max: number; readonly remaining: number }
  | { readonly ok: false; readonly refusal: DailyApiRequestsRefusal }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** DailyApiRequests of a parsed /limits body, or a named refusal. Remaining may be below zero: an org past its allocation. */
export function parseDailyApiRequests(body: unknown): DailyApiRequests {
  if (!isRecord(body)) return { ok: false, refusal: 'not_an_object' }
  const daily = body.DailyApiRequests
  if (!isRecord(daily)) return { ok: false, refusal: 'no_daily_api_requests' }
  const { Max: max, Remaining: remaining } = daily
  if (typeof max !== 'number' || typeof remaining !== 'number' || !Number.isInteger(max) || !Number.isInteger(remaining)) {
    return { ok: false, refusal: 'not_whole' }
  }
  if (max > PG_INT_MAX || remaining > PG_INT_MAX || remaining < -PG_INT_MAX) return { ok: false, refusal: 'out_of_range' }
  if (max < 1) return { ok: false, refusal: 'max_not_positive' }
  if (remaining > max) return { ok: false, refusal: 'remaining_above_max' }
  return { ok: true, max, remaining }
}

/** The Limits resource of the connection's declared instance. Throws connection_target_invalid by name. */
export function sfLimitsUrl(target: unknown): string {
  try {
    return `${salesforceInstanceOf(target).origin}/services/data/${SALESFORCE_API_VERSION}/limits`
  } catch {
    throw new ConnectionRefusal('connection_target_invalid', 'the Salesforce connection\'s target does not declare an https Salesforce instance_url')
  }
}

export interface SfLimitsSweepDeps {
  /** sf_limits_targets (ops-writes.ts readSfLimitsTargets). Throws on a failed read. */
  targets(limit: number): Promise<{ targets: SfLimitsTarget[]; reachedLimit: boolean }>
  /** connectionFetch, purpose sf_limits, for the target's connection: a response or a RequeueAt; a ConnectionRefusal is thrown. */
  read(target: SfLimitsTarget, url: string): Promise<Response | RequeueAt>
  /** record_sf_budget_reading, source limits. */
  record(sfOrgId: string, reading: { dailyApiMax: number; dailyApiRemaining: number }): Promise<unknown>
  /** OpsGateway.opsJobStarted(SF_LIMITS_JOB). */
  started(): Promise<void>
  /** OpsGateway.opsJobCompleted(SF_LIMITS_JOB, report). */
  completed(report: OpsJobReport): Promise<void>
  /** This Worker's clock: only the job report's start and finish read it. */
  now(): number
  /** The per org deadline (L524: injected). */
  sleep(ms: number): Promise<void>
  /** A JSON log line of names and counts, never a payload. */
  log(fields: Record<string, string | number | boolean | null>): void
}

export interface SfLimitsSweepResult {
  problems: TickProblem[]
  counts: Record<string, number>
}

type OrgOutcome =
  | { kind: 'recorded' }
  | { kind: 'refused'; cause: string }
  | { kind: 'unreadable'; refusal: DailyApiRequestsRefusal }
  | { kind: 'transient'; cause: string }

/** The body parsed, or why it is not a body to parse. */
async function readBody(response: Response): Promise<{ ok: true; body: unknown } | { ok: false; refusal: 'too_large' | 'not_json' }> {
  const text = await response.text()
  if (text.length > SF_LIMITS_MAX_BODY_CHARS) return { ok: false, refusal: 'too_large' }
  try {
    return { ok: true, body: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, refusal: 'not_json' }
  }
}

/** One org's read and write, classified. Never throws. */
async function readOrg(deps: SfLimitsSweepDeps, target: SfLimitsTarget): Promise<OrgOutcome> {
  let answer: Response | RequeueAt
  try {
    answer = await deps.read(target, sfLimitsUrl(target.target))
  } catch (err) {
    if (err instanceof ConnectionRefusal) return { kind: SF_LIMITS_REFUSAL_KINDS[err.code], cause: err.code }
    // Only a name: an error that is not a ConnectionRefusal was built by nothing that scrubs its message (F120).
    return { kind: 'refused', cause: `failed without a named refusal (${err instanceof Error ? err.name : 'not an Error'})` }
  }
  if (answer instanceof RequeueAt) return { kind: 'transient', cause: answer.cause }
  if (answer.status !== 200) {
    answer.body?.cancel().catch(() => undefined)
    return { kind: answer.status >= 500 ? 'transient' : 'refused', cause: `http_${answer.status}` }
  }
  let read: Awaited<ReturnType<typeof readBody>>
  try {
    read = await readBody(answer)
  } catch {
    return { kind: 'transient', cause: 'body_unread' }
  }
  if (!read.ok) return { kind: 'unreadable', refusal: read.refusal }
  const daily = parseDailyApiRequests(read.body)
  if (!daily.ok) return { kind: 'unreadable', refusal: daily.refusal }
  try {
    await deps.record(target.sfOrgId, { dailyApiMax: daily.max, dailyApiRemaining: daily.remaining })
  } catch {
    return { kind: 'transient', cause: 'record_failed' }
  }
  return { kind: 'recorded' }
}

/** The reading's age on the database clock, or null when the org has none. */
function readingAgeMs(target: SfLimitsTarget): number | null {
  if (target.readingMeasuredAt === null) return null
  const age = Date.parse(target.dbNow) - Date.parse(target.readingMeasuredAt)
  // An unreadable age is judged as old, the side that pages (L50).
  return Number.isFinite(age) ? Math.max(age, 0) : Number.POSITIVE_INFINITY
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} minutes`

export async function runSfLimitsSweep(deps: SfLimitsSweepDeps): Promise<SfLimitsSweepResult> {
  const startedAt = new Date(deps.now()).toISOString()
  const problems: TickProblem[] = []
  const counts: Record<string, number> = {}
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const stampFailed = (which: 'started' | 'completed', err: unknown) => {
    bump('sf_limits_stamps_failed')
    deps.log({ event: 'ops_tick', step: 'sf_limits_stamp_failed', stamp: which, error: formatErr(err) })
  }

  try {
    await deps.started()
  } catch (err) {
    stampFailed('started', err)
  }

  let targets: SfLimitsTarget[] = []
  try {
    const read = await deps.targets(SF_LIMITS_MAX_ORGS)
    targets = read.targets
    counts.sf_limits_orgs = targets.length
    if (read.reachedLimit) {
      problems.push(tickProblem('sf_limits_orgs_limit', `The sf_limits sweep found ${SF_LIMITS_MAX_ORGS} measured Salesforce orgs, its limit, so any past them had no budget reading renewed.`))
    }
  } catch (err) {
    problems.push(tickProblem('sf_limits_failed', `The sf_limits sweep could not read which Salesforce orgs are measured (${formatErr(err)}), so no budget reading was renewed; it runs again in ${SF_LIMITS_EVERY_SECONDS / 60} minutes.`))
  }

  const outcomes = await Promise.all(targets.map(async (t) => {
    const raced = await raceDeadline(() => readOrg(deps, t), SF_LIMITS_ORG_DEADLINE_MS, (ms) => deps.sleep(ms))
    if (raced.kind === 'ok') return raced.value
    if (raced.kind === 'timed_out') return { kind: 'transient', cause: `deadline of ${SF_LIMITS_ORG_DEADLINE_MS / 1000} s` } as const
    return { kind: 'refused', cause: 'failed without a named refusal' } as const
  }))

  outcomes.forEach((outcome, i) => {
    const t = targets[i]
    const org = t.sfOrgId
    switch (outcome.kind) {
      case 'recorded':
        bump('sf_limits_recorded')
        return
      case 'unreadable':
        problems.push(tickProblem('sf_limits_unreadable', `Salesforce org ${org} answered its /limits read with a DailyApiRequests the ops Worker cannot read (${outcome.refusal}), so no reading was recorded; once its reading is ${minutes(SF_BUDGET_FRESH_MS)} old every ops Salesforce call to that org is refused sf_budget_unmeasured.`, org))
        return
      case 'refused':
        problems.push(tickProblem('sf_limits_refused', `The /limits read of Salesforce org ${org} was refused (${outcome.cause}), and the next read will meet the same; once its reading is ${minutes(SF_BUDGET_FRESH_MS)} old every ops Salesforce call to that org is refused sf_budget_unmeasured.`, org))
        return
      case 'transient': {
        const age = readingAgeMs(t)
        if (age !== null && age < SF_LIMITS_HOLD_WHILE_YOUNGER_MS) {
          bump('sf_limits_held')
          deps.log({ event: 'ops_tick', step: 'sf_limits_held', sf_org_id: org, cause: outcome.cause, reading_age_ms: age })
          return
        }
        const state = age === null ? 'it has no budget reading, so every ops Salesforce call to it is already refused sf_budget_unmeasured'
          : `its budget reading is ${Number.isFinite(age) ? minutes(age) : 'of unreadable'} old; at ${minutes(SF_BUDGET_FRESH_MS)} every ops Salesforce call to it is refused sf_budget_unmeasured`
        problems.push(tickProblem('sf_limits_read_failed', `The /limits read of Salesforce org ${org} failed again (${outcome.cause}) and ${state}.`, org))
        return
      }
    }
  })

  const report: OpsJobReport = { started_at: startedAt, finished_at: new Date(deps.now()).toISOString(), counts: { ...counts } }
  try {
    await deps.completed(report)
  } catch (err) {
    stampFailed('completed', err)
  }
  return { problems, counts }
}
