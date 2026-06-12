/**
 * Issue #87: workflow_stats_daily shipped without RLS or a policy, so an
 * authenticated user could read/alter/delete every org's rollup stats directly
 * via PostgREST (org scoping lived only inside the workflow_stats_rollup RPC).
 *
 * RLS is enforced at the DB level and there's no Postgres in CI, so this guards
 * the migration invariant instead: the table must have RLS enabled and an
 * org-scoping policy somewhere in the migration set. Catches an accidental
 * table re-creation or migration deletion that drops the protection.
 *
 * Lives in apps/web (not apps/worker) because the worker tsconfig excludes Node
 * types; web is where the other filesystem-reading invariant tests live.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const migrationsDir = path.resolve(dir, '../../../../..', 'supabase/migrations')

function allMigrationSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n')
}

describe('workflow_stats_daily RLS (issue #87)', () => {
  const sql = allMigrationSql()

  it('enables row level security on the table', () => {
    expect(sql).toMatch(/ALTER TABLE\s+workflow_stats_daily\s+ENABLE ROW LEVEL SECURITY/i)
  })

  it('defines an org-scoping policy on the table', () => {
    // The table has workflow_id, not organization_id, so the policy must scope
    // through the workflows join — like the sibling lead_sightings policy.
    expect(sql).toMatch(/CREATE POLICY\s+"[^"]+"\s+ON\s+workflow_stats_daily/i)
    // Anchor to the policy declaration (name immediately followed by ON <table>)
    // so a stray "workflow_stats_daily" mention in another block can't match.
    const policyBlock = sql
      .split(/CREATE POLICY/i)
      .find((b) => /^\s*"[^"]+"\s+ON\s+workflow_stats_daily\b/i.test(b)) ?? ''
    expect(policyBlock).toMatch(/FROM\s+workflows/i)
    expect(policyBlock).toMatch(/organization_id\s*=\s*public\.user_org_id\(\)/i)
  })
})
