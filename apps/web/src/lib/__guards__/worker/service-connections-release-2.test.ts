/**
 * service_connections release 2, the contract step (#2332, phase 2 of #1689).
 *
 * Release 1 (20261017150000) added `name`, a BEFORE INSERT trigger naming any
 * row saved without one, and UNIQUE (organization_id, service_type, name)
 * beside the old UNIQUE (organization_id, service_type). 20261018150000 added
 * the delete by id beside the old delete by service type. Both left the old
 * thing in place for the code then running and its rollback target (ADR 0007).
 * The contract migration, 20261019150000, removes all three once the code that
 * stopped needing them was live and read back.
 *
 * Two halves are proven here:
 *
 *   1. Every writer sends `name` (the issue's precondition for dropping the
 *      trigger). Found by the state reached rather than one spelling (L247):
 *      every worker `.insert(` or `.upsert(` chained on a
 *      `.from('service_connections')`, each of whose payloads must name
 *      `name`, and no database function inserting into the table at all.
 *      The generated database.ts makes `name` required on an insert too, so a
 *      typed writer that dropped it would not compile.
 *
 *   2. The drop is spread over places that each hold the name for a different
 *      reader, and a contract step finishing some of them leaves the rest
 *      asserting something false (the precedent is
 *      old-bid-recording-coverage-dropped.test.ts): the migration, the read only
 *      rpc list the local dev write guard reads, and the live manifest, which
 *      must now expect the old function ABSENT so a copy recreated by hand in
 *      production is reported.
 *
 * Proven against Postgres by supabase/tests/service_connections_contract.test.sql.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, consumeParens, listTsFiles, sanitizeSource, statementEnd } from '../../__tests__/_scan-utils'
import { readMigrations } from '../../__tests__/_pg-cron'

const CONTRACT_MIGRATION = '20261019150000_service_connections_contract_2332.sql'

/** Assembled so this file does not itself hold the bare rpc name a scan would match (L135). */
const OLD_DELETE = ['delete', 'service', 'connection'].join('_')
const BY_ID = `${OLD_DELETE}_by_id`
const TABLE = 'service_connections'

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as T

// ── 1. Every writer sends name ───────────────────────────────────────────────

export interface TableWrite {
  op: 'insert' | 'upsert'
  line: number
  /** The call's argument list, comments stripped, strings intact. */
  args: string
}

/** Every `.insert(` / `.upsert(` chained on `.from('service_connections')` in one source file. */
export function tableInsertsIn(raw: string): TableWrite[] {
  const code = sanitizeSource(raw, { blankStrings: false })
  const blanked = sanitizeSource(raw)
  const out: TableWrite[] = []
  const from = new RegExp(`\\.from\\(\\s*(['"\`])${TABLE}\\1\\s*\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = from.exec(code))) {
    const end = statementEnd(blanked, m.index)
    const chain = blanked.slice(m.index, end)
    const call = /\.(insert|upsert)\(/g
    let c: RegExpExecArray | null
    while ((c = call.exec(chain))) {
      const open = m.index + c.index + c[0].length - 1
      out.push({
        op: c[1] as 'insert' | 'upsert',
        line: code.slice(0, open).split('\n').length,
        args: code.slice(open, consumeParens(code, open)),
      })
    }
  }
  return out
}

/** A payload names the connection when its object literal carries a `name` key. */
export const sendsName = (w: TableWrite): boolean => /[{,]\s*name\s*:/.test(w.args)

const workerWrites = listTsFiles(WORKER_SRC)
  .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
  .flatMap((full) => tableInsertsIn(readFileSync(full, 'utf8')).map((w) => ({ ...w, file: path.relative(WORKER_SRC, full).replace(/\\/g, '/') })))

describe('every writer of service_connections sends a name (#2332 release 2)', () => {
  it('every worker insert and upsert on the table names name in its payload', () => {
    expect(workerWrites.filter((w) => !sendsName(w)).map((w) => `${w.file}:${w.line} ${w.op}`)).toEqual([])
  })

  it('finds the Slack save and the connection create, so an empty offender list is a measurement (L1)', () => {
    // The create (#2338, build PR 5) is a plain insert of an ops_key row, never an upsert.
    expect(workerWrites.map((w) => `${w.file} ${w.op}`)).toEqual(['routes/api/connections.ts insert', 'routes/api/integrations.ts upsert'])
  })

  it('no database function inserts into the table, so no writer is hidden behind an rpc', () => {
    const inserts = readMigrations().filter((m) => new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?"?${TABLE}"?[\\s(]`, 'i').test(m.sql))
    expect(inserts.map((m) => m.name)).toEqual([])
  })

  it('is seen to fail on a payload with no name, and to pass one that names it', () => {
    const planted = (body: string) => tableInsertsIn(`
      const { error } = await supabase
        .from('service_connections')
        // a comment saying name: is not a name
        .upsert(${body}, { onConflict: 'organization_id,service_type,name' })
        .select('id')
    `)
    const missing = planted(`{ organization_id: orgId, service_type: 'slack', auth_type: 'oauth', config }`)
    expect(missing).toHaveLength(1)
    expect(missing.every(sendsName)).toBe(false)
    expect(planted(`{ organization_id: orgId, service_type: 'slack', name: 'slack', config }`).every(sendsName)).toBe(true)
    // An insert of a variable is refused too: its payload cannot be read here.
    expect(tableInsertsIn(`await supabase.from("service_connections").insert(row)`).every(sendsName)).toBe(false)
  })
})

// ── 2. The contract step reached every place ─────────────────────────────────

describe('the release 2 contract migration (#2332)', () => {
  const migrations = readMigrations()
  const contract = migrations.find((m) => m.name === CONTRACT_MIGRATION)

  it('reads a real set of migrations, so a miss cannot read as a pass', () => {
    expect(migrations.length).toBeGreaterThan(100)
    expect(contract).toBeDefined()
  })

  it('drops the old delete by its exact signature, and never the delete by id', () => {
    expect(contract!.sql).toMatch(new RegExp(`DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+public\\.${OLD_DELETE}\\s*\\(\\s*uuid\\s*,\\s*text\\s*,\\s*uuid\\s*\\)`, 'i'))
    expect(contract!.sql).not.toMatch(new RegExp(`DROP[^;]*${BY_ID}`, 'i'))
  })

  it('drops the old one row per service unique and the name defaulting trigger and its function', () => {
    expect(contract!.sql).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+service_connections_org_type_unique\b/i)
    expect(contract!.sql).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+service_connections_default_name\s+ON\s+public\.service_connections/i)
    expect(contract!.sql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.service_connections_default_name\s*\(\s*\)/i)
    // The named unique the Slack upsert's conflict target needs is left alone.
    expect(contract!.sql).not.toMatch(/service_connections_org_type_name_unique/i)
  })

  it('has nothing after it recreating any of the three', () => {
    const later = migrations.filter((m) => m.name > CONTRACT_MIGRATION)
    const recreates = (sql: string) =>
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?(?:${OLD_DELETE}|service_connections_default_name)\\s*\\(`, 'i').test(sql) ||
      /CREATE\s+TRIGGER\s+service_connections_default_name\b/i.test(sql) ||
      /ADD\s+CONSTRAINT\s+service_connections_org_type_unique\b/i.test(sql)
    expect(later.filter((m) => recreates(m.sql)).map((m) => m.name)).toEqual([])
  })

  it('leaves the old delete off the read only rpc list, while the delete by id stays a mutating rpc', () => {
    const rpcs = readJson<{ readOnly: string[]; mutating: string[] }>('apps/worker/src/lib/read-only-rpcs.json')
    expect(rpcs.readOnly).not.toContain(OLD_DELETE)
    expect(rpcs.mutating).not.toContain(OLD_DELETE)
    expect(rpcs.mutating).toContain(BY_ID)
  })

  it('expects the old delete absent in the live manifest, while the delete by id is expected present and denied to anon', () => {
    const manifest = readJson<Array<{ name: string; anon: string }>>('supabase/required-live-objects.json')
    expect(manifest.filter((e) => e.name === OLD_DELETE).map((e) => e.anon)).toEqual(['absent'])
    expect(manifest.filter((e) => e.name === BY_ID).map((e) => e.anon)).toEqual(['denied'])
  })

  it('no worker source calls the old delete', () => {
    const callers = listTsFiles(WORKER_SRC)
      .filter((f) => new RegExp(`\\.rpc\\(\\s*(['"\`])${OLD_DELETE}\\1`).test(sanitizeSource(readFileSync(f, 'utf8'), { blankStrings: false })))
      .map((f) => path.relative(WORKER_SRC, f))
    expect(callers).toEqual([])
  })
})
