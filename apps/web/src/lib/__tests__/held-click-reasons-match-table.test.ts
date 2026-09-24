/**
 * Guard: the held click reasons the node records are exactly the ones the
 * held_click_claims table accepts (#1552, L41).
 *
 * The node records a held claim under a reason from HELD_CLICK_REASONS, and the
 * table's CHECK constraint refuses any other. A reason added to the list and not
 * to the table would pass every unit test and fail as a refused write in
 * production, where the node only logs it. So the constraint is read from the
 * migration that created it and compared with the list.
 *
 * Seen to fail with 'count_failed' added to the constraint.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HELD_CLICK_REASONS } from '@bidspoke/buyer-profile'
import { REPO_ROOT } from './_scan-utils'

const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/20260924220000_held_click_claims.sql')

describe('held click reasons match the table', () => {
  it('the CHECK constraint lists exactly the reasons the node records', () => {
    const sql = readFileSync(MIGRATION, 'utf8')
    const m = /held_click_claims_reason_check CHECK \(reason IN \(([^)]*)\)\)/.exec(sql)
    expect(m, 'the reason CHECK constraint was not found in the migration').not.toBeNull()
    const inTable = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(inTable).toEqual([...HELD_CLICK_REASONS].sort())
  })
})
