/**
 * Supabase against Snowflake schema drift for the exported tables (#428).
 *
 * The 2026-06-27 export incident was a Snowflake column marked NOT NULL while
 * the Supabase column it is filled from is nullable. Nothing compared the two,
 * so it surfaced only as the nightly export failing. These tests drive the real
 * check against a Snowflake double answering in the REST API's shape, including
 * `resultSetMetaData.rowType`, so the by-name cell reading is exercised.
 *
 * Every outcome the check can report has a case here, including the one that
 * matters most for a detector: Snowflake could not be asked. That must say the
 * schema was not checked, never read as "no drift" (L98).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  checkExportSchema,
  EXPORTED_TABLES,
  EXPORT_SCHEMA_JOB,
  EXPORT_SCHEMA_REMEDY,
  EXPORT_SCHEMA_UNREADABLE_REMEDY,
  exportSchemaEnding,
  type ExportedTable,
} from '../export-schema-check'
import { SIGHTING_COLS, BID_COLS, type ColType } from '../sightings-export'
import { ACHIEVE_COLS } from '../achieve-export'
import { notifyExportFailure } from '../export-alerts'
import type { SnowflakeStatementResponse } from '../snowflake'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'
// @ts-expect-error Vite resolves ?raw to the file's text; no ambient declaration here.
import DATABASE_TYPES from '../../types/database.ts?raw'

const env = { SNOWFLAKE_SCHEMA: 'public' } as unknown as Env
// startJobRun and finishJobRun never throw, so an empty double only costs a log line.
const supabase = {} as unknown as SupabaseClient

/** How INFORMATION_SCHEMA.COLUMNS reports each export type. VARCHAR comes back as TEXT. */
const SNOWFLAKE_DATA_TYPE: Record<ColType, string> = {
  varchar: 'TEXT',
  number: 'NUMBER',
  boolean: 'BOOLEAN',
  timestamp_tz: 'TIMESTAMP_TZ',
  timestamp_ntz: 'TIMESTAMP_NTZ',
  variant: 'VARIANT',
}

interface Col {
  table: string
  name: string
  dataType: string
  nullable: boolean
  default: string | null
}

/** A Snowflake table that agrees with the export: every column present, the right type, nullable unless never null. */
function healthy(t: ExportedTable): Col[] {
  return [
    ...t.cols.map((c) => ({
      table: t.table.toUpperCase(),
      name: c.name.toUpperCase(),
      dataType: SNOWFLAKE_DATA_TYPE[c.type],
      nullable: !t.neverNull.includes(c.name),
      default: null,
    })),
    // The stamp column every exported table carries and the export never sends.
    { table: t.table.toUpperCase(), name: 'EXPORTED_AT', dataType: 'TIMESTAMP_NTZ', nullable: true, default: null },
  ]
}

const allHealthy = (): Col[] => EXPORTED_TABLES.flatMap(healthy)

/** The rows in the column order a real SELECT would return them, named in rowType. */
function answer(cols: Col[]): SnowflakeStatementResponse {
  return {
    resultSetMetaData: {
      rowType: [
        { name: 'TABLE_NAME', type: 'text' },
        { name: 'COLUMN_NAME', type: 'text' },
        { name: 'DATA_TYPE', type: 'text' },
        { name: 'IS_NULLABLE', type: 'text' },
        { name: 'COLUMN_DEFAULT', type: 'text' },
      ],
    },
    data: cols.map((c) => [c.table, c.name, c.dataType, c.nullable ? 'YES' : 'NO', c.default]),
  }
}

let issued: string[] = []

function run(reply: SnowflakeStatementResponse | Error | (() => Promise<SnowflakeStatementResponse>), deps = {}) {
  return checkExportSchema(env, supabase, {
    query: async (statement: string) => {
      issued.push(statement)
      if (reply instanceof Error) throw reply
      if (typeof reply === 'function') return reply()
      return reply
    },
    ...deps,
  })
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === EXPORT_SCHEMA_JOB)
    .flatMap((c) => c[2] as string[])
}

function edit(cols: Col[], table: string, name: string, change: Partial<Col>): Col[] {
  let found = false
  const out = cols.map((c) => {
    if (c.table === table.toUpperCase() && c.name === name.toUpperCase()) {
      found = true
      return { ...c, ...change }
    }
    return c
  })
  // A fixture edit that matched nothing would leave the healthy table in place
  // and pass the "no finding" cases for the wrong reason (L100).
  expect(found, `${table}.${name} is in the fixture`).toBe(true)
  return out
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
  issued = []
})

describe('the tables it covers', () => {
  it('covers every export, with the columns each one actually sends', () => {
    const byTable = Object.fromEntries(EXPORTED_TABLES.map((t) => [t.table, t.cols]))
    expect(byTable).toEqual({
      lead_sightings: SIGHTING_COLS,
      lead_sighting_bids: BID_COLS,
      achieve_evaluations: ACHIEVE_COLS,
    })
  })
})

describe('what the export sends, against the Supabase source (read from the generated types)', () => {
  // database.ts is regenerated from production and compared daily by the DB
  // Types Drift workflow, so it is the live Supabase schema as of that check.
  function rowColumns(table: string): Map<string, boolean> {
    const start = DATABASE_TYPES.indexOf(`\n      ${table}: {\n        Row: {\n`)
    expect(start, `${table} is in database.ts`).toBeGreaterThan(-1)
    const body = DATABASE_TYPES.slice(start).split('\n        Row: {\n')[1].split('\n        }\n')[0]
    const cols = new Map<string, boolean>()
    for (const line of body.split('\n')) {
      const m = /^\s+(\w+): (.+)$/.exec(line)
      if (m) cols.set(m[1], /\| null$/.test(m[2].trim()))
    }
    expect(cols.size, `${table}'s Row was parsed`).toBeGreaterThan(5)
    return cols
  }

  for (const t of EXPORTED_TABLES) {
    it(`${t.table}: every exported column exists in Supabase`, () => {
      const source = rowColumns(t.table)
      const absent = t.cols.map((c) => c.name).filter((n) => !source.has(n))
      expect(absent).toEqual([])
    })

    it(`${t.table}: the never null list is exactly the exported columns Supabase declares NOT NULL`, () => {
      const source = rowColumns(t.table)
      const notNull = t.cols.map((c) => c.name).filter((n) => source.get(n) === false)
      expect([...t.neverNull].sort()).toEqual(notNull.sort())
    })
  }
})

describe('a Snowflake schema that agrees with the export', () => {
  it('reports nothing and clears any standing alert', async () => {
    const result = await run(answer(allHealthy()))
    expect(result.findings).toEqual([])
    expect(result.unreadable).toEqual([])
    expect(result.alerted).toBe(false)
    // Called with no messages, which is how the alerter clears a standing condition.
    expect(vi.mocked(notifyExportFailure).mock.calls.filter((c) => c[1] === EXPORT_SCHEMA_JOB)).toHaveLength(1)
    expect(alerted()).toEqual([])
  })

  it('asks only about the export schema and the exported tables', async () => {
    await run(answer(allHealthy()))
    expect(issued).toHaveLength(1)
    const sql = issued[0].toUpperCase()
    expect(sql).toContain('INFORMATION_SCHEMA.COLUMNS')
    // Scoped by schema as well as name: a same named table elsewhere in the
    // database would otherwise answer for the one the export writes.
    expect(sql).toContain("TABLE_SCHEMA = 'PUBLIC'")
    for (const t of EXPORTED_TABLES) expect(sql).toContain(`'${t.table.toUpperCase()}'`)
  })
})

describe('drift it reports', () => {
  it('a nullable source column marked NOT NULL in Snowflake, the 2026-06-27 incident', async () => {
    const cols = edit(allHealthy(), 'lead_sightings', 'execution_finished_at_et', { nullable: false })
    const result = await run(answer(cols))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain('lead_sightings.execution_finished_at_et')
    expect(result.findings[0]).toContain('NOT NULL')
    expect(result.alerted).toBe(true)
    expect(alerted()).toEqual(result.findings)
  })

  it('does not report NOT NULL on a column the source never leaves empty', async () => {
    // trace_id is NOT NULL in Supabase, and the live table declares it NOT NULL too.
    const result = await run(answer(allHealthy()))
    expect(EXPORTED_TABLES[0].neverNull).toContain('trace_id')
    expect(result.findings).toEqual([])
  })

  it('a column the export sends that the Snowflake table lacks', async () => {
    const cols = allHealthy().filter((c) => !(c.table === 'LEAD_SIGHTING_BIDS' && c.name === 'SKIP_REASON'))
    const result = await run(answer(cols))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain('lead_sighting_bids.skip_reason')
    expect(result.findings[0]).toMatch(/does not have/)
  })

  it('does not report a missing column on a table whose export adds it before writing', async () => {
    const achieve = EXPORTED_TABLES.find((t) => t.table === 'achieve_evaluations')
    expect(achieve?.addsMissingColumns).toBe(true)
    const cols = allHealthy().filter((c) => !(c.table === 'ACHIEVE_EVALUATIONS' && c.name === 'CF_RAY'))
    const result = await run(answer(cols))
    expect(result.findings).toEqual([])
  })

  it('a column Snowflake stores as a different type than the export sends', async () => {
    const cols = edit(allHealthy(), 'lead_sightings', 'execution_started_at_et', { dataType: 'TIMESTAMP_NTZ' })
    const result = await run(answer(cols))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain('lead_sightings.execution_started_at_et')
    expect(result.findings[0]).toContain('TIMESTAMP_TZ')
    expect(result.findings[0]).toContain('TIMESTAMP_NTZ')
  })

  it('accepts a whole number column stored as FLOAT', async () => {
    const cols = edit(allHealthy(), 'lead_sightings', 'annual_income', { dataType: 'FLOAT' })
    const result = await run(answer(cols))
    expect(result.findings).toEqual([])
  })

  it('a Snowflake only column that is NOT NULL with no default, which every new row fails on', async () => {
    const cols = [
      ...allHealthy(),
      { table: 'LEAD_SIGHTINGS', name: 'ADDED_BY_HAND', dataType: 'TEXT', nullable: false, default: null },
    ]
    const result = await run(answer(cols))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain('lead_sightings.added_by_hand')
  })

  it('ignores a Snowflake only column that is nullable or has a default', async () => {
    const cols = [
      ...allHealthy(),
      { table: 'LEAD_SIGHTINGS', name: 'NOTE', dataType: 'TEXT', nullable: true, default: null },
      { table: 'LEAD_SIGHTINGS', name: 'LOADED_AT', dataType: 'TIMESTAMP_NTZ', nullable: false, default: 'CURRENT_TIMESTAMP()' },
    ]
    const result = await run(answer(cols))
    expect(result.findings).toEqual([])
  })

  it('an exported table Snowflake returned no columns for is reported as not checked, not as clean', async () => {
    const cols = allHealthy().filter((c) => c.table !== 'LEAD_SIGHTING_BIDS')
    const result = await run(answer(cols))
    expect(result.findings).toEqual([])
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]).toContain('lead_sighting_bids')
    expect(result.unreadable[0]).toMatch(/could not be checked/)
    expect(alerted()).toEqual(result.unreadable)
  })
})

describe('the alert wording matches what was found', () => {
  function remedyPassed() {
    const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === EXPORT_SCHEMA_JOB)
    return call?.[4]
  }

  it('drift is headlined as a disagreement', async () => {
    await run(answer(edit(allHealthy(), 'lead_sightings', 'execution_finished_at_et', { nullable: false })))
    expect(remedyPassed()).toBe(EXPORT_SCHEMA_REMEDY)
  })

  it('a check that could not read Snowflake does not claim to have found a disagreement', async () => {
    await run(new Error('HTTP 503'))
    expect(remedyPassed()).toBe(EXPORT_SCHEMA_UNREADABLE_REMEDY)
  })
})

describe('when Snowflake cannot be asked, it says so and never reports no drift', () => {
  function expectCouldNotCheck(result: Awaited<ReturnType<typeof run>>) {
    expect(result.unreadable.length).toBeGreaterThan(0)
    expect(result.findings).toEqual([])
    expect(result.alerted).toBe(true)
    const said = alerted()
    expect(said.length).toBeGreaterThan(0)
    expect(said.join(' ')).toMatch(/could not be checked/)
  }

  it('Snowflake refuses or is unreachable', async () => {
    const result = await run(new Error('HTTP 503 upstream connect error'))
    expectCouldNotCheck(result)
    expect(alerted().join(' ')).toContain('HTTP 503')
  })

  it('Snowflake does not answer inside the budget', async () => {
    const result = await run(() => new Promise<SnowflakeStatementResponse>(() => {}), {
      deadlineMs: 5,
      // Resolves at once, so the deadline is reached without a real wait (L524).
      sleep: () => Promise.resolve(),
    })
    expectCouldNotCheck(result)
    expect(alerted().join(' ')).toMatch(/budget/)
  })

  it('the answer comes back in a shape with no column names', async () => {
    const result = await run({ data: [['LEAD_SIGHTINGS', 'ID', 'TEXT', 'NO', null]] })
    expectCouldNotCheck(result)
    // Named as a shape problem, so nobody goes looking for a missing table.
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]).toMatch(/shape/)
  })

  it('no rows at all, for any table', async () => {
    const result = await run(answer([]))
    expectCouldNotCheck(result)
    // One message about the identity, not three about three missing tables.
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]).toMatch(/any exported table/)
  })

  it('no Snowflake schema configured', async () => {
    const result = await checkExportSchema({} as unknown as Env, supabase, {
      query: async () => answer(allHealthy()),
    })
    expectCouldNotCheck(result)
  })
})

describe('the job_runs record', () => {
  const drift = ['lead_sightings.zip: Snowflake declares it NOT NULL but the Supabase column is nullable']
  const unreadable = ['lead_sighting_bids: Snowflake returned no columns for this table']

  it('keeps the drift findings when another table was unreadable in the same run', () => {
    const ending = exportSchemaEnding({ findings: drift, unreadable, alerted: true })
    expect(ending.outcome).toBe('drift_and_unreadable')
    expect(ending.detail).toContain('1 column disagrees')
    expect(ending.detail).toContain(unreadable[0])
  })

  it('records drift alone, unreadable alone, and a clean run as three different outcomes', () => {
    expect(exportSchemaEnding({ findings: drift, unreadable: [], alerted: true }).outcome).toBe('drift')
    expect(exportSchemaEnding({ findings: [], unreadable, alerted: true })).toMatchObject({
      outcome: 'unreadable',
      detail: unreadable[0],
    })
    expect(exportSchemaEnding({ findings: [], unreadable: [], alerted: false })).toMatchObject({
      outcome: 'ok',
      detail: undefined,
    })
  })
})
