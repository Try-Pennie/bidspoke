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
import { RETENTION_DAYS } from '../archive/candidate-days'
import { archiveConfig, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from './archive-snowflake'
import { recordArchiveReadOutcome } from './archive-read-health'
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
  /** Injected so a test can see the outcome without KV or Slack (#1272). */
  recordOutcome?: typeof recordArchiveReadOutcome
}

/**
 * One archive query's result, said in a shape the caller cannot ignore.
 *
 * A discriminated value rather than a thrown error, so a caller's `catch` keeps
 * covering only what it was written for: on the read path a decode failure and
 * an unreachable warehouse are different conditions with different answers, and
 * folding them into one try would report a corrupt row as an outage.
 */
type ArchiveQueryResult =
  | { ok: true; response: SnowflakeStatementResponse }
  | { ok: false; detail: string }

/**
 * THE ONE PLACE AN ARCHIVE QUERY IS MADE, and therefore the one place that
 * knows whether the archive answered (#1272).
 *
 * Every read used to build its own deadline race, its own catch and its own
 * `unavailable`, three times over. Counting the failures would then have been a
 * rule each call site had to remember, which is not a rule at all (L621), and
 * the fourth read function written next year would have been exempt from it
 * while looking perfectly correct.
 *
 * Recording is best effort on purpose: this sits between a person and thirteen
 * months of history, so a KV or Slack problem must never turn a read that
 * worked into one that did not.
 */
async function runArchiveQuery(
  env: Env,
  supabase: SupabaseClient,
  statement: string,
  bindings: unknown[],
  deadlineMs: number,
  deps: ArchiveReadDeps,
): Promise<ArchiveQueryResult> {
  const execute = deps.execute ?? executeStatement
  const sleep = deps.sleep ?? defaultSleep
  const record = deps.recordOutcome ?? recordArchiveReadOutcome
  const kv = (env as unknown as { IDEMPOTENCY?: KVNamespace }).IDEMPOTENCY

  const report = async (outcome: Parameters<typeof recordArchiveReadOutcome>[2]) => {
    try {
      await record(supabase, kv, outcome)
    } catch (err) {
      console.error('[archive-read] could not record the read outcome:', formatErr(err))
    }
  }

  let result: ArchiveQueryResult
  try {
    const raced = await Promise.race([
      execute(archiveConfig(env, 'reader'), statement, bindings).then(
        (r) => ({ timedOut: false as const, response: r }),
      ),
      sleep(deadlineMs).then(() => ({ timedOut: true as const })),
    ])
    result = raced.timedOut
      ? {
          ok: false,
          // Seconds, not milliseconds: this sentence is rendered to an operator
          // on the execution page, not to a log reader.
          detail: `the archive did not answer within ${Math.round(deadlineMs / 1000)} seconds`,
        }
      : { ok: true, response: raced.response }
  } catch (err) {
    result = { ok: false, detail: formatErr(err) }
  }

  await report(result.ok ? { kind: 'ok' } : { kind: 'unavailable', detail: result.detail })
  return result
}

/** The answer every read gives when the archive could not be reached. */
function unavailable(detail: string) {
  return { kind: 'unavailable' as const, waitingFor: ARCHIVE_READ_WAITING_FOR, detail }
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
 * One text cell, or null.
 *
 * Deliberately NOT `String(cell)`: the SQL API is typed `unknown[][]`, and
 * String() on an object yields the literal "[object Object]", which then
 * renders on the page as though it were the value. A cell that is not already
 * text is not a value this can report, so it reports nothing.
 */
function textCell(cell: unknown): string | null {
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number' || typeof cell === 'bigint') return String(cell)
  return null
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

  const queried = await runArchiveQuery(env, supabase, statement, bindings, deadlineMs, deps)
  if (!queried.ok) return unavailable(queried.detail)

  const row = queried.response.data?.[0]
  if (!row) return { kind: 'not-found' }

  const [organizationId, archiveDay, incomplete, wire] = row

  // The same "not found" the live path returns, so a foreign execution and a
  // missing one are indistinguishable from outside and no shape is leaked.
  if (String(organizationId) !== opts.orgId) return { kind: 'not-found' }

  if (typeof wire !== 'string' || wire.length === 0) {
    return unavailable('the archived row carried no bundle')
  }

  let bundle
  try {
    bundle = await decodeBundle(wire)
  } catch (err) {
    // A row that is present but cannot be decoded is not an execution that
    // never ran, so it must not answer as one.
    return unavailable(`the archived bundle could not be read: ${formatErr(err)}`)
  }

  const day_ = String(archiveDay)
  // AUDIT IS BEST EFFORT, AND THAT IS A DECISION, not an oversight.
  //
  // Dan, 2026-09-10, asked directly: the read still succeeds when its access
  // record cannot be written. The alternative considered and rejected was
  // refusing the read, on the reasoning that no record means no access. It was
  // rejected because an audit outage would then make thirteen months of history
  // unreachable at exactly the moment somebody is investigating a dispute, and
  // because every other audited action in Bidspoke already behaves this way.
  //
  // So do NOT "harden" this into a fail closed check without asking again.
  // `writeAuditLog` spends its own retry ladder and logs once after it, and
  // making the gap visible rather than merely logged is #1272's neighbour, not
  // a reason to block the read.
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

/**
 * Child runs (a replay or a resume) whose parent is this execution (#874).
 *
 * WHY THIS IS BOUNDED THE WAY IT IS. A child can be created at any time while
 * the parent is still readable, so it can land on a later day than the parent
 * and is not found by the parent's own three day window. The bound runs from
 * the parent's day to that day plus the retention window plus one, because a
 * child cannot be created from a parent Postgres no longer holds. RETENTION_DAYS
 * is the shared constant the purge itself uses rather than a literal, so
 * changing retention moves this with it.
 */
export async function readArchivedChildren(
  env: Env,
  // Takes the client only so its read reaches the same outcome signal every
  // other read does (#1272). Nothing here queries Postgres.
  supabase: SupabaseClient,
  opts: { parentExecutionId: string; parentDay: string; orgId: string; deadlineMs?: number },
  deps: ArchiveReadDeps = {},
): Promise<
  | { kind: 'ok'; children: Array<Record<string, unknown>> }
  | { kind: 'unavailable'; waitingFor: string; detail: string }
> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_ARCHIVE_READ_DEADLINE_MS

  const at = Date.parse(`${opts.parentDay}T00:00:00.000Z`)
  const lastDay = new Date(at + (RETENTION_DAYS + 1) * 86_400_000).toISOString().slice(0, 10)

  const statement =
    `SELECT execution_id, started_at_utc, status, outcome, source ` +
    `FROM ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE} ` +
    `WHERE parent_execution_id = ? AND archive_day BETWEEN ?::DATE AND ?::DATE ` +
    `AND organization_id = ? ORDER BY started_at_utc ASC`

  const queried = await runArchiveQuery(
    env,
    supabase,
    statement,
    [opts.parentExecutionId, opts.parentDay, lastDay, opts.orgId],
    deadlineMs,
    deps,
  )
  if (!queried.ok) return unavailable(queried.detail)

  const children = (queried.response.data ?? []).map((row) => ({
    id: textCell(row[0]) ?? '',
    started_at: textCell(row[1]),
    status: textCell(row[2]),
    outcome: textCell(row[3]),
    source: textCell(row[4]),
  }))
  return { kind: 'ok', children }
}

/**
 * The completed steps a resumed execution inherits from an ARCHIVED parent.
 *
 * Without this a live child whose parent has aged into the archive renders with
 * its upstream steps missing, which reads as "those steps never ran" rather
 * than "those steps ran, on the run this one resumed from". That is a wrong
 * statement about what happened, not a gap.
 *
 * Returns the parent's completed steps, or `unavailable` so the caller can say
 * the parent could not be reached rather than silently showing fewer steps.
 */
export async function readArchivedParentSteps(
  env: Env,
  supabase: SupabaseClient,
  opts: { parentExecutionId: string; orgId: string; readBy: string; deadlineMs?: number },
  deps: ArchiveReadDeps = {},
): Promise<
  | { kind: 'ok'; steps: Array<Record<string, unknown>> }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; waitingFor: string; detail: string }
> {
  const parent = await readArchivedExecution(
    env,
    supabase,
    {
      executionId: opts.parentExecutionId,
      orgId: opts.orgId,
      readBy: opts.readBy,
      deadlineMs: opts.deadlineMs,
    },
    deps,
  )
  if (parent.kind !== 'found') return parent

  const steps = parent.steps
    .filter((s) => (s as { status?: unknown }).status === 'completed')
    .map((s) => ({
      ...(s as Record<string, unknown>),
      inherited_from_execution_id: opts.parentExecutionId,
    }))
  return { kind: 'ok', steps }
}

/**
 * One step, from an archived execution's bundle or from its parent's (#874).
 *
 * TWO BUNDLES, IN ORDER, and the order is the whole point. The lazy step route
 * looks a step up by its own id and ignores the execution in the path,
 * precisely so a resumed run can load a step whose row lives on the run it
 * resumed from. So this cannot read one bundle: it resolves the named
 * execution's, and when the step is not in it and that execution resumed from
 * another, follows resumed_from_execution_id to the parent's.
 *
 * The three outcomes stay distinct. A step that is genuinely nowhere is
 * `not-found`. A step that may sit on a parent nobody could reach is
 * `unavailable`, because answering "no such step" there would be a claim this
 * read never established, on a page that has already drawn the step as
 * completed.
 */
export async function findArchivedStep(
  env: Env,
  supabase: SupabaseClient,
  opts: { executionId: string; stepId: string; orgId: string; readBy: string; deadlineMs?: number },
  deps: ArchiveReadDeps = {},
): Promise<
  | { kind: 'found'; step: Record<string, unknown> }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; waitingFor: string; detail: string }
> {
  const own = await readArchivedExecution(
    env,
    supabase,
    { executionId: opts.executionId, orgId: opts.orgId, readBy: opts.readBy, deadlineMs: opts.deadlineMs },
    deps,
  )
  if (own.kind === 'unavailable') return own
  if (own.kind === 'not-found') return { kind: 'not-found' }

  const mine = stepById(own.steps, opts.stepId)
  if (mine) return { kind: 'found', step: mine }

  const resumedFrom = own.execution.resumed_from_execution_id
  if (typeof resumedFrom !== 'string' || resumedFrom.length === 0) return { kind: 'not-found' }

  const parent = await readArchivedExecution(
    env,
    supabase,
    { executionId: resumedFrom, orgId: opts.orgId, readBy: opts.readBy, deadlineMs: opts.deadlineMs },
    deps,
  )
  if (parent.kind === 'unavailable') return parent
  if (parent.kind === 'not-found') return { kind: 'not-found' }

  const inherited = stepById(parent.steps, opts.stepId)
  if (!inherited) return { kind: 'not-found' }
  return {
    kind: 'found',
    step: { ...inherited, inherited_from_execution_id: resumedFrom },
  }
}

/** The step with this id, without the execution_id the route does not return. */
function stepById(steps: unknown[], stepId: string): Record<string, unknown> | null {
  for (const candidate of steps) {
    const step = candidate as Record<string, unknown>
    if (step.id !== stepId) continue
    const { execution_id: _omit, ...rest } = step
    return rest
  }
  return null
}

/**
 * Finding an archived run when nobody has the link (#874).
 *
 * `GET /api/executions` is Postgres only and has no identity filter, so past
 * the retention window somebody holding a lead and no URL has no starting
 * point at all. Two ways in:
 *
 *  - a trace id, matched against the archive directly, which every archived
 *    run carries, so its coverage is complete;
 *  - an SSN, resolved through LEAD_SIGHTINGS, which already holds both the ssn
 *    and the execution_id.
 *
 * THE COVERAGE IS PART OF THE ANSWER. Until 2026-08-19 a workflow could opt
 * out of recording sightings, and Main Flow, the flow carrying the Equifax
 * credit report, was opted out. #882 removed the switch so every workflow
 * always records, but the archive holds thirteen months, so a large part of it
 * predates that and an SSN cannot reach those runs at all.
 *
 * An SSN search answering "nothing" for one of them is saying something false,
 * and it is loudest in the EMPTY case, which is exactly where somebody
 * concludes the product never handled the person (L92, L98). So every SSN
 * response carries the date its coverage begins, the empty ones included.
 *
 * The caveat is stated as a DATE rather than a list of workflows deliberately.
 * The per-workflow flag still exists as an inert column with stale values in
 * it, and reading it would resurrect a retired opt-out and name workflows that
 * do record sightings today.
 */
export type ArchiveSearchResult =
  | {
      kind: 'ok'
      results: Array<Record<string, unknown>>
      coverage: { complete: boolean; completeFrom: string | null; note: string | null }
    }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable'; waitingFor: string; detail: string }

const SEARCH_COLUMNS =
  'execution_id, workflow_id, archive_day, started_at_utc, status, outcome, source'

/**
 * The first UTC day on which every workflow recorded a lead sighting.
 *
 * #882 removed the per-workflow opt-out on 2026-08-19, so runs from the next
 * day forward are all reachable by SSN. Before it, a workflow could record
 * none, and Main Flow did. Archived runs older than this cannot be found by
 * SSN however complete the archive itself is.
 */
export const SIGHTINGS_COMPLETE_FROM = '2026-08-20'

/** How many runs one search may return, so a common trace id cannot pull the world. */
export const ARCHIVE_SEARCH_LIMIT = 200

export async function searchArchive(
  env: Env,
  supabase: SupabaseClient,
  opts: { traceId?: string; ssn?: string; orgId: string; readBy: string; deadlineMs?: number },
  deps: ArchiveReadDeps = {},
): Promise<ArchiveSearchResult> {
  const writeAudit = deps.writeAudit ?? writeAuditLog
  const deadlineMs = opts.deadlineMs ?? DEFAULT_ARCHIVE_READ_DEADLINE_MS

  const traceId = opts.traceId?.trim()
  const ssn = opts.ssn?.trim()
  if (!traceId && !ssn) {
    // Refused, never "everything". A search tool handed no term must not
    // quietly become an export of the archive (L320).
    return { kind: 'refused', reason: 'a trace id or an SSN is required' }
  }
  if (traceId && ssn) {
    return { kind: 'refused', reason: 'search by a trace id or an SSN, not both' }
  }

  // Throws so the two statements below read as a sequence rather than a ladder
  // of checks, and the one outer catch turns it back into the caller's answer.
  const run = async (statement: string, bindings: unknown[]) => {
    const queried = await runArchiveQuery(env, supabase, statement, bindings, deadlineMs, deps)
    if (!queried.ok) throw new Error(queried.detail)
    return queried.response
  }

  try {
    let rows: unknown[][]

    if (traceId) {
      const response = await run(
        `SELECT ${SEARCH_COLUMNS} FROM ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE} ` +
          `WHERE trace_id = ? AND organization_id = ? ` +
          `ORDER BY started_at_utc DESC LIMIT ${ARCHIVE_SEARCH_LIMIT}`,
        [traceId, opts.orgId],
      )
      rows = response.data ?? []
    } else {
      // Two statements rather than a join, because the sightings table lives in
      // a different schema with its own grants, and a failure in either half
      // should be reportable on its own.
      const resolved = await run(
        `SELECT DISTINCT execution_id FROM ${ARCHIVE_DATABASE}.PUBLIC.LEAD_SIGHTINGS ` +
          `WHERE ssn = ? LIMIT ${ARCHIVE_SEARCH_LIMIT}`,
        [ssn as string],
      )
      const ids = (resolved.data ?? [])
        .map((row) => textCell(row[0]))
        .filter((id): id is string => id !== null && id.length > 0)

      if (ids.length === 0) {
        rows = []
      } else {
        const placeholders = ids.map(() => '?').join(', ')
        const response = await run(
          `SELECT ${SEARCH_COLUMNS} FROM ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE} ` +
            `WHERE execution_id IN (${placeholders}) AND organization_id = ? ` +
            `ORDER BY started_at_utc DESC LIMIT ${ARCHIVE_SEARCH_LIMIT}`,
          [...ids, opts.orgId],
        )
        rows = response.data ?? []
      }
    }

    const results = rows.map((row) => ({
      execution_id: textCell(row[0]) ?? '',
      workflow_id: textCell(row[1]),
      archive_day: textCell(row[2]),
      started_at: textCell(row[3]),
      status: textCell(row[4]),
      outcome: textCell(row[5]),
      source: textCell(row[6]),
    }))

    // The audit row records that a search HAPPENED and by which kind of term.
    // The term itself is deliberately absent: writing an SSN here would copy
    // the identity into a second store with its own, longer, retention.
    await writeAudit(
      supabase,
      opts.orgId,
      'execution_archive',
      opts.orgId,
      'archive_searched',
      opts.readBy,
      { by: ssn ? 'ssn' : 'trace_id', matched: results.length },
    )

    // A trace id is on every archived row, so that search has no blind spot at
    // all and says nothing. An SSN goes through the sightings, which not every
    // run has, so it always states where its coverage starts.
    return {
      kind: 'ok',
      results,
      coverage: ssn
        ? {
            complete: false,
            completeFrom: SIGHTINGS_COMPLETE_FROM,
            note:
              `This finds a person through their recorded lead sightings. Every workflow has recorded ` +
              `them since ${SIGHTINGS_COMPLETE_FROM}, but some did not before that, so runs older than ` +
              `that date may be missing here whether or not anything is listed above. Search by trace id ` +
              `to reach them.`,
          }
        : { complete: true, completeFrom: null, note: null },
    }
  } catch (err) {
    return unavailable(formatErr(err))
  }
}
