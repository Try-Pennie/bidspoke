/**
 * The typed columns copied out of an execution row alongside its bundle (#871).
 *
 * The bundle is the record of what happened; these are the handful of fields
 * the later phases read WITHOUT decompressing 105,000 bundles: the deletion
 * gate's status and cost, the report view's trace id and source, the day and
 * organization every erasure and expiry delete is scoped by.
 *
 * Three of them (organization, workflow, start) are NOT NULL in the archive
 * table, so a row missing any of them cannot be written at all. That is checked
 * HERE, per execution, so the answer is a refusal by id that the run loop
 * already knows how to record. Discovering it at the send instead would fail a
 * whole batch, and the watermark would stall on an hour that can never pass.
 */

export interface ArchiveScalars {
  organizationId: string
  workflowId: string
  workflowVersionId: string | null
  parentExecutionId: string | null
  resumedFromExecutionId: string | null
  traceId: string | null
  source: string | null
  status: string | null
  outcome: string | null
  isTest: boolean | null
  /** TIMESTAMP_NTZ in UTC: no zone suffix, because the column carries none. */
  startedAtUtc: string
  completedAtUtc: string | null
  durationMs: number | null
  costUsd: number | null
}

export type ScalarsResult = { ok: true; scalars: ArchiveScalars } | { ok: false; reason: string }

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // Postgres NUMERIC arrives as a string through PostgREST, so cost_usd is a
  // string in production and a number in every hand-written fixture. Reading
  // only the number form would write NULL for every real row while every test
  // passed (L50).
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * A timestamp as Snowflake's TIMESTAMP_NTZ wants it: UTC, with the zone marker
 * removed. Parsing and re-rendering rather than trimming the string, because
 * Postgres returns an offset ('+00:00') that a trim would leave in place and
 * Snowflake would then read as part of the seconds field.
 */
export function toNtz(value: unknown): string | null {
  const raw = str(value)
  if (raw === null) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().replace('Z', '')
}

export function scalarsFor(execution: Record<string, unknown>, organizationId: string | undefined): ScalarsResult {
  const id = str(execution.id) ?? '(no id)'

  if (organizationId === undefined || organizationId === '') {
    return { ok: false, reason: `execution ${id} has no organization id, which the archive table requires` }
  }
  const workflowId = str(execution.workflow_id)
  if (workflowId === null) {
    return { ok: false, reason: `execution ${id} has no workflow id, which the archive table requires` }
  }
  const startedAtUtc = toNtz(execution.started_at)
  if (startedAtUtc === null) {
    return { ok: false, reason: `execution ${id} has no readable started_at, which the archive table requires` }
  }

  return {
    ok: true,
    scalars: {
      organizationId,
      workflowId,
      workflowVersionId: str(execution.workflow_version_id),
      parentExecutionId: str(execution.parent_execution_id),
      resumedFromExecutionId: str(execution.resumed_from_execution_id),
      traceId: str(execution.trace_id),
      source: str(execution.source),
      status: str(execution.status),
      outcome: str(execution.outcome),
      isTest: bool(execution.is_test),
      startedAtUtc,
      completedAtUtc: toNtz(execution.completed_at),
      durationMs: num(execution.duration_ms),
      costUsd: num(execution.cost_usd),
    },
  }
}
