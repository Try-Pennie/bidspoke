/**
 * A workflow's retry setting (#1693 item 7.4, Dan's decision of 2026-10-28:
 * "This should be configurable in the workflow. Let's default to 15s, cap 8
 * minutes. Most of these workflows lose value if it takes too long. We should
 * also have the ability to set it to not retry at all and just immediately
 * fail").
 *
 * It is the optional `retry` field at the top of an ops workflow's definition:
 *   absent                                         the default below
 *   { mode: 'backoff', base_seconds?, cap_seconds? }  wait base_seconds before
 *       the first retry, doubling each time, never more than cap_seconds; a
 *       number left out is the default's
 *   { mode: 'none' }                               the first real failure ends
 *       the run failed
 *
 * It governs only a retry after a real failure. A rate limit wait follows the
 * service's own reset time and a resource wait or a continuation its own clock,
 * and none of them spends an attempt or grows this wait (the ops run engine,
 * apps/worker/src/ops/run-invocation.ts, counts charged attempts only).
 *
 * The save routes refuse a bad setting by name (retrySaveProblems), and
 * validateDefinition reports it under the rule `retry`, through the same
 * function. The money engine does not read it, so a money workflow holding one
 * is refused rather than saved as a setting that does nothing. When this
 * shipped no stored workflow or saved version held a `retry` field (0 of 57
 * workflows and 0 of 614 versions, measured on production 2026-10-29).
 */
import type { WorkflowLane } from '@bidspoke/node-types'

export const RETRY_MODES = ['backoff', 'none'] as const
export type RetryMode = (typeof RETRY_MODES)[number]

/** Dan's default: 15 s before the first retry. */
export const DEFAULT_RETRY_BASE_SECONDS = 15
/** Dan's default: never more than 8 minutes between retries. */
export const DEFAULT_RETRY_CAP_SECONDS = 480
/** The longest wait a setting may name, the same 1 hour ceiling a rate limit wait is held to. */
export const RETRY_SECONDS_MAX = 3600

export type RetryPolicy =
  | { mode: 'backoff'; baseSeconds: number; capSeconds: number }
  | { mode: 'none' }
export type BackoffPolicy = Extract<RetryPolicy, { mode: 'backoff' }>

export const DEFAULT_RETRY_POLICY: BackoffPolicy = { mode: 'backoff', baseSeconds: DEFAULT_RETRY_BASE_SECONDS, capSeconds: DEFAULT_RETRY_CAP_SECONDS }

/** Every name a retry setting is refused by. */
export const RETRY_REFUSALS = [
  'retry_not_an_object',
  'retry_field_unknown',
  'retry_mode_unknown',
  'retry_base_invalid',
  'retry_cap_invalid',
  'retry_base_above_cap',
  'retry_none_takes_no_waits',
  'retry_on_money_lane',
] as const
export type RetryRefusal = (typeof RETRY_REFUSALS)[number]

export interface RetryProblem {
  reason: RetryRefusal
  message: string
}

const FIELDS = ['mode', 'base_seconds', 'cap_seconds'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RETRY_SECONDS_MAX

/** The setting's own problems, and the policy it names when it has none. */
function judge(setting: unknown): { policy: RetryPolicy | null; problems: RetryProblem[] } {
  if (setting === undefined) return { policy: DEFAULT_RETRY_POLICY, problems: [] }
  if (!isRecord(setting)) {
    return { policy: null, problems: [{ reason: 'retry_not_an_object', message: 'the retry setting must be an object with a mode' }] }
  }
  const problems: RetryProblem[] = []
  const unknown = Object.keys(setting).filter((k) => !(FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    problems.push({ reason: 'retry_field_unknown', message: `the retry setting has ${unknown.join(', ')}, which it does not know; it takes mode, base_seconds and cap_seconds` })
  }
  const { mode } = setting
  if (mode !== 'backoff' && mode !== 'none') {
    problems.push({ reason: 'retry_mode_unknown', message: `the retry mode must be backoff or none, not ${mode === undefined ? 'missing' : JSON.stringify(mode)}` })
    return { policy: null, problems }
  }
  const hasBase = Object.hasOwn(setting, 'base_seconds')
  const hasCap = Object.hasOwn(setting, 'cap_seconds')
  if (mode === 'none') {
    if (hasBase || hasCap) problems.push({ reason: 'retry_none_takes_no_waits', message: 'a workflow set not to retry takes no base_seconds or cap_seconds' })
    return { policy: problems.length === 0 ? { mode: 'none' } : null, problems }
  }
  const range = `a whole number of seconds from 1 to ${RETRY_SECONDS_MAX}`
  if (hasBase && !isSeconds(setting.base_seconds)) problems.push({ reason: 'retry_base_invalid', message: `the first retry's wait (base_seconds) must be ${range}, not ${JSON.stringify(setting.base_seconds)}` })
  if (hasCap && !isSeconds(setting.cap_seconds)) problems.push({ reason: 'retry_cap_invalid', message: `the longest wait between retries (cap_seconds) must be ${range}, not ${JSON.stringify(setting.cap_seconds)}` })
  if (problems.length > 0) return { policy: null, problems }
  const baseSeconds = hasBase ? (setting.base_seconds as number) : DEFAULT_RETRY_BASE_SECONDS
  const capSeconds = hasCap ? (setting.cap_seconds as number) : DEFAULT_RETRY_CAP_SECONDS
  if (baseSeconds > capSeconds) {
    return { policy: null, problems: [{ reason: 'retry_base_above_cap', message: `the first retry's wait (${baseSeconds} s) is longer than the longest wait between retries (${capSeconds} s)` }] }
  }
  return { policy: { mode: 'backoff', baseSeconds, capSeconds }, problems: [] }
}

/**
 * What a save of a definition whose `retry` field is `setting` is refused for,
 * on a workflow of `lane`. An absent setting is never refused.
 */
export function retrySaveProblems(setting: unknown, lane: WorkflowLane): RetryProblem[] {
  if (setting === undefined) return []
  if (lane === 'money') {
    return [{ reason: 'retry_on_money_lane', message: 'a retry setting is read only by ops workflows, and this is a money workflow' }]
  }
  return judge(setting).problems
}

/**
 * The policy a run is retried by. An absent setting is the default; one the
 * save would refuse is answered invalid with its problems, never read as the
 * default, so the caller decides and says so.
 */
export function readRetryPolicy(setting: unknown): { kind: 'ok'; policy: RetryPolicy } | { kind: 'invalid'; problems: RetryProblem[] } {
  const { policy, problems } = judge(setting)
  return policy === null ? { kind: 'invalid', problems } : { kind: 'ok', policy }
}

/**
 * The wait before the retry after the run's `failure`th charged attempt failed:
 * base_seconds doubled for each failure before it, never more than cap_seconds.
 * The doubling stops once it passes the cap, so no count of failures overflows it.
 */
export function retryDelaySeconds(policy: BackoffPolicy, failure: number): number {
  const n = Number.isNaN(failure) ? 1 : Math.max(1, Math.floor(failure))
  let wait = policy.baseSeconds
  for (let i = 1; i < n && wait < policy.capSeconds; i++) wait *= 2
  return Math.min(wait, policy.capSeconds)
}
