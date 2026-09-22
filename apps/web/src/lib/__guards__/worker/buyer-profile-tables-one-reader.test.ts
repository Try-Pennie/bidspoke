/**
 * Guard: the buyer profile tables have ONE reader on the hot path (#1411, L692).
 *
 * The buyer_select node reads the six profile tables through
 * lib/buyer-profile-loader.ts, which owns the join, the 60 second cache and the
 * last good copy. A second reader would get none of that: it would hit the
 * database on every lead, serve an empty answer on a transient error, and
 * drift from the shape the shared evaluator expects. The other allowed sites
 * each exist for a stated reason: the mirror writes buyer_sales through its
 * rpc, the profile routes edit the tables, the parity route reads its own day
 * table, and the drain delivers the outbox.
 *
 * Seen to fail with a read added to engine/nodes/partner-bid.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

const TABLES = [
  'buyer_profiles',
  'buyer_operating_windows',
  'buyer_blackout_dates',
  'buyer_pricing_tiers',
  'buyer_sales',
  'buyer_select_parity_days',
] as const

/** Each allowed reader with the reason it is allowed, never because it was there when the guard was written (L233). */
const ALLOWED: Record<string, string> = {
  'lib/buyer-profile-loader.ts': 'the one profile read, with the cache and the last good copy',
  'lib/buyer-sale-mirror.ts': 'writes buyer_sales through record_buyer_sale',
  'lib/buyer-sale-drain.ts': 'the minute drain delivering the ledger outbox to buyer_sales (Phase 6)',
  'routes/api/buyer-profiles.ts': 'the profile editor routes (Phase 5)',
  'routes/api/buyer-sales.ts': 'the unresolved queue and settle routes (Phase 6)',
  'routes/api/buyer-select-parity.ts': 'the parity report over buyer_select_parity_days (Phase 6)',
  'lib/buyer-select-parity.ts': 'the parity computation writing buyer_select_parity_days (Phase 6)',
}

/** A `.from('table')` read or write, or a PostgREST join naming the table. Comments are skipped. */
function tableReferences(src: string): Array<{ line: number; table: string }> {
  const found: Array<{ line: number; table: string }> = []
  src.split('\n').forEach((text, i) => {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const table of TABLES) {
      const fromCall = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]`)
      const joinSpelling = new RegExp(`['"\`][^'"\`]*\\b${table}\\s*(!inner)?\\s*\\(`)
      if (fromCall.test(text) || joinSpelling.test(text)) found.push({ line: i + 1, table })
    }
  })
  return found
}

function offenders(): string[] {
  const out: string[] = []
  for (const dir of ['lib', 'engine', 'routes', 'durable-objects'].map((d) => path.join(WORKER_SRC, d))) {
    for (const file of listTsFiles(dir)) {
      const rel = path.relative(WORKER_SRC, file).replace(/\\/g, '/')
      if (rel.includes('__tests__')) continue
      if (rel in ALLOWED) continue
      for (const ref of tableReferences(readFileSync(file, 'utf8'))) out.push(`${rel}:${ref.line} reads ${ref.table}`)
    }
  }
  return out
}

describe('the buyer profile tables are read through lib/buyer-profile-loader.ts and nowhere else on the hot path', () => {
  it('no worker source outside the allowed sites names a profile table in a query', () => {
    expect(offenders()).toEqual([])
  })

  it('the loader itself is present and does read the tables, so an empty offender list is a measurement (L1)', () => {
    const loader = readFileSync(path.join(WORKER_SRC, 'lib/buyer-profile-loader.ts'), 'utf8')
    expect(tableReferences(loader).map((r) => r.table)).toEqual(expect.arrayContaining(['buyer_profiles', 'buyer_operating_windows', 'buyer_blackout_dates', 'buyer_pricing_tiers']))
  })

  it('the detector fires on a read added to partner-bid.ts, in both spellings', () => {
    const smuggled = [
      "const { data } = await supabase.from('buyer_profiles').select('*')",
      "  .select('id, buyer_pricing_tiers(population, multiplier)')",
      '// a comment naming buyer_sales is fine',
    ].join('\n')
    expect(tableReferences(smuggled)).toEqual([
      { line: 1, table: 'buyer_profiles' },
      { line: 2, table: 'buyer_pricing_tiers' },
    ])
  })
})
