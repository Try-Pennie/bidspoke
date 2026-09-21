import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WIRED_POPULATIONS } from '@bidspoke/buyer-profile'
import { REPO_ROOT } from './_scan-utils'

/**
 * The wired population list lives in two places on purpose and this guard keeps
 * them one list (#1409, L41, L46): WIRED_POPULATIONS in @bidspoke/buyer-profile,
 * which the form and the API refuse against, and the CHECK constraint
 * buyer_pricing_tiers_population_wired in the database, which refuses what the
 * form did not. A population joins both in the migration that puts a
 * buyer_select node on that workflow. The constraint may be redefined by a later
 * migration, so the LAST definition in migration order is the one compared.
 */
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

function constraintPopulations(): string[] | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  let latest: string[] | null = null
  for (const f of files) {
    const src = readFileSync(path.join(MIGRATIONS, f), 'utf8')
    for (const m of src.matchAll(/buyer_pricing_tiers_population_wired\s+CHECK\s*\(\s*population\s+IN\s*\(([^)]*)\)\s*\)/gi)) {
      latest = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    }
  }
  return latest
}

describe('WIRED_POPULATIONS matches the database constraint', () => {
  it('finds the constraint in a migration, so this cannot pass vacuously (L98)', () => {
    expect(constraintPopulations()).not.toBeNull()
  })
  it('lists the same populations', () => {
    expect(constraintPopulations()).toEqual([...WIRED_POPULATIONS].sort())
  })
})
