/**
 * The ops rpc classification is complete and names only real functions (#1948).
 *
 * ops-rpcs.ts is read by the local dev write guard and by callOpsRpc. A function
 * missing from it is refused on its first call, which is loud; a function listed
 * that no migration creates is a call that can only fail in production; and a
 * write on the read only list would pass the local dev guard silently. So every
 * function the ops migrations create in public must be on exactly one list, and
 * every listed name must be one of them. Whether a read only one is really
 * STABLE is checked against a real database, in run_engine_schema.test.sql.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'
import {
  OPS_LANE_READ_ONLY_RPCS, OPS_LANE_RPCS, OPS_MUTATING_RPCS, OPS_ORGANIZATION_READ_ONLY_RPCS, OPS_ORGANIZATION_RPCS, OPS_READ_ONLY_RPCS,
} from '../../../../../worker/src/ops/ops-rpcs'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase-ops/supabase/migrations')

/** The functions a migration text creates in public, by name. */
export function createdFunctions(sql: string): string[] {
  return [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1])
}

const created = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .flatMap((f) => createdFunctions(readFileSync(path.join(MIGRATIONS, f), 'utf8')))

describe('ops rpc classification', () => {
  it('finds the run engine functions, so the comparison below is not vacuous (L98)', () => {
    expect(created.length).toBeGreaterThanOrEqual(14)
  })

  it('lists every function the ops migrations create, on exactly one list', () => {
    const listed = [...OPS_MUTATING_RPCS, ...OPS_READ_ONLY_RPCS]
    expect(new Set(listed).size).toBe(listed.length)
    expect([...new Set(created)].sort()).toEqual([...listed].sort())
  })

  it('splits each list into organization scoped and lane wide calls, with no name in both', () => {
    const organization: readonly string[] = [...OPS_ORGANIZATION_RPCS, ...OPS_ORGANIZATION_READ_ONLY_RPCS]
    const lane: readonly string[] = [...OPS_LANE_RPCS, ...OPS_LANE_READ_ONLY_RPCS]
    expect(organization.filter((n) => lane.includes(n))).toEqual([])
    expect([...organization, ...lane].sort()).toEqual([...OPS_MUTATING_RPCS, ...OPS_READ_ONLY_RPCS].sort())
  })

  it('an organization scoped function takes p_organization_id, and a lane wide one does not', () => {
    const sql = readdirSync(MIGRATIONS).map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n')
    const signature = (name: string) => {
      const m = new RegExp(`CREATE\\s+FUNCTION\\s+public\\.${name}\\s*\\(([^)]*)\\)`, 'i').exec(sql)
      if (!m) throw new Error(`no signature for ${name}`)
      return m[1]
    }
    for (const name of [...OPS_ORGANIZATION_RPCS, ...OPS_ORGANIZATION_READ_ONLY_RPCS]) expect(signature(name), name).toMatch(/^\s*p_organization_id\s+uuid/)
    for (const name of [...OPS_LANE_RPCS, ...OPS_LANE_READ_ONLY_RPCS]) expect(signature(name), name).not.toMatch(/p_organization_id/)
  })

  it('every classified function has exactly one typed wrapper in ops-writes.ts, so none is reachable only by a raw name', () => {
    const writes = readFileSync(path.join(WORKER_SRC, 'ops/ops-writes.ts'), 'utf8')
    const wrapped = [...writes.matchAll(/const name = '([a-z_][a-z0-9_]*)'/g)].map((m) => m[1])
    expect(wrapped.length).toBeGreaterThanOrEqual(14)
    expect([...wrapped].sort()).toEqual([...OPS_MUTATING_RPCS, ...OPS_READ_ONLY_RPCS].sort())
  })

  it('sees a function the list omits (seen red)', () => {
    const planted = 'CREATE FUNCTION public.unlisted_write(p uuid) RETURNS void LANGUAGE sql AS $$ $$;'
    expect(createdFunctions(planted)).toEqual(['unlisted_write'])
    expect([...OPS_MUTATING_RPCS, ...OPS_READ_ONLY_RPCS]).not.toContain('unlisted_write')
  })
})
