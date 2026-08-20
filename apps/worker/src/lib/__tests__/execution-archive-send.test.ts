import { describe, it, expect } from 'vitest'
import { buildInsert, insertColumns } from '../execution-archive-send'
import type { ArchiveRow } from '../execution-archive'
import type { ArchiveScalars } from '../../archive/scalars'

const scalars = (over: Partial<ArchiveScalars> = {}): ArchiveScalars => ({
  organizationId: 'org-1',
  workflowId: 'wf-1',
  workflowVersionId: 'wv-1',
  parentExecutionId: null,
  resumedFromExecutionId: null,
  traceId: 'trace-1',
  source: 'website',
  status: 'success',
  outcome: 'bid_won',
  isTest: false,
  startedAtUtc: '2026-08-16T11:00:00.000',
  completedAtUtc: '2026-08-16T11:00:09.000',
  durationMs: 9000,
  costUsd: 0.0031,
  ...over,
})

const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  executionId: '0192f5a0-0000-7000-8000-000000000001',
  archiveDay: '2026-08-16',
  wire: 'H4sIAAAA',
  incomplete: false,
  stepCount: 12,
  scalars: scalars(),
  ...over,
})

const AT = '2026-08-18T11:00:00.000'

describe('buildInsert', () => {
  it('writes one VALUES tuple per row', () => {
    const sql = buildInsert([row({ executionId: 'a' }), row({ executionId: 'b' })], AT)

    expect(sql.match(/\('/g)?.length).toBe(2)
    expect(sql).toContain("'a'")
    expect(sql).toContain("'b'")
  })

  it('is an INSERT, not a MERGE', () => {
    const sql = buildInsert([row()], AT)

    expect(sql.startsWith('INSERT INTO')).toBe(true)
    expect(sql).not.toContain('MERGE')
  })

  it('carries the step count the gate sums, rather than omitting it', () => {
    const sql = buildInsert([row({ stepCount: 31 })], AT)

    expect(sql).toContain('step_count')
    expect(sql).toContain(',31,')
  })

  it('marks a row archived at the deadline as incomplete', () => {
    expect(buildInsert([row({ incomplete: true })], AT)).toContain('TRUE')
    expect(buildInsert([row({ incomplete: false })], AT)).toContain('FALSE')
  })

  // An empty batch would produce a statement that inserts nothing and returns
  // success, which downstream reads as a send that happened (L98).
  it('refuses an empty batch rather than sending a statement that inserts nothing', () => {
    expect(() => buildInsert([], AT)).toThrow(/empty batch/)
  })

  // The wire form is base64 and carries no quote today. That is exactly the
  // assumption worth not depending on, since a single unescaped quote in a
  // values list ends the literal and changes what the rest of the statement means.
  it('escapes a quote in any value rather than trusting the encoding', () => {
    const sql = buildInsert([row({ executionId: "it's" })], AT)

    expect(sql).toContain("it''s")
  })

  it('escapes a backslash, which Snowflake treats as an escape character in a literal', () => {
    const sql = buildInsert([row({ wire: 'a\\' })], AT)

    expect(sql).toContain('a\\\\')
  })

  it('names the columns it writes, so a schema change breaks loudly rather than shifting values', () => {
    const sql = buildInsert([row()], AT)

    for (const column of insertColumns) {
      expect(sql, `missing ${column}`).toContain(column)
    }
  })

  // The column list and the values come from one map, so this asserts the thing
  // that map exists to guarantee: as many values as columns, per row. A shifted
  // tuple writes every field into its neighbour's column, and where the two
  // share a type the database accepts it silently. Counting by commas is only
  // valid because no value in this fixture contains one.
  it('supplies exactly one value per column, for every row', () => {
    const sql = buildInsert([row({ executionId: 'a' }), row({ executionId: 'b' })], AT)

    const tuples = sql.slice(sql.indexOf('VALUES ')).split('),(')
    expect(tuples.length).toBe(2)
    for (const tuple of tuples) {
      expect(tuple.split(',').length).toBe(insertColumns.length)
    }
  })

  it('carries the scalars the later phases read without decompressing a bundle', () => {
    const sql = buildInsert([row({ scalars: scalars({ traceId: 'trace-xyz', source: 'engine' }) })], AT)

    expect(sql).toContain("'org-1'")
    expect(sql).toContain("'wf-1'")
    expect(sql).toContain("'trace-xyz'")
    expect(sql).toContain("'engine'")
    expect(sql).toContain("'2026-08-16T11:00:00.000'::TIMESTAMP_NTZ")
    expect(sql).toContain('0.0031')
  })

  // NULL is the value, not the four letters. Quoting it stores a row whose
  // trace id is the string 'NULL', which reads as a real value everywhere
  // downstream and cannot be told apart from one.
  it('writes an absent value as NULL rather than as the word', () => {
    const sql = buildInsert([row({ scalars: scalars({ traceId: null, completedAtUtc: null, costUsd: null }) })], AT)

    expect(sql).toContain(',NULL,')
    expect(sql).not.toContain("'NULL'")
  })

  // A row that reached here with a broken number would otherwise interpolate
  // the bare word NaN, which Snowflake reads as an identifier and reports as an
  // error about a column, sending whoever reads it after the wrong thing.
  it('refuses a number that is not finite rather than writing a bare word', () => {
    expect(() => buildInsert([row({ scalars: scalars({ costUsd: Number.NaN }) })], AT)).toThrow(/NaN/)
  })

  it('escapes a quote in a scalar, which is free text a person wrote', () => {
    const sql = buildInsert([row({ scalars: scalars({ source: "o'brien" }) })], AT)

    expect(sql).toContain("o''brien")
  })

  it('records the size actually sent, taken from the wire string itself', () => {
    const wire = 'H4sIAAAAAAAA'
    const sql = buildInsert([row({ wire })], AT)

    expect(sql).toContain(`,${wire.length},`)
  })
})
