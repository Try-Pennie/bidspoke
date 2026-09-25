/**
 * Does each Snowflake table still accept what its export sends (#428)?
 *
 * The export column lists and the Snowflake DDL are maintained by hand, in
 * different places, and nothing compared them. On 2026-06-27 the sightings
 * table marked EXECUTION_FINISHED_AT_ET NOT NULL while the Supabase column it
 * is filled from is nullable, and the only detector was the export itself
 * failing. This reads the tables back once a day and compares, column by
 * column, against the ColSpec lists the exports actually write from, so the
 * disagreement is reported before a night's export depends on it.
 *
 * What counts as drift, each one a way the next MERGE fails or changes meaning:
 *   - a column the export sends that the table does not have (skipped for an
 *     export that adds missing columns itself before writing, see
 *     `reconcileColumns`);
 *   - a column Snowflake declares NOT NULL that the export can send null for;
 *   - a column stored as a different type than the export sends it as;
 *   - a column only Snowflake has that is NOT NULL with no default, which every
 *     new row the export inserts leaves empty.
 *
 * VARCHAR length limits are NOT compared: whether a value fits is a property of
 * the data, not of the two schemas.
 *
 * WHAT THE EXPORT CAN SEND AS NULL. `formatValue` writes NULL for a null, an
 * absent value and an empty string, so any column the Supabase source allows to
 * be null can arrive empty. `neverNull` is therefore the exported columns
 * Supabase declares NOT NULL, and a test derives it from the generated
 * `database.ts`, which the DB Types Drift workflow keeps equal to production.
 * It is listed here rather than read at run time because the Worker cannot read
 * Supabase's catalogue without a new RPC, and the generated types already are
 * that catalogue, checked daily.
 *
 * Asked as the export's own Snowflake identity, so the check sees exactly the
 * tables the export writes to. It runs in the daily 13:00 batch, not inside an
 * export, because the sightings export's time budget has been starved once
 * already (#1078) and this must not take from it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { withDeadline } from '../archive/deadline'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { escapeSqlLiteral, executeStatement, type SnowflakeStatementResponse } from './snowflake'
import { BID_COLS, SIGHTING_COLS, readSnowflakeConfig, type ColSpec, type ColType } from './sightings-export'
import { ACHIEVE_COLS } from './achieve-export'
import type { Env } from '../index'

export const EXPORT_SCHEMA_JOB = 'export-schema-drift'

export const EXPORT_SCHEMA_REMEDY: AlertRemedy = {
  consequence:
    'A Snowflake table the nightly exports write to no longer accepts what the export sends, or its ' +
    'columns could not be read. No export has failed because of this yet, but the next one that meets ' +
    'the mismatch will, and it will keep failing every run until one side changes:',
  fixHint:
    'For each column listed, decide which side is right. Usually Snowflake is altered to match (ALTER ' +
    'TABLE ... ADD COLUMN, ALTER COLUMN ... DROP NOT NULL); otherwise change the column list in ' +
    'apps/worker/src/lib/sightings-export.ts or achieve-export.ts. Record the change in ' +
    'docs/snowflake-setup.sql. If the columns could not be read, check the export credentials and that ' +
    'Snowflake was reachable. This check runs again at 13:00 UTC.',
  headlineVerb: 'found a Snowflake table that disagrees with its export',
  itemNoun: { one: 'column', many: 'columns' },
}

/**
 * When the columns could not be read at all. Its own wording, because a header
 * saying a table disagrees with its export would be a claim the check never
 * measured (L11).
 */
export const EXPORT_SCHEMA_UNREADABLE_REMEDY: AlertRemedy = {
  consequence:
    'The daily comparison of the Snowflake export tables against the columns the exports send could not ' +
    'read those tables, so whether they still agree is unknown:',
  fixHint:
    'Check that Snowflake was reachable and that the export credentials (SNOWFLAKE_*) are set and valid. ' +
    'If the exports ran normally today, this was most likely a passing outage and the check runs again at ' +
    '13:00 UTC.',
  headlineVerb: 'could not read the Snowflake export tables',
  itemNoun: { one: 'reason', many: 'reasons' },
}

/** Total time this check may wait on Snowflake, so a slow morning cannot hold the daily batch open. */
export const EXPORT_SCHEMA_DEADLINE_MS = 2 * 60 * 1000

export interface ExportedTable {
  /** The table the export writes, unqualified, in the export's configured schema. */
  table: string
  cols: readonly ColSpec[]
  /** Exported columns the Supabase source declares NOT NULL, so the export never sends null for them. */
  neverNull: readonly string[]
  /** True when the export adds any missing column itself before it writes (`reconcileColumns`). */
  addsMissingColumns: boolean
}

export const EXPORTED_TABLES: readonly ExportedTable[] = [
  {
    table: 'lead_sightings',
    cols: SIGHTING_COLS,
    neverNull: ['id', 'trace_id', 'execution_id', 'workflow_id', 'execution_started_at_et', 'execution_started_at_utc'],
    addsMissingColumns: false,
  },
  {
    table: 'lead_sighting_bids',
    cols: BID_COLS,
    neverNull: [
      'id',
      'sighting_id',
      'trace_id',
      'execution_id',
      'partner_slug',
      'is_winner',
      'attempted_at_utc',
      'attempted_at_et',
    ],
    addsMissingColumns: false,
  },
  {
    table: 'achieve_evaluations',
    cols: ACHIEVE_COLS,
    neverNull: ['id', 'trace_id', 'execution_id', 'workflow_id', 'node_namespace', 'requested_at_utc', 'offer_count'],
    addsMissingColumns: true,
  },
]

/**
 * The DATA_TYPE values INFORMATION_SCHEMA may report for each export type.
 * VARCHAR is reported as TEXT. A NUMBER sent into a FLOAT column is stored
 * without loss for the whole numbers these exports send.
 */
const ACCEPTED_TYPES: Record<ColType, readonly string[]> = {
  varchar: ['TEXT', 'VARCHAR'],
  number: ['NUMBER', 'FLOAT'],
  boolean: ['BOOLEAN'],
  timestamp_tz: ['TIMESTAMP_TZ'],
  timestamp_ntz: ['TIMESTAMP_NTZ'],
  variant: ['VARIANT'],
}

export interface ObservedColumn {
  table: string
  name: string
  dataType: string
  nullable: boolean
  hasDefault: boolean
}

/** The drift between what each export sends and what Snowflake holds. Pure. */
export function schemaFindings(
  tables: readonly ExportedTable[],
  observed: readonly ObservedColumn[],
): { findings: string[]; unreadable: string[] } {
  const findings: string[] = []
  const unreadable: string[] = []

  for (const t of tables) {
    // Snowflake upper cases unquoted identifiers, so both sides compare in lower case.
    const live = new Map(
      observed.filter((c) => c.table.toLowerCase() === t.table).map((c) => [c.name.toLowerCase(), c]),
    )
    if (live.size === 0) {
      // No columns is a table that is missing or that the export's identity cannot
      // see, never a table with nothing wrong with it.
      unreadable.push(
        `${t.table}: Snowflake returned no columns for this table, so it is missing or the export's ` +
          'identity cannot see it, and its schema could not be checked',
      )
      continue
    }

    const sent = new Set(t.cols.map((c) => c.name))
    for (const col of t.cols) {
      const at = `${t.table}.${col.name}`
      const have = live.get(col.name)
      if (!have) {
        if (!t.addsMissingColumns) {
          findings.push(`${at}: the export sends this column and the Snowflake table does not have it`)
        }
        continue
      }
      if (!ACCEPTED_TYPES[col.type].includes(have.dataType.toUpperCase())) {
        findings.push(
          `${at}: the export sends it as ${col.type.toUpperCase()} and Snowflake stores it as ${have.dataType.toUpperCase()}`,
        )
      }
      if (!have.nullable && !t.neverNull.includes(col.name)) {
        findings.push(
          `${at}: Snowflake declares it NOT NULL but the Supabase column is nullable, so the export can send null for it`,
        )
      }
    }

    for (const [name, have] of live) {
      if (sent.has(name) || have.nullable || have.hasDefault) continue
      findings.push(
        `${t.table}.${name}: only Snowflake has this column and it is NOT NULL with no default, so every ` +
          'row the export inserts leaves it empty',
      )
    }
  }

  return { findings, unreadable }
}

export interface ExportSchemaResult {
  findings: string[]
  /** Everything that could not be established. Never empty when the check did not complete. */
  unreadable: string[]
  alerted: boolean
}

export interface ExportSchemaDeps {
  query?: (statement: string) => Promise<SnowflakeStatementResponse>
  deadlineMs?: number
  /** Injected so a test of the deadline is instant rather than a real wait (L524). */
  sleep?: (ms: number) => Promise<void>
}

export async function checkExportSchema(
  env: Env,
  supabase: SupabaseClient,
  deps: ExportSchemaDeps = {},
): Promise<ExportSchemaResult> {
  return withJobRun(
    supabase,
    EXPORT_SCHEMA_JOB,
    () => schemaPass(env, supabase, deps),
    exportSchemaEnding,
  )
}

/**
 * What the run's job_runs row says. Drift and an unreadable table can happen in
 * the same run, and the record carries both: letting the unreadable half decide
 * the outcome dropped the measured drift from the record while Slack still
 * carried it, so the two disagreed about what the run found.
 */
export function exportSchemaEnding(result: ExportSchemaResult): JobRunEnding {
  const drift = result.findings.length > 0
  const unreadable = result.unreadable.length > 0
  const parts: string[] = []
  if (drift) {
    parts.push(`${result.findings.length} column${result.findings.length === 1 ? ' disagrees' : 's disagree'} with the export`)
  }
  parts.push(...result.unreadable)
  return {
    outcome: drift && unreadable ? 'drift_and_unreadable' : drift ? 'drift' : unreadable ? 'unreadable' : 'ok',
    detail: parts.length > 0 ? parts.join('; ') : undefined,
    summary: { findings: result.findings.length, unreadable: result.unreadable.length, alerted: result.alerted },
  }
}

/** Index of a result column by NAME, since the position is not a stable contract (L156). */
function columnIndex(response: SnowflakeStatementResponse, name: string): number {
  return (response.resultSetMetaData?.rowType ?? []).findIndex((c) => c.name.toLowerCase() === name)
}

async function readColumns(
  env: Env,
  deps: ExportSchemaDeps,
): Promise<{ columns: ObservedColumn[] } | { reason: string }> {
  const config = readSnowflakeConfig(env)
  if (!config.schema) return { reason: 'no Snowflake schema is configured (SNOWFLAKE_SCHEMA)' }

  const query = deps.query ?? ((statement: string) => executeStatement(config, statement))
  const deadlineMs = deps.deadlineMs ?? EXPORT_SCHEMA_DEADLINE_MS
  const tableList = EXPORTED_TABLES.map((t) => `'${escapeSqlLiteral(t.table.toUpperCase())}'`).join(', ')
  // Scoped by schema as well as table name: information_schema.columns spans every
  // schema in the database, and a same named table elsewhere would answer for this one.
  const statement =
    'SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns' +
    ` WHERE table_schema = '${escapeSqlLiteral(config.schema.toUpperCase())}'` +
    ` AND table_name IN (${tableList})`

  let response: SnowflakeStatementResponse
  try {
    const raced = await withDeadline(deadlineMs, () => query(statement), { sleep: deps.sleep })
    if (raced.timedOut) {
      return { reason: `Snowflake did not answer inside the ${Math.round(deadlineMs / 1000)} second budget` }
    }
    response = raced.value
  } catch (err) {
    return { reason: `Snowflake refused or could not be reached: ${formatErr(err)}` }
  }

  const at = {
    table: columnIndex(response, 'table_name'),
    name: columnIndex(response, 'column_name'),
    dataType: columnIndex(response, 'data_type'),
    nullable: columnIndex(response, 'is_nullable'),
    default: columnIndex(response, 'column_default'),
  }
  const missing = Object.entries(at)
    .filter(([, i]) => i < 0)
    .map(([k]) => k)
  if (missing.length > 0) {
    return { reason: `Snowflake answered in a shape without the expected columns (${missing.join(', ')})` }
  }

  const rows = response.data ?? []
  if (rows.length === 0) {
    return { reason: "Snowflake returned no columns for any exported table, so the export's identity cannot see them" }
  }

  const columns: ObservedColumn[] = []
  for (const r of rows) {
    const table = r[at.table]
    const name = r[at.name]
    const dataType = r[at.dataType]
    const nullable = r[at.nullable]
    if (typeof table !== 'string' || typeof name !== 'string' || typeof dataType !== 'string') {
      return { reason: 'Snowflake returned a column row this could not read' }
    }
    columns.push({
      table,
      name,
      dataType,
      nullable: nullable === 'YES',
      hasDefault: r[at.default] !== null && r[at.default] !== undefined && r[at.default] !== '',
    })
  }
  return { columns }
}

async function schemaPass(env: Env, supabase: SupabaseClient, deps: ExportSchemaDeps): Promise<ExportSchemaResult> {
  const read = await readColumns(env, deps)
  const { findings, unreadable } =
    'reason' in read
      ? { findings: [], unreadable: [`The export schemas could not be checked: ${read.reason}`] }
      : schemaFindings(EXPORTED_TABLES, read.columns)

  const messages = [...unreadable, ...findings]
  // Findings take the drift wording even beside an unreadable table: something
  // was measured to disagree, and the unreadable lines say which table was not.
  const remedy = findings.length > 0 ? EXPORT_SCHEMA_REMEDY : EXPORT_SCHEMA_UNREADABLE_REMEDY
  await notifyExportFailure(supabase, EXPORT_SCHEMA_JOB, messages, env.IDEMPOTENCY, remedy)
  console.log(`[export-schema] findings=${findings.length} unreadable=${unreadable.length}`)
  return { findings, unreadable, alerted: messages.length > 0 }
}
