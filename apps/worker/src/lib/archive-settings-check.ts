/**
 * Reads the archive's Snowflake settings back on a schedule (#980, #1050).
 *
 * The decision is in `archive/settings-drift.ts` and is pure. This is the half
 * that asks Snowflake, through the READER identity: the check needs to see the
 * table, not to change it, and running it as the writer would prove less while
 * risking more.
 *
 * EVERY READ HERE IS ONE THE READER IS ALLOWED TO RUN, which is not a detail.
 * The first version asked for the Time Travel window with
 * `SHOW PARAMETERS ... IN TABLE`, and Snowflake refuses that for a role holding
 * only SELECT: reading an object's parameters effectively needs ownership, and
 * there is no grantable USAGE on a table to hand out. So from the day it shipped
 * this check reported its own refusal every morning and asserted nothing about
 * the window it exists to assert (#1050). The fix is not a wider grant, which
 * would let the read path drop the archive table, but statements the reader can
 * answer: INFORMATION_SCHEMA carries RETENTION_TIME for the table, the schema
 * and the database, and shows every object the role has a privilege on.
 *
 * What that costs, stated plainly: the parameter's LEVEL is not in
 * INFORMATION_SCHEMA, so this can no longer tell an inherited window from one
 * the table owns. The surrounding windows are read instead, which answers the
 * question the level was asked for (what the archive falls back to) using
 * privileges the reader already holds.
 *
 * Reading a result BY COLUMN NAME rather than by position, because the column
 * order is not a stable contract and an index that quietly shifted would read
 * the wrong cell and report a passing check about the wrong thing (L156, L215).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { withJobRun } from './job-run-record'
import { withDeadline } from '../archive/deadline'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
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

/**
 * The archive table's live Snowflake settings differ from what this repo
 * declares. Two settings disagree; no rows are involved.
 */
export const ARCHIVE_SETTINGS_REMEDY: AlertRemedy = {
  consequence:
    "The archive table's settings in Snowflake and the settings this repo declares disagree, or a " +
    'setting could not be read. This is about configuration, not data: nothing was sent anywhere and ' +
    'nothing is missing. Until one side changes, what we say about undoing an accidental deletion is ' +
    'wrong:',
  fixHint:
    'Decide which side is right, then either alter the table in Snowflake to match, or change the ' +
    'declared value in this repo and the matching architecture decision record. A missing column has to ' +
    'be added in Snowflake before any send succeeds. Re-run on demand with POST ' +
    '/api/admin/archive-settings-check.',
  headlineVerb: 'found a setting that disagrees',
  itemNoun: { one: 'difference', many: 'differences' },
}

/**
 * The wording for THIS run's differences, chosen from their codes (#835).
 *
 * One remedy used to say "what we say about undoing an accidental deletion is
 * wrong" and "alter the table" for every finding, including a read that failed
 * and a check reading the wrong account, where neither sentence is true. The
 * consequence names the undo window only when the table's own window changed,
 * and the fix carries one sentence per kind of difference present.
 */
export function settingsRemedyFor(codes: readonly string[]): AlertRemedy {
  const has = (code: string) => codes.includes(code)
  const consequence =
    "The archive table's settings in Snowflake and the settings this repo declares disagree, or a setting " +
    'could not be read. This is about configuration, not data: nothing was sent anywhere and nothing is ' +
    'missing' +
    (has('retention-changed')
      ? '. Until one side changes, what we say about undoing an accidental deletion is wrong:'
      : ':')
  const fixes: string[] = []
  if (has('unreadable')) {
    fixes.push(
      'For a setting that could not be read, the line names the read. The check reads as ' +
        'bidspoke_archive_reader, so check that role and its key: wrangler secret put ' +
        'ARCHIVE_READER_PRIVATE_KEY --name bidspoke-worker.',
    )
  }
  if (has('wrong-account')) {
    fixes.push(
      `Point SNOWFLAKE_ACCOUNT back at ${DECLARED_SNOWFLAKE_ACCOUNT} with wrangler secret put SNOWFLAKE_ACCOUNT ` +
        '--name bidspoke-worker, or, if the archive really moved, change the declared account in this repo ' +
        'and ADR 0009.',
    )
  }
  if (codes.some((c) => c === 'retention-changed' || c.startsWith('surrounding-retention'))) {
    fixes.push(
      'For a Time Travel window, decide which side is right, then either alter the table, schema or database ' +
        'in Snowflake to match, or change the declared value in this repo and ADR 0009.',
    )
  }
  if (has('columns-missing')) fixes.push('Add each missing column to the archive table in Snowflake.')
  if (has('columns-added')) {
    fixes.push('Declare each added column in this repo, or drop it in Snowflake if nobody meant to add it.')
  }
  fixes.push('Re-run on demand with POST /api/admin/archive-settings-check.')
  return { ...ARCHIVE_SETTINGS_REMEDY, consequence, fixHint: fixes.join(' ') }
}

/**
 * The Snowflake account the archive setup was applied to (ADR 0009, measured
 * 2026-08-20).
 *
 * A constant rather than an env var on purpose: the env var is the thing being
 * checked, so reading the expectation from it would let both sides come from
 * one lookup and prove only that the lookup is consistent with itself (L70).
 * If the account legitimately changes, this changes with a deliberate edit and
 * the ADR changes with it.
 */
export const DECLARED_SNOWFLAKE_ACCOUNT = 'JYC55588'

/**
 * How long this check may spend in Snowflake in total (#1053).
 *
 * It issues five statements in sequence and each can wake a suspended warehouse
 * and wait on it. Nothing capped the total, and the check SHARES its daily
 * invocation with the identity check and the deletion gate, so a slow Snowflake
 * morning could push the whole invocation past its ceiling and get it killed.
 *
 * A killed invocation writes no record and sends no alert, which is
 * indistinguishable from a morning where everything was fine (L98). The failure
 * mode is quiet precisely on the days the archive is least healthy, which is
 * the shape this milestone exists to remove.
 *
 * Two minutes leaves the rest of the shared invocation its room. Reaching it is
 * reported as an unreadable setting, which is what it is: the check did not
 * establish the thing it was asked about.
 */
export const SETTINGS_CHECK_DEADLINE_MS = 2 * 60 * 1000

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
  /** Total time in Snowflake before the check reports what it could not read (#1053). */
  deadlineMs?: number
  /** Injected so a test of the deadline is instant rather than a real wait (L524). */
  sleep?: (ms: number) => Promise<void>
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

/**
 * One RETENTION_TIME cell, or null with the reason recorded.
 *
 * Every way this can come back empty is its own message. A missing row and a
 * refused statement are different situations with different remedies, and one
 * message covering both would send whoever reads it looking in the wrong place
 * (L11).
 */
async function readRetention(
  query: (statement: string) => Promise<SnowflakeStatementResponse>,
  observed: ObservedSettings,
  subject: string,
  statement: string,
): Promise<number | null> {
  try {
    const response = await query(statement)
    if ((response.data ?? []).length === 0) {
      // No row is not a window of none. Either the object is gone or the reader
      // cannot see it, and both are worth saying.
      observed.unreadable.push(
        `${subject}'s Time Travel window matched no row, so it is missing or the reader cannot see it`,
      )
      return null
    }
    const value = cell(response, 0, 'retention_time')
    if (value === null) {
      observed.unreadable.push(
        `${subject}'s Time Travel window came back in a shape with no readable value ` +
          `(${response.message ?? 'no message'})`,
      )
      return null
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      observed.unreadable.push(`${subject}'s Time Travel window came back as "${value}", which is not a number`)
      return null
    }
    return parsed
  } catch (err) {
    observed.unreadable.push(`${subject}'s Time Travel window could not be read: ${formatErr(err)}`)
    return null
  }
}

export async function checkArchiveSettings(
  env: Env,
  supabase: SupabaseClient,
  deps: SettingsCheckDeps = {},
): Promise<SettingsCheckResult> {
  // Its own run record, so a pass the platform killed is distinguishable from
  // one that had nothing to say. Before this its only liveness sign was an
  // alert, and a check that dies silently reads exactly like a check that
  // passed (#1251, L98).
  return withJobRun(
    supabase,
    ARCHIVE_SETTINGS_JOB,
    () => settingsPass(env, supabase, deps),
    (result) => ({
      outcome: result.differences.length === 0 ? 'ok' : 'differences',
      detail:
        result.differences.length === 0
          ? undefined
          : `${result.differences.length} setting${result.differences.length === 1 ? '' : 's'} differ from what the archive expects`,
      summary: { differences: result.differences.length, alerted: result.alerted },
    }),
  )
}

async function settingsPass(
  env: Env,
  supabase: SupabaseClient,
  deps: SettingsCheckDeps = {},
): Promise<SettingsCheckResult> {
  const rawQuery =
    deps.query ?? ((statement: string) => executeStatement(archiveConfig(env, 'reader'), statement))

  // ONE deadline across every statement, not one each (#1053). Five statements
  // each given their own would still add up past the shared invocation's
  // ceiling, which is the thing that gets the whole morning killed.
  const startedAt = Date.now()
  const deadlineMs = deps.deadlineMs ?? SETTINGS_CHECK_DEADLINE_MS
  // Once the budget has actually been HIT, it is spent, and the remaining
  // statements say so rather than each starting a fresh wait. Elapsed time
  // alone is not enough to know that: the wait that consumed the budget is
  // still in flight, so the clock has not necessarily moved past it yet.
  let spent = false
  const query = async (statement: string): Promise<SnowflakeStatementResponse> => {
    const remaining = deadlineMs - (Date.now() - startedAt)
    if (spent || remaining <= 0) {
      throw new Error(
        `the archive settings check ran out of its ${Math.round(deadlineMs / 1000)} second budget in ` +
          'Snowflake before this statement, so this setting was not established',
      )
    }
    const raced = await withDeadline(remaining, () => rawQuery(statement), { sleep: deps.sleep })
    if (raced.timedOut) {
      spent = true
      throw new Error(
        `the archive settings check ran out of its ${Math.round(deadlineMs / 1000)} second budget in ` +
          'Snowflake while waiting on this statement, so this setting was not established',
      )
    }
    return raced.value
  }

  const observed: ObservedSettings = {
    retentionDays: null,
    surroundingRetentionDays: [],
    columns: null,
    account: null,
    unreadable: [],
  }

  // Each read in its own try. One failing must not hide what the others found:
  // a check that reports nothing because its first query failed is
  // indistinguishable from a check that found everything correct.
  observed.retentionDays = await readRetention(
    query,
    observed,
    'the archive table',
    `SELECT retention_time FROM ${ARCHIVE_DATABASE}.INFORMATION_SCHEMA.TABLES ` +
      `WHERE table_schema = '${ARCHIVE_SCHEMA}' AND table_name = '${ARCHIVE_TABLE}'`,
  )

  // The two windows the archive would fall back to. Read even when the table's
  // own is correct: the point is to know the fallback BEFORE anything depends on
  // it, not to explain a shortfall afterwards.
  for (const surrounding of [
    {
      level: `${ARCHIVE_SCHEMA} schema`,
      statement:
        `SELECT retention_time FROM ${ARCHIVE_DATABASE}.INFORMATION_SCHEMA.SCHEMATA ` +
        `WHERE schema_name = '${ARCHIVE_SCHEMA}'`,
    },
    {
      level: `${ARCHIVE_DATABASE} database`,
      statement:
        `SELECT retention_time FROM ${ARCHIVE_DATABASE}.INFORMATION_SCHEMA.DATABASES ` +
        `WHERE database_name = '${ARCHIVE_DATABASE}'`,
    },
  ]) {
    observed.surroundingRetentionDays.push({
      level: surrounding.level,
      days: await readRetention(query, observed, `the ${surrounding.level}`, surrounding.statement),
    })
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

  // WHICH ACCOUNT these readings came from (#1052). Read last so a failure here
  // cannot cost the readings above, and compared first in the drift rules, so a
  // wrong account is reported ahead of the settings it would invalidate.
  try {
    const response = await query('SELECT CURRENT_ACCOUNT()')
    const value = response.data?.[0]?.[0]
    if (typeof value === 'string' || typeof value === 'number') {
      observed.account = String(value)
    } else {
      observed.unreadable.push('the Snowflake account name came back in a shape this could not read')
    }
  } catch (err) {
    observed.unreadable.push(`the Snowflake account name could not be read: ${formatErr(err)}`)
  }

  const differences = settingsDifferences(observed, {
    retentionDays: ARCHIVE_UNDO_WINDOW_DAYS,
    account: DECLARED_SNOWFLAKE_ACCOUNT,
    requiredColumns: insertColumns,
    expectedExtraColumns: EXPECTED_EXTRA_COLUMNS,
  })

  await notifyExportFailure(
    supabase,
    ARCHIVE_SETTINGS_JOB,
    differences.map((d) => d.message),
    env.IDEMPOTENCY,
    settingsRemedyFor(differences.map((d) => d.code)),
  )

  const surrounding = observed.surroundingRetentionDays
    .map((s) => `${s.level}=${String(s.days)}`)
    .join(' ')
  console.log(
    `[archive-settings] retention=${String(observed.retentionDays)} ${surrounding} ` +
      `columns=${observed.columns?.length ?? 'unreadable'} differences=${differences.length}`,
  )

  return { observed, differences, alerted: differences.length > 0 }
}
