/**
 * The TriggerConfig union (#1947): what starts a workflow, as a definition
 * stores it in `definition.trigger`, in one home for both apps.
 *
 * Two types exist, because two can be produced and read today:
 * - `http_webhook`, the trigger of every stored workflow. The money engine runs
 *   it through the webhook route. It is the canvas's default for a new
 *   workflow on either lane, so the ops lane accepts it too.
 * - `schedule`, the shape in ./schedule/schedule.ts. Only the ops minute cron
 *   reads one (#1949), so it belongs to the ops lane. Nothing on the money lane
 *   fires a schedule, so a money workflow carrying one is refused by name.
 *
 * The other trigger kinds the #1945 plan names (slack_event, email_inbound,
 * poll, app_webhook, call) have no settings shape and no reader yet. They are
 * PLANNED_TRIGGER_TYPES, not members of the union: the validator refuses each
 * by name as not built, which tells it apart from a spelling nobody has heard
 * of. Each joins the union with the change that builds its reader, and the ops
 * database already accepts all of them as a run's trigger_kind (#1948): the
 * vocabulary test in apps/web holds the two lists together.
 *
 * The plan's `respond: 'sync' | 'ack_then_run'` on http_webhook is left out
 * for the same reason: nothing answers a webhook before running it, so the
 * field would describe a behaviour that does not exist.
 */
import { assertNever, type WorkflowLane } from '@bidspoke/node-types'
import { validateSchedule, type ScheduleConfig } from './schedule'

export const TRIGGER_TYPES = ['http_webhook', 'schedule'] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

/** Named by the plan, with no settings shape and no reader: refused as not built. */
export const PLANNED_TRIGGER_TYPES = ['slack_event', 'email_inbound', 'poll', 'app_webhook', 'call'] as const
export type PlannedTriggerType = (typeof PLANNED_TRIGGER_TYPES)[number]

/**
 * A spelling older rows hold for a current type. `webhook` was written by an
 * earlier build and survives on 14 saved versions and one soft deleted
 * workflow (measured 2026-10-22); nothing writes it now and the engine never
 * reads the type, so it is a warning rather than a refusal of a restore.
 */
export const LEGACY_TRIGGER_SPELLINGS = { webhook: 'http_webhook' } as const satisfies Record<string, TriggerType>

/** The lanes whose engine reads each trigger type. */
export const TRIGGER_LANES: Record<TriggerType, readonly WorkflowLane[]> = {
  http_webhook: ['money', 'ops'],
  schedule: ['ops'],
}

// A known failure signal whose per-execution Slack page is muted; instead one
// aggregated page fires when matching failures cross a rate threshold (#248).
export interface MutedFailureSignal {
  /** Case-insensitive substring matched against the failure's error_message. */
  match: string
  /** Aggregated alert fires when matching failures reach this many in the window. */
  count: number
  /** Trailing window, in minutes, the count is measured over. */
  window_minutes: number
  /** Per-signal cooldown between aggregated alerts. Defaults to 30 min. */
  cooldown_minutes?: number
}

export interface HttpWebhookConfig {
  method: string
  auth_method: 'api_key' | 'none'
  idempotency?: {
    enabled: boolean
    derive_from_fields?: string[]
    ttl_seconds?: number
  }
  duration_alert_ms?: number
  /**
   * Node namespaces that count as "successful" when the walk ends on one
   * of them. Empty or missing = no runs are marked Successful; everything
   * non-failed goes to Completed.
   */
  success_node_namespaces?: string[]
  /** Failure signals whose per-run page is muted in favor of a rate alert (#248). */
  muted_failure_signals?: MutedFailureSignal[]
}

export interface HttpWebhookTrigger {
  type: 'http_webhook'
  config: HttpWebhookConfig
}

export interface ScheduleTrigger {
  type: 'schedule'
  config: ScheduleConfig
}

export type TriggerConfig = HttpWebhookTrigger | ScheduleTrigger

export const TRIGGER_REFUSALS = [
  'trigger_missing',
  'trigger_type_unknown',
  'trigger_type_not_built',
  'trigger_not_on_lane',
  'trigger_config_invalid',
  'trigger_legacy_spelling',
] as const
export type TriggerRefusal = (typeof TRIGGER_REFUSALS)[number]

export interface TriggerProblem {
  reason: TriggerRefusal
  /** A warning is reported and never refuses a save. */
  severity: 'error' | 'warning'
  message: string
  /** For a schedule's settings, the schedule's own refusal (SCHEDULE_REFUSALS). */
  detail?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTriggerType = (v: unknown): v is TriggerType => (TRIGGER_TYPES as readonly unknown[]).includes(v)
const isPlannedType = (v: unknown): v is PlannedTriggerType => (PLANNED_TRIGGER_TYPES as readonly unknown[]).includes(v)
const positiveNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
const stringList = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string')

const invalid = (message: string, detail?: string): TriggerProblem => ({
  reason: 'trigger_config_invalid',
  severity: 'error',
  message,
  ...(detail === undefined ? {} : { detail }),
})

/** The muted signal fields the failure rate check reads (lib/failure-rate.ts). */
function mutedSignalProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'muted_failure_signals must be a list'
  for (const s of value) {
    if (!isRecord(s) || typeof s.match !== 'string' || s.match.trim() === '') return 'each muted failure signal needs the text it matches'
    if (!positiveNumber(s.count) || !positiveNumber(s.window_minutes)) return 'each muted failure signal needs a count and a window in minutes'
    if (s.cooldown_minutes !== undefined && !positiveNumber(s.cooldown_minutes)) return 'a muted failure signal cooldown is a number of minutes'
  }
  return null
}

/**
 * The fields of an http webhook's settings, judged only for the type each is
 * read as. A key nothing reads (custom_response on 152 saved versions) is
 * left alone: it was never part of the contract and refusing it would refuse
 * a restore of a version that runs.
 */
function httpConfigProblems(config: Record<string, unknown>): TriggerProblem[] {
  const problems: TriggerProblem[] = []
  if (typeof config.method !== 'string' || config.method.trim() === '') problems.push(invalid('an http webhook needs its method'))
  if (config.auth_method !== 'api_key' && config.auth_method !== 'none') problems.push(invalid(`auth_method ${String(config.auth_method)} is not api_key or none`))
  if (config.idempotency !== undefined) {
    const i = config.idempotency
    if (!isRecord(i) || typeof i.enabled !== 'boolean') problems.push(invalid('idempotency needs enabled set to true or false'))
    else if ((i.derive_from_fields !== undefined && !stringList(i.derive_from_fields)) || (i.ttl_seconds !== undefined && !positiveNumber(i.ttl_seconds))) {
      problems.push(invalid('idempotency fields are a list of field names and a number of seconds'))
    }
  }
  if (config.duration_alert_ms !== undefined && !positiveNumber(config.duration_alert_ms)) problems.push(invalid('duration_alert_ms is a number of milliseconds above zero'))
  if (config.success_node_namespaces !== undefined && !stringList(config.success_node_namespaces)) problems.push(invalid('success_node_namespaces is a list of step ids'))
  if (config.muted_failure_signals !== undefined) {
    const p = mutedSignalProblem(config.muted_failure_signals)
    if (p) problems.push(invalid(p))
  }
  return problems
}

function configProblems(trigger: TriggerConfig): TriggerProblem[] {
  if (!isRecord(trigger.config)) return [invalid(`a ${trigger.type} trigger needs its settings`)]
  switch (trigger.type) {
    case 'http_webhook':
      return httpConfigProblems(trigger.config)
    case 'schedule':
      return validateSchedule(trigger.config).map((p) => invalid(p.message, p.reason))
    default:
      return assertNever(trigger, 'trigger type')
  }
}

/**
 * Every problem with a stored trigger for a workflow of `lane`. An empty list
 * means the trigger is one this lane's engine reads, with settings of the
 * types it reads them as.
 */
export function validateTrigger(trigger: unknown, lane: WorkflowLane): TriggerProblem[] {
  if (trigger === undefined || trigger === null) return [{ reason: 'trigger_missing', severity: 'error', message: 'the workflow has no trigger' }]
  const type = isRecord(trigger) ? trigger.type : undefined
  if (isPlannedType(type)) {
    return [{ reason: 'trigger_type_not_built', severity: 'error', message: `a ${type} trigger is planned but not built: nothing would start this workflow` }]
  }
  const problems: TriggerProblem[] = []
  let known: TriggerType
  if (isTriggerType(type)) known = type
  else if (typeof type === 'string' && Object.hasOwn(LEGACY_TRIGGER_SPELLINGS, type)) {
    known = LEGACY_TRIGGER_SPELLINGS[type as keyof typeof LEGACY_TRIGGER_SPELLINGS]
    problems.push({ reason: 'trigger_legacy_spelling', severity: 'warning', message: `the trigger type ${type} is the old spelling of ${known}` })
  } else {
    return [{ reason: 'trigger_type_unknown', severity: 'error', message: `the trigger type ${String(type)} is not one this build knows` }]
  }
  if (!TRIGGER_LANES[known].includes(lane)) {
    problems.push({ reason: 'trigger_not_on_lane', severity: 'error', message: `a ${known} trigger does not run on the ${lane} lane: nothing there would start this workflow` })
  }
  problems.push(...configProblems({ ...trigger, type: known } as TriggerConfig))
  return problems
}
