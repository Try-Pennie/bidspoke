/**
 * Reading the archive's Snowflake settings back (#980, #1050).
 *
 * Drives the real check against a Snowflake double answering in the shape the
 * REST API actually returns, including `resultSetMetaData.rowType`, so the
 * by-name cell lookup is exercised rather than assumed.
 *
 * The failure this guards against is specific and has already happened once in
 * this milestone: ADR 0009 recorded the undo window as a measured fact, it was
 * wrong for days, and it was caught only because somebody happened to probe.
 *
 * It happened a second way in #1050. The retention read was written as
 * `SHOW PARAMETERS ... IN TABLE`, which the reader identity may not run at all,
 * so from the day it shipped this check reported its own refusal every morning
 * and asserted nothing about the window. Hence `every read is one the reader is
 * allowed to run` below: it is the regression guard for that, and it is the only
 * test here that fails on the statement rather than on the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  checkArchiveSettings,
  settingsRemedyFor,
  ARCHIVE_SETTINGS_REMEDY,
  ARCHIVE_SETTINGS_JOB,
  DECLARED_SNOWFLAKE_ACCOUNT,
  EXPECTED_EXTRA_COLUMNS,
} from '../archive-settings-check'
import { ARCHIVE_UNDO_WINDOW_DAYS } from '../archive-snowflake'
import { insertColumns } from '../execution-archive-send'
import { notifyExportFailure } from '../export-alerts'
import type { SnowflakeStatementResponse } from '../snowflake'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = {} as unknown as Env
const supabase = {} as unknown as SupabaseClient

/**
 * One RETENTION_TIME cell, in the shape INFORMATION_SCHEMA answers with.
 *
 * The value arrives as a string over the REST API even though the column is a
 * NUMBER, which is why the check parses rather than trusts it.
 */
function retention(days: number | string): SnowflakeStatementResponse {
  return {
    resultSetMetaData: { rowType: [{ name: 'RETENTION_TIME', type: 'fixed' }] },
    data: [[String(days)]],
  }
}

/** A read that matched no row: the object is gone, or the reader cannot see it. */
const noRow: SnowflakeStatementResponse = {
  resultSetMetaData: { rowType: [{ name: 'RETENTION_TIME', type: 'fixed' }] },
  data: [],
}

function columnsResponse(names: string[]): SnowflakeStatementResponse {
  return {
    resultSetMetaData: { rowType: [{ name: 'COLUMN_NAME', type: 'text' }] },
    data: names.map((n) => [n]),
  }
}

const ALL_COLUMNS = [...insertColumns, ...EXPECTED_EXTRA_COLUMNS]

/** Every statement the last `run()` issued, so a test can assert on the SQL itself. */
let issued: string[] = []

type Answer = SnowflakeStatementResponse | Error

function run(
  opts: {
    table?: Answer
    schema?: Answer
    database?: Answer
    columns?: Answer
    account?: Answer
  } = {},
) {
  const answers = {
    table: opts.table ?? retention(ARCHIVE_UNDO_WINDOW_DAYS),
    schema: opts.schema ?? retention(ARCHIVE_UNDO_WINDOW_DAYS),
    database: opts.database ?? retention(ARCHIVE_UNDO_WINDOW_DAYS),
    columns: opts.columns ?? columnsResponse(ALL_COLUMNS),
    // The account the archive setup was applied to, so the ordinary case here
    // is a check reading the RIGHT account (#1052).
    account: opts.account ?? ({ data: [[DECLARED_SNOWFLAKE_ACCOUNT]] } as SnowflakeStatementResponse),
  }

  return checkArchiveSettings(env, supabase, {
    query: async (statement: string) => {
      issued.push(statement)
      const upper = statement.toUpperCase()
      const answer = upper.includes('CURRENT_ACCOUNT')
        ? answers.account
        : upper.includes('INFORMATION_SCHEMA.COLUMNS')
        ? answers.columns
        : upper.includes('INFORMATION_SCHEMA.TABLES')
          ? answers.table
          : upper.includes('INFORMATION_SCHEMA.SCHEMATA')
            ? answers.schema
            : upper.includes('INFORMATION_SCHEMA.DATABASES')
              ? answers.database
              : new Error(`the check issued a statement this test does not answer: ${statement}`)
      if (answer instanceof Error) throw answer
      return answer
    },
  })
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === ARCHIVE_SETTINGS_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
  issued = []
})

describe('settings that match what the repo declares', () => {
  it('reports no difference and raises nothing', async () => {
    const result = await run()

    expect(result.differences).toEqual([])
    expect(result.alerted).toBe(false)
    expect(alerted()).toEqual([])
  })

  it('reads the values by column name, not by position', async () => {
    // The negative control for the whole read. A column order that shifted would
    // read the wrong cell and report a passing check about the wrong thing.
    const shuffled: SnowflakeStatementResponse = {
      resultSetMetaData: {
        rowType: [
          { name: 'TABLE_NAME', type: 'text' },
          { name: 'BYTES', type: 'fixed' },
          { name: 'RETENTION_TIME', type: 'fixed' },
        ],
      },
      data: [['EXECUTION_ARCHIVE', '1234', String(ARCHIVE_UNDO_WINDOW_DAYS)]],
    }

    const result = await run({ table: shuffled })

    expect(result.observed.retentionDays).toBe(ARCHIVE_UNDO_WINDOW_DAYS)
    expect(result.differences).toEqual([])
  })
})

describe('every read is one the reader is allowed to run', () => {
  it('never asks for the table parameter, which the reader identity may not read', async () => {
    // #1050. `SHOW PARAMETERS ... IN TABLE` is refused for a role holding only
    // SELECT: reading an object's parameters effectively needs ownership, and
    // there is no grantable USAGE on a table to hand out. Granting it would give
    // the read path the power to drop the archive, which is the opposite of the
    // split the design rests on, so the statement itself is the thing that must
    // not come back.
    await run()

    expect(issued.length).toBeGreaterThan(0)
    expect(issued.filter((s) => s.toUpperCase().includes('SHOW PARAMETERS'))).toEqual([])
  })

  it('reads all three windows and the column set, so no fact is assumed', async () => {
    await run()

    const upper = issued.map((s) => s.toUpperCase())
    expect(upper.filter((s) => s.includes('INFORMATION_SCHEMA.TABLES'))).toHaveLength(1)
    expect(upper.filter((s) => s.includes('INFORMATION_SCHEMA.SCHEMATA'))).toHaveLength(1)
    expect(upper.filter((s) => s.includes('INFORMATION_SCHEMA.DATABASES'))).toHaveLength(1)
    expect(upper.filter((s) => s.includes('INFORMATION_SCHEMA.COLUMNS'))).toHaveLength(1)
  })
})

describe('a Time Travel window that no longer matches', () => {
  it('is reported, naming both numbers and what it invalidates', async () => {
    const result = await run({ table: retention(1) })

    expect(result.differences.map((d) => d.code)).toEqual(['retention-changed'])
    expect(alerted()[0]).toMatch(/is 1 day, and this repo and ADR 0009 declare 30 days/)
  })

  it('reports a window that is not a number rather than reading it as absent', async () => {
    const result = await run({ table: retention('null') })

    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
    expect(alerted()[0]).toMatch(/"null"/)
  })
})

describe('the windows the archive would fall back to', () => {
  // What replaced the parameter LEVEL read, which no least-privileged identity
  // can see. The level answered "is the table inheriting this, so a default
  // change will move it". Reading the surrounding defaults answers the thing
  // that actually matters: if the table's own setting is ever lost, this is the
  // window the archive drops to.

  it('reports a schema default below the declared window', async () => {
    const result = await run({ schema: retention(1) })

    expect(result.differences.map((d) => d.code)).toEqual(['surrounding-retention-below'])
    expect(alerted()[0]).toMatch(/EXECUTIONS schema/)
    expect(alerted()[0]).toMatch(/1 day/)
  })

  it('reports a database default below the declared window', async () => {
    const result = await run({ database: retention(1) })

    expect(result.differences.map((d) => d.code)).toEqual(['surrounding-retention-below'])
    expect(alerted()[0]).toMatch(/BIDSPOKE_ARCHIVE database/)
  })

  it('reports each level that is below, not just the first', async () => {
    const result = await run({ schema: retention(1), database: retention(1) })

    expect(result.differences.map((d) => d.code)).toEqual([
      'surrounding-retention-below',
      'surrounding-retention-below',
    ])
  })

  it('reports a surrounding window wider than the declared one, as its own thing', async () => {
    // Not the same finding as one below, and not silence either. Nothing is at
    // risk, because the table still carries 30, so the message must not read as
    // a shortfall. What it does mean is that the account and this repo disagree
    // about a setting that is billed for, which is worth a line rather than a
    // storage bill nobody traces back (L11).
    const result = await run({ schema: retention(60) })

    expect(result.differences.map((d) => d.code)).toEqual(['surrounding-retention-above'])
    expect(alerted()[0]).toMatch(/60 days/)
    expect(alerted()[0]).not.toMatch(/falls/)
  })

  it('tells a wider surrounding window apart from a shorter one in the same run', async () => {
    const result = await run({ schema: retention(60), database: retention(1) })

    expect(result.differences.map((d) => d.code)).toEqual([
      'surrounding-retention-above',
      'surrounding-retention-below',
    ])
  })
})

describe('the column set', () => {
  it('reports a column the writer names that the table does not have', async () => {
    const result = await run({ columns: columnsResponse(ALL_COLUMNS.filter((c) => c !== 'ssn_hash')) })

    expect(result.differences.map((d) => d.code)).toEqual(['columns-missing'])
    expect(alerted()[0]).toMatch(/ssn_hash/)
    expect(alerted()[0]).toMatch(/Every send fails/)
  })

  it('reports a column nobody declared, without calling it a failure', async () => {
    const result = await run({ columns: columnsResponse([...ALL_COLUMNS, 'notes_from_someone']) })

    expect(result.differences.map((d) => d.code)).toEqual(['columns-added'])
    expect(alerted()[0]).toMatch(/Nothing is broken/)
  })

  it('accepts the columns the writer never sets, so the check is not always refusing', async () => {
    // amended_at_utc is written by the amend pass, not by the insert.
    expect(EXPECTED_EXTRA_COLUMNS.length).toBeGreaterThan(0)
    const result = await run()
    expect(result.differences).toEqual([])
  })

  it('treats a table reporting no columns as missing, not as a table with none', async () => {
    const result = await run({ columns: columnsResponse([]) })

    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
    expect(alerted()[0]).toMatch(/missing or the reader cannot see it/)
  })
})

describe('when a read fails', () => {
  it('says so, rather than reporting settings that are fine', async () => {
    // A check that could not read the setting has established nothing, and
    // reporting nothing is what makes an unverified guarantee look verified.
    const result = await run({ table: new Error('warehouse could not resume') })

    expect(result.differences.map((d) => d.code)).toContain('unreadable')
    expect(alerted().join(' ')).toMatch(/warehouse could not resume/)
  })

  it('treats a window that matched no row as unreadable, not as a window of none', async () => {
    const result = await run({ table: noRow })

    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
    expect(alerted()[0]).toMatch(/missing or the reader cannot see it/)
  })

  it('still reports what the other reads found', async () => {
    // One failing read must not hide another's finding.
    const result = await run({
      table: new Error('warehouse could not resume'),
      columns: columnsResponse(ALL_COLUMNS.filter((c) => c !== 'bundle_gz_b64')),
    })

    expect(result.differences.map((d) => d.code)).toEqual(['unreadable', 'columns-missing'])
  })
})

/**
 * Which account these readings came from (#1052).
 *
 * Every reading in this check is a statement ABOUT an account, and nothing
 * asserted which one. A rotated secret, a restored config or a second account
 * would leave the daily check reporting a healthy retention window and a
 * correct column set belonging to somewhere the archive is not being written,
 * which is the most reassuring possible way to be wrong (L58).
 */
describe('the account these checks are reading', () => {
  it('says nothing when it is the account the setup was applied to', async () => {
    const result = await run()

    expect(result.differences.map((d) => d.code)).not.toContain('wrong-account')
    expect(result.observed.account).toBe(DECLARED_SNOWFLAKE_ACCOUNT)
  })

  it('reports a different account, and says it invalidates the readings below', async () => {
    const result = await run({
      account: { data: [['SOMEWHERE_ELSE']] } as SnowflakeStatementResponse,
    })

    const wrong = result.differences.find((d) => d.code === 'wrong-account')
    expect(wrong).toBeDefined()
    expect(wrong?.message).toContain('SOMEWHERE_ELSE')
    expect(wrong?.message).toContain(DECLARED_SNOWFLAKE_ACCOUNT)
    // The point of reporting it at all: a healthy looking window from the wrong
    // account is worse than an unreadable one.
    expect(wrong?.message).toMatch(/rather than the archive|including any that look healthy/)
  })

  it('reports it FIRST, ahead of the settings it would invalidate', async () => {
    const result = await run({
      account: { data: [['SOMEWHERE_ELSE']] } as SnowflakeStatementResponse,
      table: retention(1),
    })

    expect(result.differences[0].code).toBe('wrong-account')
    expect(result.differences.length).toBeGreaterThan(1)
  })

  it('reports an unreadable account rather than assuming it is the right one', async () => {
    const result = await run({ account: new Error('refused') })

    expect(result.observed.account).toBeNull()
    expect(result.differences.map((d) => d.code)).toContain('unreadable')
  })

  it('does not lose the other readings when the account read fails', async () => {
    // Read last on purpose: a failure here must not cost the settings above it.
    const result = await run({ account: new Error('refused') })

    expect(result.observed.retentionDays).toBe(ARCHIVE_UNDO_WINDOW_DAYS)
    expect(result.observed.columns).not.toBeNull()
  })
})

/**
 * The check stops itself before the shared invocation is stopped for it (#1053).
 *
 * It issues five statements in sequence and each can wake a suspended warehouse
 * and wait on it. It SHARES its daily invocation with the identity check and
 * the deletion gate, so a slow Snowflake morning could push the whole
 * invocation past its ceiling and get it killed. A killed invocation writes no
 * record and sends no alert, which is indistinguishable from a morning where
 * everything was fine, and it is quiet precisely on the days the archive is
 * least healthy (L98).
 */
describe('the settings check bounds its time in Snowflake', () => {
  /** A sleep that fires at once, so the deadline case costs nothing (L524). */
  const expireNow = () => Promise.resolve()

  it('reports what it could not establish, rather than being killed mid-statement', async () => {
    const result = await checkArchiveSettings(env, supabase, {
      // A statement that never returns, which is what a suspended warehouse
      // looks like from here.
      query: () => new Promise<never>(() => {}),
      sleep: expireNow,
    })

    // Unreadable, not healthy. The check did not establish the thing it was
    // asked about, and saying nothing would make an unverified guarantee look
    // verified.
    expect(result.differences.map((d) => d.code)).toContain('unreadable')
    expect(result.differences.map((d) => d.message).join(' ')).toMatch(/budget/)
  })

  it('does not spend the budget again on every statement', async () => {
    // Five statements each given the full deadline would still add up past the
    // shared invocation's ceiling, which is the thing that gets the morning
    // killed. One budget across all of them.
    let calls = 0
    const result = await checkArchiveSettings(env, supabase, {
      query: () => {
        calls += 1
        return new Promise<never>(() => {})
      },
      sleep: expireNow,
    })

    // The first statement consumes the budget; the rest report it as spent
    // rather than each waiting again.
    expect(calls).toBe(1)
    expect(result.differences.filter((d) => d.code === 'unreadable').length).toBeGreaterThan(1)
  })

  it('leaves a fast morning completely unaffected', async () => {
    // A deadline that never fires must not change the ordinary result.
    const result = await run()
    expect(result.differences).toEqual([])
  })
})

/**
 * #835: the remedy said "what we say about undoing an accidental deletion is
 * wrong" and "alter the table" for every finding, including a read that failed
 * and a check reading the wrong account, where neither is true.
 */
describe('the settings remedy is chosen from what differed', () => {
  const remedySent = () =>
    vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === ARCHIVE_SETTINGS_JOB && (c[2] as string[]).length > 0)?.[4] as {
      consequence: string
      fixHint: string
    }

  it('names the undo window only when the table window itself changed', async () => {
    await run({ table: retention(ARCHIVE_UNDO_WINDOW_DAYS - 1) })
    expect(remedySent().consequence).toMatch(/undoing an accidental deletion/)
    expect(remedySent().fixHint).toMatch(/alter the table/)
  })

  it('gives an unreadable setting its own fix, not alter the table', async () => {
    await run({ table: new Error('SQL compilation error: 002003') })
    const remedy = remedySent()
    expect(remedy.consequence).not.toMatch(/undoing an accidental deletion is wrong/)
    expect(remedy.fixHint).not.toMatch(/alter the table/)
    expect(remedy.fixHint).toMatch(/ARCHIVE_READER_PRIVATE_KEY|bidspoke_archive_reader/)
  })

  it('gives a wrong account its own fix, pointing SNOWFLAKE_ACCOUNT back', async () => {
    await run({ account: { data: [['XX99999']] } as SnowflakeStatementResponse })
    const remedy = remedySent()
    expect(remedy.consequence).not.toMatch(/undoing an accidental deletion is wrong/)
    expect(remedy.fixHint).toMatch(new RegExp(`SNOWFLAKE_ACCOUNT.*${DECLARED_SNOWFLAKE_ACCOUNT}`))
  })

  it('tells a missing column to be added, not the window to be decided', async () => {
    await run({ columns: columnsResponse(ALL_COLUMNS.slice(1)) })
    const remedy = remedySent()
    expect(remedy.fixHint).toMatch(/add/i)
    expect(remedy.consequence).not.toMatch(/undoing an accidental deletion is wrong/)
  })
})

// Lessons review (#835): a clean run carries the declared remedy, never one
// built from an empty list ("nothing is missing:" with only a re-run as the fix).
describe('a clean settings run uses the declared remedy', () => {
  it('returns the base remedy for no differences', () => {
    expect(settingsRemedyFor([])).toBe(ARCHIVE_SETTINGS_REMEDY)
  })

  it('passes the base remedy on a clean run', async () => {
    await run()
    const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === ARCHIVE_SETTINGS_JOB)
    expect(call?.[4]).toBe(ARCHIVE_SETTINGS_REMEDY)
  })
})
