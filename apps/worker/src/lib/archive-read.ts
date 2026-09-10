/**
 * Reading one archived execution back out of Snowflake (#874, Phase A6).
 *
 * The write half of the execution archive has been correct for weeks: every
 * retained day's Postgres and Snowflake counts match exactly. Nothing read it
 * back, so an execution older than the seven day retention answered
 * "Execution not found" while a verified copy of it sat in the archive. This is
 * the read.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not cache. A cache would be a second place full fidelity personal
 * data lives, which is the thing constraint 6 of the plan exists to prevent, so
 * every read is a point lookup and is slower than the live page by design.
 *
 * It does not read as the writer. `archiveConfig(env, 'reader')` is a role
 * holding no DELETE and no INSERT, verified daily by the identity check, so a
 * defect on this path cannot damage the archive it is reading.
 *
 * THREE OUTCOMES, NEVER TWO. A read that could not reach the archive is not a
 * read that found nothing. Collapsing them tells an operator a lead never ran
 * when it did, so `unavailable` is its own outcome and it names what the read
 * was waiting for (L11, L98).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { utcDayFromUuidV7 } from '@bidspoke/uuidv7'
import { archiveConfig, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from './archive-snowflake'
import { executeStatement, type SnowflakeStatementResponse, type SnowflakeConfig } from './snowflake'
import { decodeBundle } from '../archive/bundle'
import { writeAuditLog } from './audit'
import { formatErr } from './format-error'
import type { Env } from '../index'

/**
 * What a timed out read was waiting for, in the operator's terms rather than
 * the implementation's. It reaches a person on the page, so it says the archive
 * rather than naming a warehouse they have no access to.
 */
export const ARCHIVE_READ_WAITING_FOR = 'the execution archive'

/**
 * How long one archived read may take before it is reported as unavailable.
 *
 * A cold warehouse has to resume before it can answer, which is the slow case
 * this has to survive; a wait with no deadline cannot fail, only hang, and a
 * hang is indistinguishable from slowness to whoever is looking at the page
 * (L110).
 */
export const DEFAULT_ARCHIVE_READ_DEADLINE_MS = 20_000

export type ArchivedExecutionRead =
  | {
      kind: 'found'
      execution: Record<string, unknown>
      steps: unknown[]
      archiveDay: string
      archivedIncomplete: boolean
    }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; waitingFor: string; detail: string }

export interface ArchiveReadDeps {
  execute?: (
    config: SnowflakeConfig,
    statement: string,
    bindings?: unknown[],
  ) => Promise<SnowflakeStatementResponse>
  /** Injected so the deadline case is instant rather than a real wait (L524). */
  sleep?: (ms: number) => Promise<void>
  writeAudit?: typeof writeAuditLog
}

/** The columns this read selects, in the order the row returns them. */
const COLUMNS = ['organization_id', 'archive_day', 'archived_incomplete', 'bundle_gz_b64'] as const

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The day before and the day after, so an execution born near midnight is still found. */
function neighbouringDays(day: string): [string, string, string] {
  const at = Date.parse(`${day}T00:00:00.000Z`)
  const asDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return [asDay(at - 86_400_000), day, asDay(at + 86_400_000)]
}

/**
 * The SQL API answers every cell as a string, so a boolean arrives as "true".
 * Accepting the JS boolean too keeps this honest if that ever changes rather
 * than reading one shape and silently answering false for the other.
 */
function asBoolean(cell: unknown): boolean {
  if (typeof cell === 'boolean') return cell
  return typeof cell === 'string' && cell.toLowerCase() === 'true'
}

/**
 * Finds one archived execution.
 *
 * A v7 id carries the instant it was minted, so the day it belongs to is
 * derived from the id itself and the query is pruned to three days rather than
 * scanning thirteen months. An id that is not v7 (an execution minted before
 * the cutover) carries no instant, so it takes an unpruned lookup: slower,
 * correct, and rare.
 *
 * ORDER BY archived_at_utc DESC LIMIT 1 because the archive INSERTs and never
 * MERGEs, so a re-archived day can leave more than one row for one execution.
 * The most recently written one is the one to serve. What should happen to the
 * duplicates themselves is #1023 and is not decided here.
 */
export async function readArchivedExecution(
  env: Env,
  supabase: SupabaseClient,
  opts: { executionId: string; orgId: string; readBy: string; deadlineMs?: number },
  deps: ArchiveReadDeps = {},
): Promise<ArchivedExecutionRead> {
  const execute = deps.execute ?? executeStatement
  const sleep = deps.sleep ?? defaultSleep
  const writeAudit = deps.writeAudit ?? writeAuditLog
  const deadlineMs = opts.deadlineMs ?? DEFAULT_ARCHIVE_READ_DEADLINE_MS

  const day = utcDayFromUuidV7(opts.executionId)
  const select = `SELECT ${COLUMNS.join(', ')} FROM ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`
  const tail = 'ORDER BY archived_at_utc DESC LIMIT 1'

  // Bound, never interpolated. The id reaches here from a URL, and binding is
  // the contract this path starts with rather than one retro-fitted (#1006).
  const { statement, bindings } = day
    ? {
        statement: `${select} WHERE archive_day IN (?::DATE, ?::DATE, ?::DATE) AND execution_id = ? ${tail}`,
        bindings: [...neighbouringDays(day), opts.executionId],
      }
    : {
        statement: `${select} WHERE execution_id = ? ${tail}`,
        bindings: [opts.executionId],
      }

  let response: SnowflakeStatementResponse
  try {
    const raced = await Promise.race([
      execute(archiveConfig(env, 'reader'), statement, bindings).then(
        (r) => ({ timedOut: false as const, response: r }),
      ),
      sleep(deadlineMs).then(() => ({ timedOut: true as const })),
    ])
    if (raced.timedOut) {
      return {
        kind: 'unavailable',
        waitingFor: ARCHIVE_READ_WAITING_FOR,
        // Seconds, not milliseconds: this sentence is rendered to an operator
        // on the execution page, not to a log reader.
        detail: `the archive did not answer within ${Math.round(deadlineMs / 1000)} seconds`,
      }
    }
    response = raced.response
  } catch (err) {
    return {
      kind: 'unavailable',
      waitingFor: ARCHIVE_READ_WAITING_FOR,
      detail: formatErr(err),
    }
  }

  const row = response.data?.[0]
  if (!row) return { kind: 'not-found' }

  const [organizationId, archiveDay, incomplete, wire] = row

  // The same "not found" the live path returns, so a foreign execution and a
  // missing one are indistinguishable from outside and no shape is leaked.
  if (String(organizationId) !== opts.orgId) return { kind: 'not-found' }

  if (typeof wire !== 'string' || wire.length === 0) {
    return {
      kind: 'unavailable',
      waitingFor: ARCHIVE_READ_WAITING_FOR,
      detail: 'the archived row carried no bundle',
    }
  }

  let bundle
  try {
    bundle = await decodeBundle(wire)
  } catch (err) {
    // A row that is present but cannot be decoded is not an execution that
    // never ran, so it must not answer as one.
    return {
      kind: 'unavailable',
      waitingFor: ARCHIVE_READ_WAITING_FOR,
      detail: `the archived bundle could not be read: ${formatErr(err)}`,
    }
  }

  const day_ = String(archiveDay)
  await writeAudit(
    supabase,
    opts.orgId,
    'execution_archive',
    opts.executionId,
    'archived_execution_read',
    opts.readBy,
    { archive_day: day_ },
  )

  return {
    kind: 'found',
    execution: (bundle.execution ?? {}) as Record<string, unknown>,
    steps: bundle.steps ?? [],
    archiveDay: day_,
    archivedIncomplete: asBoolean(incomplete),
  }
}
