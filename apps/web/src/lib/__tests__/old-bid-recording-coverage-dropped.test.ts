/**
 * The first bid recording coverage function stays dropped (#1466).
 *
 * `20260922210000` added bid_recording_coverage_v2 and moved the too few bids
 * monitor onto it, leaving the original in place for one release per ADR 0007 so
 * a rollback to the old reader stayed possible. `20260930120000` is the contract
 * half that removes the original once the v2 history had filled.
 *
 * The drop is spread over four places that each hold the name for a different
 * reader, and a contract step that finishes three of them leaves the fourth
 * asserting something false:
 *
 *   the migration        drops it from the database
 *   read-only-rpcs.json  would otherwise let the local dev write guard pass a
 *                        call to a function that no longer exists
 *   the live manifest    must now expect it ABSENT, so a copy recreated by hand
 *                        in production is reported (a migration scan cannot see
 *                        that, #1145)
 *   the SQL suite        must not list it as a STABLE read only rpc, or the suite
 *                        fails on a database the migrations built correctly
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { readMigrations } from './_pg-cron'

const CONTRACT_MIGRATION = '20260930120000_drop_bid_recording_coverage_v1.sql'

/** Assembled so this file does not itself hold the bare name a scan would match (L135). */
const OLD = ['bid', 'recording', 'coverage'].join('_')
const V2 = `${OLD}_v2`

/** Only a definition counts. A DROP names it too, and so does a comment. */
const definesOld = (sql: string): boolean =>
  new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${OLD}\\s*\\(`, 'i').test(sql)

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as T

describe('the first bid recording coverage function stays dropped', () => {
  const migrations = readMigrations()

  it('reads a real set of migrations, so a miss cannot read as a pass', () => {
    expect(migrations.length).toBeGreaterThan(100)
    expect(migrations.some((m) => m.name === CONTRACT_MIGRATION)).toBe(true)
  })

  it('has the contract migration dropping it by its exact signature', () => {
    const contract = migrations.find((m) => m.name === CONTRACT_MIGRATION)
    expect(contract).toBeDefined()
    expect(contract!.sql).toMatch(
      new RegExp(`DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+public\\.${OLD}\\s*\\(\\s*uuid\\s*,\\s*timestamptz\\s*\\)`, 'i'),
    )
    // It must never touch the replacement the monitor reads.
    expect(contract!.sql).not.toMatch(new RegExp(`DROP[^;]*${V2}`, 'i'))
  })

  it('has nothing after it recreating the old function', () => {
    const offenders = migrations.filter((m) => m.name > CONTRACT_MIGRATION && definesOld(m.sql)).map((m) => m.name)
    expect(offenders, `the monitor reads ${V2}; the original was retired in #1466`).toEqual([])
  })

  it('still finds v2 defined, so the check is about the original only', () => {
    // A guard that would pass just as well if both were gone is not measuring
    // what it claims to (L63).
    const all = migrations.map((m) => m.sql).join('\n')
    expect(all).toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${V2}\\s*\\(`, 'i'))
  })

  it('is off the read only rpc list, while v2 stays on it', () => {
    const rpcs = readJson<{ readOnly: string[]; mutating: string[] }>('apps/worker/src/lib/read-only-rpcs.json')
    expect(rpcs.readOnly).not.toContain(OLD)
    expect(rpcs.mutating).not.toContain(OLD)
    expect(rpcs.readOnly).toContain(V2)
  })

  it('is expected absent in the live manifest, while v2 is expected present', () => {
    const manifest = readJson<Array<{ name: string; anon: string }>>('supabase/required-live-objects.json')
    const old = manifest.filter((e) => e.name === OLD)
    expect(old.map((e) => e.anon)).toEqual(['absent'])
    expect(manifest.find((e) => e.name === V2)?.anon).toBe('denied')
  })

  it('is not listed as a STABLE read only rpc in the SQL suite', () => {
    const suite = readFileSync(path.join(REPO_ROOT, 'supabase/tests/buyer_profiles.test.sql'), 'utf8')
    expect(suite).toContain(`'${V2}'`)
    expect(suite).not.toContain(`'${OLD}'`)
  })
})
