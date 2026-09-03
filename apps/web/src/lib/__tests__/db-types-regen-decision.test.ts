import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  it('does not ask for a regen when an ADDED COMMENT mentions DDL', () => {
    // The #614 fix stopped the gate reading DDL from elsewhere in the FILE, but
    // not from a comment on an added LINE, which is the same defect one level
    // down: the guard is satisfied by prose ABOUT the thing rather than the thing
    // (LESSONS L103). The function branch of the script already strips comments
    // before matching; the keyword branch did not.
    //
    // Found 2026-09-03 on the migration replay fix, whose explanation of the
    // defect has to quote `CREATE TABLE` in order to describe it, and which
    // changes no schema shape at all: constraints are not in the generated types.
    const diff =
      `${header}+-- the foreign key INLINE and UNNAMED inside \`CREATE TABLE execution_steps\`, so\n` +
      `+ALTER TABLE execution_steps ADD CONSTRAINT foo FOREIGN KEY (a) REFERENCES b(c)\n`
    expect(decide(diff)).toBe('not-required')
  })

  it('still asks for a regen when real DDL sits beside a comment mentioning DDL', () => {
    // Stripping comments must not become a way to hide a real change: a diff
    // carrying both must still fire, or the fix above would be an escape hatch.
    const diff =
      `${header}+-- this comment mentions CREATE TABLE purely as prose\n` +
      `+ALTER TABLE lead_sightings ADD COLUMN foo text\n`
    expect(decide(diff)).toBe('regen-required')
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

  /**
   * Found while fixing #853. The decision was `printf ... | grep -v ... | grep -q`
   * under `set -o pipefail`. `grep -q` exits the instant it matches, so on any diff
   * bigger than the 64KB pipe buffer the upstream producer is killed by SIGPIPE,
   * the pipeline reports 141, and the `if` reads a MATCH as no match (LESSONS L183).
   * The gate then answers `not-required` on a migration that plainly creates a
   * table, which is the fail-unsafe direction: the types drift silently.
   *
   * Measured before the fix: a 1.2MB diff whose FIRST content line is
   * `CREATE TABLE opportunities` answered `not-required`. It needs the DDL near the
   * top, because that is what makes grep short-circuit while the producer is still
   * writing; DDL at the end is read after the producer has finished and passes
   * either way.
   */
  it('still asks for a regen when the DDL is at the top of a diff larger than the pipe buffer', () => {
    const padding = Array.from({ length: 40000 }, (_, i) => `+-- padding comment line ${i}`).join('\n')
    const big = `${header}+CREATE TABLE opportunities (id uuid)\n${padding}\n`
    expect(big.length).toBeGreaterThan(64 * 1024)
    expect(decide(big)).toBe('regen-required')
  })
})

/**
 * Function DDL (#853).
 *
 * `supabase gen types` emits a `Functions` block, so adding a function moves the
 * generated types while matching none of the keywords above. #770 added
 * `public.pg_cron_health`, this gate passed on that PR, and the nightly drift
 * check failed the next morning (#845) with the committed types stale.
 *
 * The decision CANNOT be made from the migration text alone. Every migration is a
 * NEW FILE, so git reports the whole thing as added lines: a body-only
 * `CREATE OR REPLACE FUNCTION` and a signature change are textually identical at
 * PR time. `public.reduce_finalize_stranded` has been replaced in five separate
 * migrations, character-for-character the same declaration each time, so a rule
 * that trips on a declaration appearing in the diff would demand a regen on all
 * five, each producing no diff, each unmergeable. That is the #614 trap in a new
 * shape.
 *
 * So the diff is compared against the only available statement of the previous
 * shape: the `Functions` block of the committed types.
 */
const MIGRATIONS = 'supabase/migrations'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * The real `git diff` for a migration arriving as a wholly new file, which is how
 * every migration reaches this gate. Rendering the diff by hand instead would
 * lose the property the function cases turn on (L48): the unchanged signature of
 * a body-only replace still arrives as ADDED lines.
 */
function newFileDiff(...migrations: string[]): string {
  const paths = migrations.map((m) => `${MIGRATIONS}/${m}`)
  const diff = execFileSync('git', ['diff', '-U0', '-M', EMPTY_TREE, 'HEAD', '--', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  // A fixture that resolved to nothing would make every case below pass on an
  // empty diff, which answers `not-required` for reasons unrelated to the rule.
  expect(diff, `fixture ${migrations.join(', ')} produced no diff`).toContain('FUNCTION')
  return diff
}

function decideWith(diff: string, typesFile: string): { decision: string; stderr: string } {
  const run = spawnSync('bash', [SCRIPT], {
    input: diff,
    encoding: 'utf8',
    env: { ...process.env, DB_TYPES_FILE: typesFile },
  })
  return { decision: (run.stdout ?? '').trim(), stderr: run.stderr ?? '' }
}

/**
 * The committed types as they stood when #770 was opened: the real pre-drift state,
 * with a Functions block that does not list the function that migration added.
 * Reconstructing that by editing today's file would be shaping a fixture so the rule
 * fires (L48), so this is the artifact the gate actually read on the PR that slipped
 * through, copied verbatim out of 524d805^ and committed.
 *
 * COMMITTED, not read out of git history. The first version of these tests ran
 * `git show 524d805^:...` and passed locally, then died on the CI runner with
 * "invalid object name": actions/checkout is shallow by default in the Test job, so
 * no commit but HEAD exists there. A test whose fixture depends on clone depth is a
 * test that only runs in some of the places it is meant to run.
 */
const PRE_DRIFT_FUNCTIONS = path.join(REPO_ROOT, 'apps/web/src/lib/__tests__/fixtures/db-types-functions-before-pg-cron-health.txt')

function typesFixture(file: string): string {
  const content = readFileSync(file, 'utf8')
  expect(content, `fixture ${path.basename(file)} has no Functions block`).toMatch(/^ *Functions: \{$/m)
  return file
}

describe('db-types regen decision, function DDL (#853)', () => {
  /**
   * The pair below is the whole point of the rule: ONE diff, the real #770
   * migration, answered differently depending only on whether the committed types
   * already record the function. If the decision were made from the migration text
   * alone, both cases would answer the same and one of the two would be wrong.
   */
  it('asks for a regen for a function name the committed types do not record', () => {
    const { decision, stderr } = decideWith(
      newFileDiff('20260817000001_pg_cron_health.sql'),
      typesFixture(PRE_DRIFT_FUNCTIONS),
    )
    expect(decision).toBe('regen-required')
    expect(stderr).toContain('pg_cron_health')
  })

  it('does not ask for a regen for that same migration once the types record the function', () => {
    // Today's committed types, which #845 regenerated. Nothing left to regenerate.
    expect(decide(newFileDiff('20260817000001_pg_cron_health.sql'))).toBe('not-required')
  })

  it('does not ask for a regen when replacing a function the types already record', () => {
    // Body-only CREATE OR REPLACE of public.reduce_finalize_stranded. Its
    // declaration is identical to the four earlier migrations that replaced it and
    // still arrives as added lines, which is the whole point of the case.
    expect(decide(newFileDiff('20260627000001_strand_finalize_finish_timestamps.sql'))).toBe('not-required')
  })

  it('does not ask for a regen for a RETURNS TRIGGER function, which the types never carry', () => {
    // `supabase gen types` omits trigger functions entirely, so set_updated_at,
    // handle_new_auth_user, handle_auth_user_updated, folders_prevent_cycle and
    // env_var_folders_prevent_cycle are all absent from the Functions block today.
    // Reading their absence as "new" would demand a regen with nothing to
    // regenerate on every trigger migration, which is the #614 trap again.
    expect(decide(newFileDiff('20260814000001_refuse_non_allowlisted_signup.sql'))).toBe('not-required')
  })

  /**
   * Measured by replaying this gate over all 104 commits that ever touched
   * supabase/migrations (L147: a rule seen to fire on a fixture you chose has only
   * been shown to work on the shape you had in mind). Of the 18 commits this change
   * newly blocks, 11 predate database.ts existing at all, six are the real drift the
   * gate exists to catch, and ONE is a false block: cb66b3e added
   * `reduce_finalize_stranded_executions` and dropped it again in the same commit,
   * three migrations in one diff. The function does not exist once that diff is
   * applied, so a regen produces no diff and the demanded gate can never be
   * satisfied. Net effect, not first sighting: the last event for a name in the diff
   * decides. Migration filenames sort by timestamp and git orders a diff by path, so
   * diff order is apply order.
   */
  it('does not ask for a regen when a function is created and dropped in the same diff', () => {
    // The three migrations cb66b3e landed together, still in the tree today, diffed
    // from the empty tree exactly as a new migration reaches the gate. Built from the
    // files rather than from that commit, so it does not need git history: the
    // committed types record no such function either, which is the state under test.
    const diff = newFileDiff(
      '20260708000001_reduce_finalize_stranded_executions.sql',
      '20260708000002_pause_reduce_finalize_stranded_executions.sql',
      '20260708000003_drop_reduce_finalize_stranded_executions_fn.sql',
    )
    expect(diff).toContain('CREATE OR REPLACE FUNCTION public.reduce_finalize_stranded_executions')
    expect(diff).toContain('DROP FUNCTION IF EXISTS public.reduce_finalize_stranded_executions')
    // Judged against a types file that does not record the function, which is the
    // state that makes the case meaningful: were it recorded, the drop alone would
    // ask for a regen and the answer would be right for a different reason.
    const types = typesFixture(PRE_DRIFT_FUNCTIONS)
    expect(readFileSync(types, 'utf8')).not.toContain('reduce_finalize_stranded_executions')
    expect(decideWith(diff, types).decision).toBe('not-required')
  })

  it('asks for a regen when a recorded function is dropped and re-created in the same diff', () => {
    // The reverse order, which is how a signature change is done properly. The net
    // effect is a function the types do not record yet, so the regen has real work.
    const dropThenCreate = `${header}+DROP FUNCTION IF EXISTS public.some_new_helper(int)\n+CREATE OR REPLACE FUNCTION public.some_new_helper(a int, b int)\n+RETURNS int\n`
    expect(decide(dropThenCreate)).toBe('regen-required')
  })

  it('asks for a regen when DROP FUNCTION names a function the types still record', () => {
    expect(decide(`${header}+DROP FUNCTION IF EXISTS public.prune_orphan_auth_users()\n`)).toBe('regen-required')
  })

  it('does not ask for a regen when DROP FUNCTION names a function the types never recorded', () => {
    // Already gone from the types, so the regen it would demand has no diff to make.
    expect(decide(`${header}+DROP FUNCTION IF EXISTS public.set_updated_at()\n`)).toBe('not-required')
  })

  it('asks for a regen when a materialized view is dropped', () => {
    expect(decide(`${header}+DROP MATERIALIZED VIEW workflow_stats_daily\n`)).toBe('regen-required')
  })

  it('asks for a regen when a table is renamed', () => {
    expect(decide(`${header}+ALTER TABLE opportunities RENAME TO bid_outcomes\n`)).toBe('regen-required')
  })

  it('does not ask for a regen when an index is renamed, which the types do not carry', () => {
    expect(decide(`${header}+ALTER INDEX idx_foo RENAME TO idx_bar\n`)).toBe('not-required')
  })

  it('asks for a regen, naming the unreadable types file, when the types file is missing', () => {
    // A path that exists nowhere, rather than a missing name under the real types
    // directory: what is under test is the script's answer when the file it needs
    // cannot be read, which has nothing to do with where that file normally lives.
    const { decision, stderr } = decideWith(
      newFileDiff('20260817000001_pg_cron_health.sql'),
      path.join(mkdtempSync(path.join(tmpdir(), 'db-types-')), 'does-not-exist.ts'),
    )
    expect(decision).toBe('regen-required')
    // The specific cause, not merely that something went wrong (L11, L140): a
    // missing file and an unparseable one are different failures and the message
    // that answers for both cannot be acted on.
    expect(stderr).toMatch(/cannot read the generated types file/i)
    expect(stderr).toContain('does-not-exist.ts')
  })

  it('asks for a regen, naming the missing Functions block, when the types file has none', () => {
    const stub = path.join(mkdtempSync(path.join(tmpdir(), 'db-types-')), 'database.ts')
    writeFileSync(stub, 'export type Database = { public: { Tables: { foo: { Row: { id: string } } } } }\n')
    const { decision, stderr } = decideWith(newFileDiff('20260817000001_pg_cron_health.sql'), stub)
    expect(decision).toBe('regen-required')
    expect(stderr).toMatch(/no Functions block/i)
    // Distinct from the unreadable-file reason above, so neither answers for the other.
    expect(stderr).not.toMatch(/cannot read/i)
  })
})
