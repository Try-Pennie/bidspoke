import { describe, it, expect } from 'vitest'
import {
  ARCHIVED_EXECUTION_COLUMNS,
  ARCHIVED_STEP_COLUMNS,
} from '../archived-columns'

// #1222: the archive reads both tables with `.select('*')`, resolved per query
// against the live schema, so a column added to either table starts being
// copied into a 13 month store on the next hourly run with no review.
//
// The wildcard STAYS: an explicit column list would silently OMIT a new column
// from the backup, and for a backup that is the worse of the two failures
// (L657). What ships instead is a declared manifest of what the archive holds,
// held to the schema by this guard, so adding a column goes red until somebody
// answers whether it belongs in 13 month storage.
//
// The schema is read from the generated types, which CI already gates as
// regenerated alongside any migration ("DB types regenerated with schema
// migrations"), so this cannot drift from the real table without that gate
// firing first.

// One parse for the whole suite rather than one per test. Read through Vite's
// raw import rather than node:fs, because the worker tsconfig targets the
// Workers runtime and carries no Node types.
// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is
// no ambient declaration for it in this package.
import DATABASE_TYPES from '../../types/database.ts?raw'

function schemaColumns(table: string): string[] {
  const m = new RegExp(
    `\\n      ${table}: \\{\\n        Row: \\{\\n(.*?)\\n        \\}\\n`,
    's'
  ).exec(DATABASE_TYPES)
  if (m === null) {
    throw new Error(
      `could not find a Row block for "${table}" in the generated types. ` +
        'The generator output shape changed, so this guard is no longer reading ' +
        'the schema and must be fixed rather than deleted.'
    )
  }
  return [...m[1].matchAll(/^\s+([a-z_0-9]+)\??:/gm)].map((x) => x[1]).sort()
}

// Proves the reader above actually reads something, so a manifest that matches
// an EMPTY schema list cannot pass every assertion at once (L215).
describe('the schema reader this guard depends on', () => {
  it('finds a non-trivial column list for both archived tables', () => {
    expect(schemaColumns('execution_steps').length).toBeGreaterThan(10)
    expect(schemaColumns('workflow_executions').length).toBeGreaterThan(10)
  })

  it('throws rather than returning empty when the table is not in the types', () => {
    expect(() => schemaColumns('no_such_table_anywhere')).toThrow(/could not find a Row block/)
  })
})

describe('the archive manifest matches the schema', () => {
  it('declares exactly the columns execution_steps has', () => {
    expect(ARCHIVED_STEP_COLUMNS.map((c) => c.name).sort()).toEqual(
      schemaColumns('execution_steps')
    )
  })

  it('declares exactly the columns workflow_executions has', () => {
    expect(ARCHIVED_EXECUTION_COLUMNS.map((c) => c.name).sort()).toEqual(
      schemaColumns('workflow_executions')
    )
  })
})

describe('the manifest records which archived columns carry personal data', () => {
  it('names logs, input, output and trigger_payload as PII bearing', () => {
    // These four are the free-text and payload columns. `logs` is the one this
    // milestone found an applicant SSN sitting in (#1214).
    const pii = [...ARCHIVED_STEP_COLUMNS, ...ARCHIVED_EXECUTION_COLUMNS]
      .filter((c) => c.carriesPersonalData)
      .map((c) => c.name)
    expect(pii).toContain('logs')
    expect(pii).toContain('input')
    expect(pii).toContain('output')
    expect(pii).toContain('trigger_payload')
  })

  it('gives every declared column an explicit personal-data verdict', () => {
    for (const c of [...ARCHIVED_STEP_COLUMNS, ...ARCHIVED_EXECUTION_COLUMNS]) {
      expect(typeof c.carriesPersonalData).toBe('boolean')
    }
  })
})
