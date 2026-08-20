import { describe, it, expect } from 'vitest'
import { buildInsert } from '../execution-archive-send'
import type { ArchiveRow } from '../execution-archive'

const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  executionId: '0192f5a0-0000-7000-8000-000000000001',
  archiveDay: '2026-08-16',
  wire: 'H4sIAAAA',
  incomplete: false,
  stepCount: 12,
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

    for (const column of [
      'execution_id',
      'archive_day',
      'archived_incomplete',
      'step_count',
      'bundle_gz_b64',
      'bundle_bytes',
      'archived_at_utc',
    ]) {
      expect(sql, `missing ${column}`).toContain(column)
    }
  })

  it('records the size actually sent, taken from the wire string itself', () => {
    const wire = 'H4sIAAAAAAAA'
    const sql = buildInsert([row({ wire })], AT)

    expect(sql).toContain(`,${wire.length},`)
  })
})
