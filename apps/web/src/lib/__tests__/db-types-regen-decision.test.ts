import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The "DB types regenerated with schema migrations" gate must fire on a schema
 * DDL change and stay quiet on everything else.
 *
 * It used to decide by `cat`-ing every changed migration and grepping the WHOLE
 * FILE for DDL keywords. That is a proxy for the thing it means (LESSONS L63): it
 * says "this file changed AND it contains a CREATE TABLE somewhere", which is true
 * of a pure comment edit in any migration that ever created a table. The gate then
 * demands a `database.ts` regen that has nothing to regenerate, so the change
 * cannot be made green at all and the only ways out are reverting the edit or
 * overriding the gate.
 *
 * Found 2026-08-14 correcting a wrong statement_timeout figure (#614) in the
 * comment header of `20260515000001_workflow_stats_daily_rollup.sql`, which does
 * create a table, 100 lines below the comment.
 *
 * The decision now reads only the ADDED and REMOVED lines of the diff, which is
 * the actual question: did any DDL move. The fail-safe direction is
 * `regen-required`: an unreadable diff asks for the regen rather than waving the
 * change through, because a missed regen drifts the typed client from the live
 * schema silently, while a needless one is merely a nuisance.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/db-types-regen-decision.sh')

function decide(diff: string): string {
  return execFileSync('bash', [SCRIPT], { input: diff, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

const header = 'diff --git a/supabase/migrations/x.sql b/supabase/migrations/x.sql\n--- a/supabase/migrations/x.sql\n+++ b/supabase/migrations/x.sql\n@@ -1,2 +1,2 @@\n'

describe('db-types regen decision (#614)', () => {
  it('does not ask for a regen when only a SQL comment changed', () => {
    // The case that motivated this: the file creates a table, but no DDL moved.
    expect(decide(`${header}-- which timed out at Postgres's 8s statement_timeout once the table grew\n+-- which timed out at the statement_timeout once the table grew\n`)).toBe('not-required')
  })

  it('asks for a regen when a column is added', () => {
    expect(decide(`${header}+ALTER TABLE lead_sightings ADD COLUMN foo text\n`)).toBe('regen-required')
  })

  it('asks for a regen when a table is created', () => {
    expect(decide(`${header}+CREATE TABLE opportunities (id uuid primary key)\n`)).toBe('regen-required')
  })

  it('asks for a regen when a column is dropped, which is a removed line', () => {
    expect(decide(`${header}-ALTER TABLE x DROP COLUMN y\n`)).toBe('regen-required')
  })

  it('does not ask for a regen for an index-only migration', () => {
    expect(decide(`${header}+CREATE INDEX CONCURRENTLY idx_foo ON lead_sightings (ssn_hash)\n`)).toBe('not-required')
  })

  it('does not ask for a regen for an RLS policy change', () => {
    expect(decide(`${header}+CREATE POLICY org_scope ON workflows FOR SELECT USING (true)\n`)).toBe('not-required')
  })

  it('does not ask for a regen for a column DEFAULT change, which the types do not carry', () => {
    expect(decide(`${header}+ALTER TABLE x ALTER COLUMN y SET DEFAULT now()\n`)).toBe('not-required')
  })

  it('still asks for a regen for a real ALTER COLUMN type change', () => {
    expect(decide(`${header}+ALTER TABLE x ALTER COLUMN y TYPE bigint\n`)).toBe('regen-required')
  })

  it('ignores the +++ and --- file headers, which are not content lines', () => {
    // `--- a/...create_table.sql` would otherwise read as a removed DDL line.
    const tricky = 'diff --git a/supabase/migrations/create_table_thing.sql b/supabase/migrations/create_table_thing.sql\n--- a/supabase/migrations/create_table_thing.sql\n+++ b/supabase/migrations/create_table_thing.sql\n@@ -1 +1 @@\n-- a comment\n+-- a comment, reworded\n'
    expect(decide(tricky)).toBe('not-required')
  })

  it('says not-required on an empty diff, because no migration changed', () => {
    expect(decide('')).toBe('not-required')
  })

  it('asks for a regen when a whole new migration lands', () => {
    const added = 'diff --git a/supabase/migrations/new.sql b/supabase/migrations/new.sql\nnew file mode 100644\n--- /dev/null\n+++ b/supabase/migrations/new.sql\n@@ -0,0 +1,3 @@\n+-- add the opportunities table\n+CREATE TABLE opportunities (id uuid)\n'
    expect(decide(added)).toBe('regen-required')
  })

  it('is case insensitive, because migrations are written in both cases', () => {
    expect(decide(`${header}+create table foo (id uuid)\n`)).toBe('regen-required')
  })
})
