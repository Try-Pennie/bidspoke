/**
 * The held write statuses the code knows are the ones the table accepts (#471).
 *
 * HELD_WRITE_STATUSES in lib/writeback-replay.ts filters the list route and is
 * what every action writes. The table's CHECK is what Postgres enforces. A status
 * in one and not the other is either refused by the filter or refused by the
 * database, and neither says why, so the two are compared here. Every migration
 * that sets the CHECK is read, and the latest one wins.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

function tableStatuses(): string[] {
  let latest: string[] | null = null
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const m = /outcome_writeback_deadletters_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'))
    if (m) latest = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  if (latest === null) throw new Error('no migration sets outcome_writeback_deadletters_status_check')
  return latest
}

function codeStatuses(): string[] {
  const src = readFileSync(path.join(WORKER_SRC, 'lib/writeback-replay.ts'), 'utf8')
  const m = /export const HELD_WRITE_STATUSES = \[([^\]]*)\]/.exec(src)
  if (!m) throw new Error('HELD_WRITE_STATUSES is not declared where this guard reads it')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('held write statuses', () => {
  it('match the table\'s CHECK exactly', () => {
    expect([...codeStatuses()].sort()).toEqual([...tableStatuses()].sort())
  })

  it('read a real list from each side', () => {
    expect(codeStatuses()).toContain('pending')
    expect(tableStatuses()).toContain('pending')
  })
})
