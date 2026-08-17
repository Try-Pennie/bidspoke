import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const EXPECTED_COLUMNS = ['id', 'workflow_id', 'field_path', 'reason', 'created_at', 'created_by'] as const
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/20260629000002_field_presence_silences.sql')
const DATABASE_TYPES = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

function sliceBlock(src: string, header: string): string {
  const start = src.indexOf(header)
  if (start === -1) return ''
  const after = src.slice(start + header.length)
  const end = after.search(/\n {6}[a-z_]+: \{/)
  return end === -1 ? after : after.slice(0, end)
}

describe('field_presence_silences migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '')
  it('creates the table with the expected columns', () => {
    for (const col of EXPECTED_COLUMNS) expect(sql).toMatch(new RegExp(`\\b${col}\\b`))
  })
  it('has the org RLS policy and unique constraint', () => {
    expect(sql).toContain('field_presence_silences_org')
    expect(sql).toContain('UNIQUE (workflow_id, field_path)')
  })
})

describe('field_presence_silences database.ts types', () => {
  const types = readFileSync(DATABASE_TYPES, 'utf8')
  const block = sliceBlock(types, 'field_presence_silences: {')
  it('has a field_presence_silences table block', () => {
    expect(block.length).toBeGreaterThan(0)
  })
  it('Row declares the expected columns', () => {
    for (const col of EXPECTED_COLUMNS) expect(block).toMatch(new RegExp(`\\b${col}\\b`))
  })
})
