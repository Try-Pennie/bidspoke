import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

// #2934. The daily step timeout alert lists a step when its runs failed on the
// step timeout, which step_timeout_audit_by_workflow counts by the error's text:
// final failures whose message starts "Step timed out after". That text is
// written by the engine: withTimeout in apps/worker/src/engine/retry.ts throws
// stepTimeoutMessage(ms), the one spelling the daily direct write report also
// reads back (#2938). If the engine's wording changed, the function would count
// nothing, and a count of zero reads exactly like a step that never timed out
// (L90). So this requires the engine to throw that message, and the prefix the
// database counts to be its start, read from the migration that defines the
// function LAST.
//
// Read as text because apps/worker targets the Workers runtime and its own suite
// cannot read the filesystem, which is why this guard lives here.

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

describe('the timed out runs the alert counts are the ones the engine fails that way (#2934)', () => {
  const { file, sql } = latestFunctionSql()
  const counted = /AND es\.error_message LIKE '([^%']+)%'/.exec(sql)?.[1]
  const retry = readFileSync(RETRY, 'utf8')
  const thrown = /export function stepTimeoutMessage\(ms: number\): string \{\s*return `(Step timed out after )\$\{ms\}ms/.exec(retry)?.[1]

  it('was read from both places', () => {
    expect(counted, `${file} has no LIKE on the error message`).toBeTruthy()
    expect(thrown, 'engine/retry.ts stepTimeoutMessage no longer returns "Step timed out after ${ms}ms"').toBeTruthy()
    expect(retry, 'withTimeout no longer throws stepTimeoutMessage(ms)').toMatch(/reject\(new Error\(stepTimeoutMessage\(ms\)\)\)/)
  })

  it('counts by the start of the message the engine throws', () => {
    expect(thrown!.startsWith(counted!)).toBe(true)
  })
})
