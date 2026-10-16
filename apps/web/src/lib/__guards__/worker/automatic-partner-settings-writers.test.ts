/**
 * Every automatic writer of partner settings is named, with how History
 * credits it (#2141, L96, L564).
 *
 * History names who made each change. A person's write comes through a route
 * under apps/worker/src/routes (behind jwtAuth, with the person as actor). A
 * write from anywhere else in the Worker (a cron, a Durable Object, the engine)
 * is a job, and a job writing a page table with no actor and no
 * bidspoke.actor_job would read as "Changed directly in the database", which
 * is false. This scan lists every write to a partner settings table, and every
 * call of a partner page save RPC, outside the routes, and fails on any not on
 * the list below with its reason. A new automatic writer must either set
 * bidspoke.actor_job for its transaction (through a function that sets it,
 * since a PostgREST write cannot) or record itself elsewhere, and be added here
 * saying which.
 *
 * Not on the list, by design: partner_daily_counts (counts the cap Durable
 * Object writes, not settings; no audit trigger records it), and the matrix
 * sync's own record, bid_config_history.
 *
 * Seen red on 2026-10-15 with a planted `.from('partner_configs').update(` in a
 * scratch file under apps/worker/src/lib, and with the bid-matrix-sync entry
 * removed from the list.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource, statementEnd } from '../../__tests__/_scan-utils'

const PARTNER_SETTINGS_TABLES = [
  'partner_configs',
  'buyer_profiles',
  'buyer_operating_windows',
  'buyer_blackout_dates',
  'buyer_pricing_tiers',
  'partner_uuid_map',
  'partner_bid_configs',
  'bid_matrix_rows',
]
const PARTNER_SAVE_RPCS = [
  'save_partner_config',
  'save_partner_page',
  'save_buyer_profile',
  'change_partner_uuid',
  'rename_partner_step_namespace',
  'delete_partner_config',
]

/** file (relative to apps/worker/src) and table or rpc, with how History credits it. */
const KNOWN_AUTOMATIC_WRITERS: Record<string, string> = {
  'lib/bid-matrix-sync.ts partner_bid_configs':
    'The matrix sync stamps last_synced_at and last_sync_error, which no audit trigger records; the sync itself is recorded in bid_config_history, credited to the hourly job or to the person who pressed Sync now.',
  'lib/bid-matrix-sync.ts bid_matrix_rows':
    'The matrix rows the sync copies from Salesforce; recorded as the sync in bid_config_history, as above.',
}

const rel = (file: string) => path.relative(WORKER_SRC, file).replace(/\\/g, '/')

export function automaticWrites(files: Array<{ name: string; src: string }>): string[] {
  const found = new Set<string>()
  for (const { name, src } of files) {
    const code = sanitizeSource(src, { blankStrings: false })
    const blanked = sanitizeSource(src)
    for (const m of code.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
      if (!PARTNER_SETTINGS_TABLES.includes(m[1])) continue
      const stmt = blanked.slice(m.index, statementEnd(blanked, m.index))
      if (/\.(insert|update|upsert|delete)\(/.test(stmt)) found.add(`${name} ${m[1]}`)
    }
    for (const m of code.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)) {
      if (PARTNER_SAVE_RPCS.includes(m[1])) found.add(`${name} ${m[1]}`)
    }
  }
  return [...found].sort()
}

function workerFilesOutsideRoutes(): Array<{ name: string; src: string }> {
  return listTsFiles(WORKER_SRC)
    .filter((f) => !rel(f).startsWith('routes/') && !rel(f).startsWith('types/'))
    .map((f) => ({ name: rel(f), src: readFileSync(f, 'utf8') }))
}

describe('automatic writers of partner settings (#2141)', () => {
  it('names every one outside the routes, and no stale entry', () => {
    const files = workerFilesOutsideRoutes()
    expect(files.length).toBeGreaterThan(50)
    expect(automaticWrites(files)).toEqual(Object.keys(KNOWN_AUTOMATIC_WRITERS).sort())
  })

  it('sees a write, chained over lines, and an rpc, and ignores a read', () => {
    const planted = [
      { name: 'lib/planted.ts', src: "await supabase\n  .from('partner_configs')\n  .update({ daily_cap: 1 })\n  .eq('id', id)\n" },
      { name: 'lib/planted-rpc.ts', src: "await supabase.rpc('save_partner_page', {})\n" },
      { name: 'lib/read.ts', src: "await supabase.from('partner_configs').select('id').eq('id', id)\n// .from('buyer_profiles').delete()\n" },
    ]
    expect(automaticWrites(planted)).toEqual(['lib/planted-rpc.ts save_partner_page', 'lib/planted.ts partner_configs'])
  })
})
