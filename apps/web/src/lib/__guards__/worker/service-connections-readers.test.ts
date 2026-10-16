import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every worker read of `service_connections` goes through its homes (#1303).
 *
 * The Slack token lives in that table, so every alert looks it up there, and on
 * 2026-10-08 a database stall made each lookup hang for up to 136 s before any
 * fallback. Phase 1 of #1303 bounds the lookup on the scheduled handler's client
 * and falls back to the saved copy, but only for reads that go through the
 * helpers: getSlackConnection and the request path's readers in lib/slack.ts,
 * slackOrgIds, forEachSlackOrg and readEverySlackConnection in
 * lib/alert-fanout.ts. A check that read the table directly (four did, found by
 * the state reached rather than one spelling, L247) took none of that, and went
 * silent in an outage while every other alert spoke.
 *
 * So this fails on the table's name as a string anywhere in worker source
 * outside those two modules and the API routes, which edit connections for the
 * signed-in app (routes/api/). The name as a string catches `.from('...')`, the
 * other quote styles, and a constant holding it, all of which are the same read.
 * The generated database types name the table as a bare key, not a string.
 *
 * Seen red on 2026-10-15 against the planted sources in the last tests here (kept
 * so the check stays proven) and against a real direct read put back into
 * lib/standing-alert.ts.
 */

const ALLOWED = ['lib/slack.ts', 'lib/alert-fanout.ts']
const ALLOWED_DIRS = ['routes/api/']

/** A quoted string whose whole content is the table's name, in any quote style. */
const TABLE_NAME = /(['"`])service_connections\1/

export function namesTheTable(source: string): boolean {
  // Keep string literals (the name is one); strip only comments, so a comment
  // explaining the rule is not itself a read.
  return TABLE_NAME.test(sanitizeSource(source, { blankStrings: false }))
}

const rel = (full: string) => path.relative(WORKER_SRC, full).replace(/\\/g, '/')

const files = listTsFiles(WORKER_SRC)
  .map((full) => ({ rel: rel(full), full }))
  // Tests legitimately carry the name in their Supabase doubles.
  .filter((f) => !f.rel.includes('/__tests__/'))

const naming = files.filter((f) => namesTheTable(readFileSync(f.full, 'utf8'))).map((f) => f.rel)
const allowed = (r: string) => ALLOWED.includes(r) || ALLOWED_DIRS.some((d) => r.startsWith(d))

describe('service_connections is read only through its homes (#1303)', () => {
  it('no worker source outside lib/slack.ts, lib/alert-fanout.ts and routes/api names the table', () => {
    expect(naming.filter((r) => !allowed(r))).toEqual([])
  })

  it('finds the reads in each home, so it cannot pass by matching nothing', () => {
    for (const home of ALLOWED) expect(naming).toContain(home)
    expect(naming.some((r) => r.startsWith('routes/api/'))).toBe(true)
  })

  it('fails on a planted direct read in each spelling, and not on a comment naming the table', () => {
    expect(namesTheTable(`const { data } = await supabase.from('service_connections').select('organization_id')`)).toBe(true)
    expect(namesTheTable('await supabase.from("service_connections").select("config")')).toBe(true)
    expect(namesTheTable('const TABLE = `service_connections`\nawait supabase.from(TABLE)')).toBe(true)
    expect(namesTheTable(`// reads service_connections through slackOrgIds\nconst orgs = await slackOrgIds(supabase, 'x')`)).toBe(false)
    expect(namesTheTable(`/* the 'service_connections' table */ const x = 1`)).toBe(false)
  })
})

/**
 * The scheduled handler builds its one client per tick through
 * createScheduledSupabaseClient, which registers the bounded lookup. Built any
 * other way, every scheduled lookup would quietly fall back to the retried read
 * with no copy behind it, and nothing else would notice.
 */
describe('the scheduled handler\'s client is the registered one (#1303)', () => {
  const index = sanitizeSource(readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8'), { blankStrings: false })
  const start = index.indexOf('const scheduledJobs = {')
  const body = index.slice(start, index.indexOf('\nexport default {', start))

  it('builds the tick\'s client with createScheduledSupabaseClient and no other client', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/const supabase = createScheduledSupabaseClient\(env\)/)
    expect(body).not.toMatch(/createSupabaseClient\(/)
  })
})
