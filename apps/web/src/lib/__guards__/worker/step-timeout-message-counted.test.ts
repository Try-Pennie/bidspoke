import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { STEP_DEADLINE, stepTimeoutMessage } from '../../../../../worker/src/engine/step-timeout'

// #2934, #3047. The daily step timeout alert lists a step when its runs failed
// on the step timeout, which step_timeout_audit_by_workflow counts. Since #3047
// it counts a final failure the engine MARKED as stopped by its own deadline
// (`timeout_kind`, written from the StepTimeoutError withTimeout rejects with,
// apps/worker/src/engine/step-timeout.ts), and, for a row written before the
// marker, one whose message starts "Step timed out after". If the value the
// engine writes and the value the function counts drifted apart, or the
// fallback's prefix stopped matching the engine's message, the function would
// count nothing, and a count of zero reads exactly like a step that never timed
// out (L90). So this holds both against the engine's own exports, read from the
// migration that defines the function LAST.
//
// The SQL is read as text because apps/worker targets the Workers runtime and
// its own suite cannot read the filesystem, which is why this guard lives here.

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')
const RETRY = path.join(REPO_ROOT, 'apps/worker/src/engine/retry.ts')

function latestFunctionSql(): { file: string; sql: string } {
  let latest: { file: string; sql: string } | null = null
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    if (/CREATE (OR REPLACE )?FUNCTION public\.step_timeout_audit_by_workflow\(/.test(sql)) latest = { file, sql }
  }
  if (latest === null) throw new Error('No migration defines public.step_timeout_audit_by_workflow')
  return latest
}

describe('the timed out runs the alert counts are the ones the engine fails that way (#2934, #3047)', () => {
  const { file, sql } = latestFunctionSql()
  const marked = /es\.timeout_kind = '([^']+)'/.exec(sql)?.[1]
  const fallback = /es\.error_message LIKE '([^%']+)%'/.exec(sql)?.[1]

  it('the engine marks a step its own deadline stopped from the error withTimeout rejects with', () => {
    expect(readFileSync(RETRY, 'utf8'), 'withTimeout no longer rejects with a StepTimeoutError').toMatch(/reject\(new StepTimeoutError\(ms\)\)/)
  })

  it('counts the marker value the engine writes for its own deadline', () => {
    expect(marked, `${file} does not count by es.timeout_kind`).toBe(STEP_DEADLINE)
  })

  it('reads an unmarked row by the start of the message the engine throws, while that fallback stands', () => {
    if (fallback === undefined) return
    expect(sql, `${file} reads the message of rows the engine marked too`).toMatch(/es\.timeout_kind IS NULL AND es\.error_message LIKE/)
    expect(stepTimeoutMessage(4_500).startsWith(fallback)).toBe(true)
  })
})
