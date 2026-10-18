/**
 * What crosses the service binding between the two Workers for the ops minute
 * cron (#1949), in one place both sides import: the bidding Worker's OpsGateway
 * entrypoint (lib/ops-gateway-entrypoint.ts) and the ops tick (ops/tick.ts).
 *
 * Two things cross it:
 *  - the ops workflows' state, served by the bidding Worker (Dan's decision 4,
 *    2026-10-16, on #1949: the bidding Worker serves definitions to the ops
 *    Worker over the service binding, and the ops Worker keeps the last good
 *    copy). Only what a tick needs: each ops workflow's on or off state, its
 *    soft delete, its updated_at (the order key), its latest version and its
 *    trigger. A run's full definition at its version is #1950's to fetch;
 *  - the tick's report, which the bidding Worker stamps as the heartbeat and
 *    judges every minute, so the watchdog never depends on the Worker it
 *    watches (L71).
 *
 * Each side parses what it receives (L50): an RPC argument or answer is
 * whatever the other Worker's code put there, possibly an older release's.
 */

/** One ops workflow's state, as the bidding database holds it. */
export interface ServedOpsWorkflow {
  id: string
  organization_id: string
  is_active: boolean
  deleted_at: string | null
  /** workflows.updated_at: a trigger moves it on every update, so it orders copies. */
  updated_at: string
  /** The latest workflow_versions.version_number, or null for a workflow with none. */
  version_number: number | null
  /** definition.trigger, unvalidated. */
  trigger: unknown
}

export interface ServedOpsWorkflows {
  /** The bidding Worker's clock when it read the list. */
  served_at: string
  /** The list names every ops workflow, so one it omits is no longer an ops workflow. */
  complete: boolean
  workflows: ServedOpsWorkflow[]
}

/** The ops Worker's binding to the bidding Worker's OpsGateway entrypoint. */
export interface OpsGatewayBinding {
  opsWorkflows(): Promise<unknown>
  opsTickStarted(): Promise<unknown>
  opsTickCompleted(report: unknown): Promise<unknown>
}

/** The tick's own mode. Observe only (#1949): live claiming and dispatch come with run invocation (#1950). */
export const OPS_TICK_MODES = ['observe'] as const
export type OpsTickMode = (typeof OPS_TICK_MODES)[number]

export const OPS_TICK_OUTCOMES = ['ok', 'problems', 'not_configured'] as const
export type OpsTickOutcome = (typeof OPS_TICK_OUTCOMES)[number]

/** A secret's name, as Cloudflare and secret-lists.ts write it. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_NOT_CONFIGURED_SECRETS = 10

/** A report carries at most this many problems, each at most this long, so one bad tick cannot fill KV or a Slack post. */
export const MAX_REPORT_PROBLEMS = 20
export const MAX_PROBLEM_LENGTH = 400

export interface OpsTickReport {
  tick_id: string
  mode: OpsTickMode
  /** The cron's scheduledTime, which lands at :48 within a minute, never aligned (spike, #1946). */
  scheduled_time: string | null
  started_at: string
  finished_at: string
  /** The database clock the tick planned against, or null when it could not read it. */
  db_now: string | null
  outcome: OpsTickOutcome
  /** Each a sentence a person can act on. Empty when the outcome is ok. */
  problems: string[]
  /** What the tick did, as counts, for the logs. */
  counts: Record<string, number>
  /**
   * The secrets a not_configured tick found unset or unusable, by name (#2333),
   * so the page names each one's remedy. Empty on any other outcome. Null on a
   * report from an ops release before #2333, which named none: the only cause
   * such a release could report was the ops database.
   */
  not_configured_secrets: string[] | null
}

export class OpsGatewayContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsGatewayContractError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Caps a problem list, saying how many were left out rather than dropping them silently. */
export function capProblems(problems: readonly string[]): string[] {
  const clipped = problems.map((p) => (p.length > MAX_PROBLEM_LENGTH ? `${p.slice(0, MAX_PROBLEM_LENGTH - 3)}...` : p))
  if (clipped.length <= MAX_REPORT_PROBLEMS) return clipped
  const shown = clipped.slice(0, MAX_REPORT_PROBLEMS - 1)
  return [...shown, `${clipped.length - shown.length} more problems were left out of this report; the ops Worker's logs have every one.`]
}

/**
 * The served list, with each row that is not a well formed ops workflow refused
 * by name rather than saved. Throws when the list itself is malformed.
 */
export function parseServedOpsWorkflows(raw: unknown): { list: ServedOpsWorkflows; refused: string[] } {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the workflow list with something other than an object')
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s workflow list has no served_at time')
  if (typeof raw.complete !== 'boolean') throw new OpsGatewayContractError('the bidding Worker\'s workflow list does not say whether it is complete')
  if (!Array.isArray(raw.workflows)) throw new OpsGatewayContractError('the bidding Worker\'s workflow list has no workflows array')
  const workflows: ServedOpsWorkflow[] = []
  const refused: string[] = []
  raw.workflows.forEach((row: unknown, i: number) => {
    const id = isRecord(row) && typeof row.id === 'string' ? row.id : `row ${i}`
    if (
      !isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.organization_id !== 'string' || !UUID.test(row.organization_id) ||
      typeof row.is_active !== 'boolean' ||
      !(row.deleted_at === null || isTime(row.deleted_at)) ||
      !isTime(row.updated_at) ||
      !(row.version_number === null || (typeof row.version_number === 'number' && Number.isInteger(row.version_number) && row.version_number >= 1))
    ) {
      refused.push(`The bidding Worker served workflow ${id} in a shape the ops Worker does not read, so it was not saved.`)
      return
    }
    workflows.push({
      id: row.id,
      organization_id: row.organization_id,
      is_active: row.is_active,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
      version_number: row.version_number,
      trigger: row.trigger ?? null,
    })
  })
  // A list with refused rows does not name every ops workflow it could read, so
  // it must not withdraw the ones it failed to describe.
  return { list: { served_at: raw.served_at, complete: raw.complete && refused.length === 0, workflows }, refused }
}

/** The tick's report as the bidding Worker received it. Throws on one it cannot read. */
export function parseOpsTickReport(raw: unknown): OpsTickReport {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the ops tick sent a report that is not an object')
  const { tick_id, mode, scheduled_time, started_at, finished_at, db_now, outcome, problems, counts, not_configured_secrets } = raw
  if (typeof tick_id !== 'string' || tick_id === '' || tick_id.length > 200) throw new OpsGatewayContractError('the ops tick report has no tick id')
  if (!(OPS_TICK_MODES as readonly unknown[]).includes(mode)) throw new OpsGatewayContractError(`the ops tick report names a mode this Worker does not know: ${String(mode)}`)
  if (!(scheduled_time === null || isTime(scheduled_time))) throw new OpsGatewayContractError('the ops tick report has an unreadable scheduled time')
  if (!isTime(started_at) || !isTime(finished_at)) throw new OpsGatewayContractError('the ops tick report has an unreadable start or finish')
  if (!(db_now === null || isTime(db_now))) throw new OpsGatewayContractError('the ops tick report has an unreadable database clock')
  if (!(OPS_TICK_OUTCOMES as readonly unknown[]).includes(outcome)) throw new OpsGatewayContractError(`the ops tick report names an outcome this Worker does not know: ${String(outcome)}`)
  if (!Array.isArray(problems) || problems.some((p) => typeof p !== 'string')) throw new OpsGatewayContractError('the ops tick report\'s problems are not a list of sentences')
  if (outcome === 'ok' ? problems.length > 0 : problems.length === 0) throw new OpsGatewayContractError(`the ops tick report says ${String(outcome)} with ${problems.length} problems`)
  if (!isRecord(counts) || Object.values(counts).some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new OpsGatewayContractError('the ops tick report\'s counts are not numbers')
  let secrets: string[] | null = null
  if (not_configured_secrets !== undefined) {
    if (
      !Array.isArray(not_configured_secrets) || not_configured_secrets.length > MAX_NOT_CONFIGURED_SECRETS ||
      not_configured_secrets.some((n) => typeof n !== 'string' || !SECRET_NAME.test(n))
    ) throw new OpsGatewayContractError('the ops tick report\'s not configured secrets are not a list of secret names')
    // The names pick the page's remedy, so they must agree with the outcome.
    if (outcome === 'not_configured' ? not_configured_secrets.length === 0 : not_configured_secrets.length > 0) {
      throw new OpsGatewayContractError(`the ops tick report says ${String(outcome)} naming ${not_configured_secrets.length} unconfigured secrets`)
    }
    secrets = [...(not_configured_secrets as string[])]
  }
  return {
    tick_id,
    mode: mode as OpsTickMode,
    scheduled_time: scheduled_time,
    started_at,
    finished_at,
    db_now: db_now,
    outcome: outcome as OpsTickOutcome,
    problems: capProblems(problems as string[]),
    counts: counts as Record<string, number>,
    not_configured_secrets: secrets,
  }
}
