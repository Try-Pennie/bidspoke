/**
 * Reading the archive's Snowflake settings back (#980).
 *
 * Drives the real check against a Snowflake double answering in the shape the
 * REST API actually returns, including `resultSetMetaData.rowType`, so the
 * by-name cell lookup is exercised rather than assumed.
 *
 * The failure this guards against is specific and has already happened once in
 * this milestone: ADR 0009 recorded the undo window as a measured fact, it was
 * wrong for days, and it was caught only because somebody happened to probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import {
  checkArchiveSettings,
  ARCHIVE_SETTINGS_JOB,
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

/** SHOW PARAMETERS, in the column order Snowflake happens to use today. */
function showParameters(value: string, level: string): SnowflakeStatementResponse {
  return {
    resultSetMetaData: {
      rowType: [
        { name: 'key', type: 'text' },
        { name: 'value', type: 'text' },
        { name: 'default', type: 'text' },
        { name: 'level', type: 'text' },
        { name: 'description', type: 'text' },
        { name: 'type', type: 'text' },
      ],
    },
    data: [['DATA_RETENTION_TIME_IN_DAYS', value, '1', level, 'number of days', 'NUMBER']],
  }
}

function columnsResponse(names: string[]): SnowflakeStatementResponse {
  return {
    resultSetMetaData: { rowType: [{ name: 'COLUMN_NAME', type: 'text' }] },
    data: names.map((n) => [n]),
  }
}

const ALL_COLUMNS = [...insertColumns, ...EXPECTED_EXTRA_COLUMNS]

function run(opts: {
  parameters?: SnowflakeStatementResponse | Error
  columns?: SnowflakeStatementResponse | Error
} = {}) {
  const parameters = opts.parameters ?? showParameters(String(ARCHIVE_UNDO_WINDOW_DAYS), 'TABLE')
  const columns = opts.columns ?? columnsResponse(ALL_COLUMNS)
  return checkArchiveSettings(env, supabase, {
    query: async (statement: string) => {
      const answer = statement.startsWith('SHOW PARAMETERS') ? parameters : columns
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
})

describe('settings that match what the repo declares', () => {
  it('reports no difference and raises nothing', async () => {
    const result = await run()

    expect(result.differences).toEqual([])
    expect(result.alerted).toBe(false)
    expect(alerted()).toEqual([])
  })

  it('reads the values by column name, not by position', async () => {
    // The negative control for the whole read. Snowflake's SHOW output is not a
    // stable contract, and an index that shifted would read the wrong cell and
    // report a passing check about the wrong thing.
    const shuffled: SnowflakeStatementResponse = {
      resultSetMetaData: {
        rowType: [
          { name: 'level', type: 'text' },
          { name: 'key', type: 'text' },
          { name: 'value', type: 'text' },
        ],
      },
      data: [['TABLE', 'DATA_RETENTION_TIME_IN_DAYS', String(ARCHIVE_UNDO_WINDOW_DAYS)]],
    }

    const result = await run({ parameters: shuffled })

    expect(result.observed.retentionDays).toBe(ARCHIVE_UNDO_WINDOW_DAYS)
    expect(result.observed.retentionLevel).toBe('TABLE')
    expect(result.differences).toEqual([])
  })
})

describe('a Time Travel window that no longer matches', () => {
  it('is reported, naming both numbers and what it invalidates', async () => {
    const result = await run({ parameters: showParameters('1', 'TABLE') })

    expect(result.differences.map((d) => d.code)).toEqual(['retention-changed'])
    expect(alerted()[0]).toMatch(/is 1 days, and this repo and ADR 0009 declare 30/)
  })
})

describe('a Time Travel window the table no longer owns', () => {
  it('is reported before the value has moved at all', async () => {
    // Inherited, the window changes whenever somebody edits the schema or
    // account default, with nothing naming the archive at the moment of change.
    const result = await run({
      parameters: showParameters(String(ARCHIVE_UNDO_WINDOW_DAYS), 'SCHEMA'),
    })

    expect(result.differences.map((d) => d.code)).toEqual(['retention-inherited'])
  })

  it('treats an empty level as the account default, not as fine', async () => {
    // Snowflake reports the empty string for a parameter left at the account
    // default, so reading it as absent-and-therefore-fine would pass the exact
    // case this looks for.
    const result = await run({ parameters: showParameters(String(ARCHIVE_UNDO_WINDOW_DAYS), '') })

    expect(result.observed.retentionLevel).toBe('ACCOUNT DEFAULT')
    expect(result.differences.map((d) => d.code)).toEqual(['retention-inherited'])
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
    const result = await run({ parameters: new Error('warehouse could not resume') })

    expect(result.differences.map((d) => d.code)).toContain('unreadable')
    expect(alerted().join(' ')).toMatch(/warehouse could not resume/)
  })

  it('still reports what the other read found', async () => {
    // One failing read must not hide the other's finding.
    const result = await run({
      parameters: new Error('warehouse could not resume'),
      columns: columnsResponse(ALL_COLUMNS.filter((c) => c !== 'bundle_gz_b64')),
    })

    expect(result.differences.map((d) => d.code)).toEqual(['unreadable', 'columns-missing'])
  })
})
