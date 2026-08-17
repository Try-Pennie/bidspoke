import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

// The hand-authored field_presence_daily type block must match the migration
// DDL exactly. The CI "DB types regenerated" job only checks database.ts is in
// the same diff as a migration; the nightly drift check validates against prod
// only AFTER the migration is applied by hand. This guard catches drift at PR
// time instead. (#421)

const EXPECTED_COLUMNS = [
  'workflow_id',
  'field_path',
  'day',
  'is_test',
  'ran_count',
  'present_count',
] as const

const MIGRATION = path.join(
  REPO_ROOT,
  'supabase/migrations/20260629000001_field_presence_daily.sql',
)
const DATABASE_TYPES = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

function sliceBlock(src: string, header: string): string {
  const start = src.indexOf(header)
  if (start === -1) return ''
  // From the header to the next sibling table key at the same indent.
  const after = src.slice(start + header.length)
  const end = after.search(/\n {6}[a-z_]+: \{/)
  return end === -1 ? after : after.slice(0, end)
}

describe('field_presence_daily migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8')
  const sqlNoComments = sql.replace(/--.*$/gm, '')

  it('migration SQL references all expected columns (excluding comments)', () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(sqlNoComments).toMatch(new RegExp(`\\b${col}\\b`))
    }
  })

  it('aggregates present_count as the JSON-true filter', () => {
    expect(sql).toContain("count(*) FILTER (WHERE je.value = 'true'::jsonb)")
  })

  it('schedules both cron refreshes', () => {
    expect(sql).toContain("'refresh-field-presence-daily'")
    expect(sql).toContain("'refresh-field-presence-daily-full'")
  })
})

describe('field_presence_daily database.ts types', () => {
  const types = readFileSync(DATABASE_TYPES, 'utf8')
  const block = sliceBlock(types, 'field_presence_daily: {')

  it('has a field_presence_daily table block', () => {
    expect(block.length).toBeGreaterThan(0)
  })

  it('Row declares all expected columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(block).toMatch(new RegExp(`\\b${col}\\b`))
    }
  })

  it('registers the refresh function type', () => {
    expect(types).toContain('refresh_field_presence_daily: {')
  })
})
