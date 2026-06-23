/**
 * #322: the generated Supabase types (apps/worker/src/types/database.ts) must NOT
 * include dated partition child tables (execution_steps_2026_06_14,
 * achieve_evaluations_2026_07, ...). Production auto-creates these monthly/daily,
 * so including them makes the nightly DB Types Drift check fail with no real schema
 * change — pure noise. gen-db-types.sh strips them; this guards they stay out.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')
const DB_TYPES = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

// A partition child appears as a table key at the 6-space Tables indent, e.g.
// `      execution_steps_2026_06_14: {` or `      achieve_evaluations_2026_07: {`.
const PARTITION_RE = /^ {6}[a-z_]+_\d{4}_\d{2}(?:_\d{2})?: \{$/

describe('generated DB types exclude dated partition children (#322)', () => {
  it('has no partition child tables', () => {
    const lines = readFileSync(DB_TYPES, 'utf8').split('\n')
    const offenders = lines.filter((l) => PARTITION_RE.test(l)).map((l) => l.trim())
    expect(offenders).toEqual([])
  })
})
