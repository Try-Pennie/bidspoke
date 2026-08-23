/**
 * Reads the archive's Snowflake settings back on a schedule (#980).
 *
 * The decision is in `archive/settings-drift.ts` and is pure. This is the half
 * that asks Snowflake, through the READER identity: the check needs to see the
 * table, not to change it, and running it as the writer would prove less while
 * risking more.
 *
 * Reading a SHOW result BY COLUMN NAME rather than by position, because SHOW
 * output is not a stable contract and an index that quietly shifted would read
 * the wrong cell and report a passing check about the wrong thing (L156, L215).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure } from './export-alerts'
import { executeStatement, type SnowflakeStatementResponse } from './snowflake'
import {
  archiveConfig,
  ARCHIVE_DATABASE,
  ARCHIVE_SCHEMA,
  ARCHIVE_TABLE,
  ARCHIVE_UNDO_WINDOW_DAYS,
} from './archive-snowflake'
import { insertColumns } from './execution-archive-send'
import { settingsDifferences, type ObservedSettings } from '../archive/settings-drift'
import type { Env } from '../index'

export const ARCHIVE_SETTINGS_JOB = 'execution-archive-settings'

/**
 * Columns the table legitimately has that the writer never sets.
 *
 * `amended_at_utc` is written by the amend pass rewriting a row, not by the
 * insert. Listed rather than tolerated as a class, so a column added by hand is
 * still reported.
 */
export const EXPECTED_EXTRA_COLUMNS = ['amended_at_utc']

export interface SettingsCheckResult {
  observed: ObservedSettings
  differences: ReturnType<typeof settingsDifferences>
  alerted: boolean
}

export interface SettingsCheckDeps {
  query?: (statement: string) => Promise<SnowflakeStatementResponse>
}

/** Reads one cell of one row by its column NAME, or null when the shape is not what was expected. */
function cell(response: SnowflakeStatementResponse, row: number, column: string): string | null {
  const names = response.resultSetMetaData?.rowType?.map((c) => c.name.toLowerCase())
  if (names === undefined) return null
  const at = names.indexOf(column.toLowerCase())
  if (at < 0) return null
  const value = response.data?.[row]?.[at]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

export async function checkArchiveSettings(
  env: Env,
  supabase: SupabaseClient,
  deps: SettingsCheckDeps = {},
): Promise<SettingsCheckResult> {
  const query =
    deps.query ?? ((statement: string) => executeStatement(archiveConfig(env, 'reader'), statement))

  const observed: ObservedSettings = {
    retentionDays: null,
    retentionLevel: null,
    columns: null,
    unreadable: [],
  }

  // Each read in its own try. One failing must not hide what the others found:
  // a check that reports nothing because its first query failed is
  // indistinguishable from a check that found everything correct.
  try {
    const response = await query(
      `SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN TABLE ` +
        `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`,
    )
    const value = cell(response, 0, 'value')
    const level = cell(response, 0, 'level')
    if (value === null) {
      observed.unreadable.push(
        `the Time Travel window came back in a shape with no readable value (${response.message ?? 'no message'})`,
      )
    } else {
      const days = Number(value)
      if (Number.isFinite(days)) observed.retentionDays = days
      else observed.unreadable.push(`the Time Travel window came back as "${value}", which is not a number`)
    }
    // An empty level is not 'TABLE'. Snowflake reports the empty string when a
    // parameter is at its account default, so reading it as absent-and-therefore
    // fine would pass the exact case this looks for.
    observed.retentionLevel = level === null ? null : level === '' ? 'ACCOUNT DEFAULT' : level
    if (level === null) observed.unreadable.push('the Time Travel window carried no level, so it is unknown whether the table owns it')
  } catch (err) {
    observed.unreadable.push(`the Time Travel window could not be read: ${formatErr(err)}`)
  }

  try {
    const response = await query(
      `SELECT column_name FROM ${ARCHIVE_DATABASE}.INFORMATION_SCHEMA.COLUMNS ` +
        `WHERE table_schema = '${ARCHIVE_SCHEMA}' AND table_name = '${ARCHIVE_TABLE}' ` +
        'ORDER BY ordinal_position',
    )
    const rows = response.data ?? []
    if (rows.length === 0) {
      // Zero columns is not a table with no columns, it is a table that is not
      // there, or a reader that cannot see it. Either is worth saying.
      observed.unreadable.push(
        'the archive table reported no columns at all, so it is missing or the reader cannot see it',
      )
    } else {
      observed.columns = rows.map((r) => String(r[0]))
    }
  } catch (err) {
    observed.unreadable.push(`the archive table's columns could not be read: ${formatErr(err)}`)
  }

  const differences = settingsDifferences(observed, {
    retentionDays: ARCHIVE_UNDO_WINDOW_DAYS,
    requiredColumns: insertColumns,
    expectedExtraColumns: EXPECTED_EXTRA_COLUMNS,
  })

  await notifyExportFailure(
    supabase,
    ARCHIVE_SETTINGS_JOB,
    differences.map((d) => d.message),
    env.IDEMPOTENCY,
  )

  console.log(
    `[archive-settings] retention=${String(observed.retentionDays)} level=${String(observed.retentionLevel)} ` +
      `columns=${observed.columns?.length ?? 'unreadable'} differences=${differences.length}`,
  )

  return { observed, differences, alerted: differences.length > 0 }
}
