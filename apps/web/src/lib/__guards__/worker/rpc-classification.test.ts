import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every rpc the Worker calls is classified as read only or mutating, in one
 * file the local dev write guard reads (#1409, L96, L41).
 *
 * The guard in apps/worker/src/lib/supabase.ts refuses any rpc that is on
 * neither list when local dev is pointed at production. That is only safe if
 * the lists are complete: an rpc added to the code and forgotten here would be
 * refused in local dev on its first call, which is loud, but a WRITE added to
 * the READ ONLY list would be let through, which is silent. So this guard reads
 * every `.rpc('name'` call in the worker and requires each name to be on exactly
 * one list, and requires every read only name to be created by a migration.
 *
 * The SQL suite (supabase/tests/buyer_profiles.test.sql) checks the other half
 * against a real database: that the read only names are STABLE or IMMUTABLE.
 */
const LIST = path.join(WORKER_SRC, 'lib/read-only-rpcs.json')
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

interface RpcLists {
  readOnly: string[]
  mutating: string[]
}

function lists(): RpcLists {
  return JSON.parse(readFileSync(LIST, 'utf8')) as RpcLists
}

function rpcCallSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>()
  for (const file of listTsFiles(WORKER_SRC)) {
    if (file.includes('__tests__') || file.endsWith('.test.ts')) continue
    // Comments blanked, strings kept: the rpc name IS a string literal.
    const src = sanitizeSource(readFileSync(file, 'utf8'), { blankStrings: false })
    for (const m of src.matchAll(/\.rpc\(\s*'([a-z_][a-z0-9_]*)'/g)) {
      const rel = path.relative(REPO_ROOT, file)
      sites.set(m[1], [...(sites.get(m[1]) ?? []), rel])
    }
  }
  return sites
}

describe('every worker rpc is classified once in read-only-rpcs.json', () => {
  it('finds call sites, so this cannot pass vacuously (L98)', () => {
    expect(rpcCallSites().size).toBeGreaterThanOrEqual(10)
  })

  it('names are on exactly one list', () => {
    const { readOnly, mutating } = lists()
    const both = readOnly.filter((n) => mutating.includes(n))
    expect(both, 'on both lists').toEqual([])
    expect(new Set(readOnly).size).toBe(readOnly.length)
    expect(new Set(mutating).size).toBe(mutating.length)
  })

  it('every call site is classified', () => {
    const { readOnly, mutating } = lists()
    const known = new Set([...readOnly, ...mutating])
    const unclassified = [...rpcCallSites()].filter(([name]) => !known.has(name)).map(([name, files]) => `${name} (${files.join(', ')})`)
    expect(unclassified, 'add each to read-only-rpcs.json as read only or mutating').toEqual([])
  })

  it('the mutating list names the writers the plan and the manifest call writes', () => {
    const { mutating } = lists()
    for (const w of ['record_archive_day_measurement', 'save_buyer_profile', 'record_buyer_sale', 'settle_buyer_sale', 'delete_partner_config', 'rename_partner_step_namespace']) {
      expect(mutating, w).toContain(w)
    }
  })

  it('every listed name is created by a migration, so the list cannot carry a function the database does not have', () => {
    const { readOnly, mutating } = lists()
    const migrationText = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      .join('\n')
    const missing = [...readOnly, ...mutating].filter(
      (name) => !new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\s*\\(`, 'i').test(migrationText)
    )
    expect(missing).toEqual([])
  })
})
