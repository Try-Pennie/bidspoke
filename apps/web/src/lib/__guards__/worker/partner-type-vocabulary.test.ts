import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { PARTNER_TYPES as WEB_PARTNER_TYPES } from '../../partner-roles'

// #306 / ADR 0001. `partner_type` is ONE vocabulary written in three places: the
// database CHECK, the worker's accepted list on the write path, and the web list
// the partner form renders as options (LESSONS L89, L41). Widening any two of the
// three leaves a value that looks offered and is refused, or accepted and never
// offered, and neither shows up as an error anywhere: the option is just missing,
// or the save just fails.
//
// The migration is treated as the source of truth because it is the only one that
// can actually reject a write. The worker list is read as TEXT rather than
// imported: apps/worker targets the Workers runtime, so its own suite cannot read
// the filesystem, which is why this guard lives here.

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')
const WORKER_ROLES = path.join(REPO_ROOT, 'apps/worker/src/lib/partner-roles.ts')

function databaseVocabulary(): string[] {
  // Migration filenames sort by timestamp, which is the order Postgres applies
  // them in, so the LAST file that constrains the column states the live rule.
  // Reading an earlier one reports the pre-widening list and passes while the
  // constraint still rejects the new value.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  let latest: string | null = null
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    const matches = [...sql.matchAll(/partner_type\s+IN\s*\(([^)]*)\)/gi)]
    if (matches.length > 0) latest = matches[matches.length - 1][1]
  }
  if (latest === null) {
    throw new Error(
      'No migration constrains partner_configs.partner_type with a CHECK ... IN (...) list, so the ' +
        'database vocabulary cannot be read. Either the constraint was dropped or the statement ' +
        'shape changed, and this guard needs updating rather than deleting.',
    )
  }
  return [...latest.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function workerVocabulary(): string[] {
  const src = readFileSync(WORKER_ROLES, 'utf8')
  const match = src.match(/export const PARTNER_TYPES\s*=\s*\[([^\]]*)\]/)
  if (!match) {
    throw new Error(
      `${WORKER_ROLES} no longer declares 'export const PARTNER_TYPES = [...]', so the worker's ` +
        'accepted list cannot be read. A renamed or restructured export needs this guard updated, ' +
        'not removed: without it the worker can drift from the CHECK silently.',
    )
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('partner_type vocabulary agreement (#306)', () => {
  it('the database CHECK allows both', () => {
    // Asserted on its own: the agreement checks below are satisfied by any two
    // matching lists, including two that both still lack `both`, which is the
    // state this issue exists to change.
    expect(databaseVocabulary()).toContain('both')
  })

  it('the worker accepts exactly what the database CHECK allows', () => {
    expect(workerVocabulary().sort()).toEqual(databaseVocabulary().sort())
  })

  it('the partner form offers exactly what the database CHECK allows', () => {
    expect([...WEB_PARTNER_TYPES].sort()).toEqual(databaseVocabulary().sort())
  })
})
