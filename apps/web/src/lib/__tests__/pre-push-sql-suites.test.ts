/**
 * Which SQL suites the pre-push hook runs (#2412).
 *
 * `.husky/pre-push` used to decide from `git diff "@{upstream}" HEAD`, a two dot
 * diff against the upstream's TIP, and ran both suites whenever the branch had
 * no upstream. Both made a branch that changed no database file run the suites
 * in the shared Docker containers concurrent sessions use: a first push has no
 * upstream (PR #2386), and with the upstream set to origin/main every file main
 * changed since the branch was cut counts as the branch's (PR #2402).
 *
 * The decision now lives in `scripts/pre-push-sql-suites.sh`, which names the
 * suites from the branch's OWN changes, measured from its merge base with
 * origin/main, and names both when that merge base cannot be computed (the loud
 * side, L98). These tests drive the real script against throwaway git
 * repositories with a real bare origin, never the suites themselves.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const SCRIPT = path.join(REPO_ROOT, 'scripts/pre-push-sql-suites.sh')

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function configure(cwd: string) {
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', '/dev/null')
}

function commitFile(cwd: string, file: string, body = 'x\n') {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
  writeFileSync(path.join(cwd, file), body)
  git(cwd, 'add', '--', file)
  git(cwd, 'commit', '-qm', `add ${file}`)
}

/**
 * A bare origin whose main holds one commit, and a clone of it with a feature
 * branch cut from that commit and NO upstream. Returns the clone and the origin.
 */
function fixture(): { work: string; origin: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pre-push-sql-'))
  dirs.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const work = path.join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'init', '-q', '-b', 'main', seed)
  configure(seed)
  commitFile(seed, 'README.md', 'seed\n')
  commitFile(seed, 'supabase/migrations/20260101000000_first.sql', 'select 1;\n')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')
  git(root, 'clone', '-q', origin, work)
  configure(work)
  git(work, 'checkout', '-q', '-b', 'feature', '--no-track', 'origin/main')
  return { work, origin, root }
}

/** Advance origin's main from a separate clone, as another merged PR would. */
function advanceMain(root: string, origin: string, file: string) {
  const other = path.join(root, `other-${dirs.length}-${Math.random().toString(36).slice(2)}`)
  git(root, 'clone', '-q', origin, other)
  configure(other)
  commitFile(other, file, 'select 2;\n')
  git(other, 'push', '-q', 'origin', 'main')
}

function decide(cwd: string): { suites: string[]; stderr: string; status: number | null } {
  const res = spawnSync('bash', [SCRIPT], { cwd, encoding: 'utf8' })
  // A missing or crashing script prints nothing, which reads as "neither suite",
  // so every call must also have exited cleanly.
  expect(res.status, res.stderr).toBe(0)
  const suites = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  return { suites, stderr: res.stderr, status: res.status }
}

describe('scripts/pre-push-sql-suites.sh', () => {
  // The PR #2402 shape: main changed supabase/tests after the branch was cut,
  // the branch's upstream is origin/main, and the branch itself is TypeScript.
  it('runs neither suite for a TypeScript only branch behind a main that changed supabase/tests', () => {
    const { work, origin, root } = fixture()
    commitFile(work, 'apps/worker/src/thing.ts', 'export const a = 1\n')
    advanceMain(root, origin, 'supabase/tests/new.test.sql')
    advanceMain(root, origin, 'supabase-ops/supabase/tests/new.test.sql')
    git(work, 'fetch', '-q', 'origin')
    git(work, 'branch', '--set-upstream-to=origin/main')

    // The old rule's input, to prove the fixture really is the bad case.
    const twoDot = git(work, 'diff', '--name-only', '@{upstream}', 'HEAD')
    expect(twoDot).toContain('supabase/tests/new.test.sql')

    const r = decide(work)
    expect(r.status).toBe(0)
    expect(r.suites).toEqual([])
  })

  // Same, but main moved on the origin and the clone has not fetched it: the
  // script fetches, and the answer does not depend on a stale origin/main.
  it('runs neither suite when main moved on the origin and has not been fetched yet', () => {
    const { work, origin, root } = fixture()
    commitFile(work, 'apps/web/src/page.tsx', 'export {}\n')
    advanceMain(root, origin, 'supabase/migrations/20260202000000_other.sql')
    expect(decide(work).suites).toEqual([])
  })

  it('runs the main suite for a branch adding a supabase/migrations file', () => {
    const { work } = fixture()
    commitFile(work, 'supabase/migrations/20260301000000_mine.sql', 'select 3;\n')
    expect(decide(work).suites).toEqual(['main'])
  })

  it('runs the main suite for a branch changing the read only rpc list', () => {
    const { work } = fixture()
    commitFile(work, 'apps/worker/src/lib/read-only-rpcs.json', '{}\n')
    expect(decide(work).suites).toEqual(['main'])
  })

  it('runs the ops suite for a branch adding a supabase-ops file', () => {
    const { work } = fixture()
    commitFile(work, 'supabase-ops/supabase/migrations/20260301000000_ops.sql', 'select 4;\n')
    expect(decide(work).suites).toEqual(['ops'])
  })

  it('runs both suites for a branch changing the harness itself', () => {
    const { work } = fixture()
    commitFile(work, 'scripts/sql-suite/run.sh', 'echo\n')
    expect(decide(work).suites).toEqual(['main', 'ops'])
  })

  // The PR #2386 shape: a first push, so no upstream, and no database change.
  it('runs neither suite for a branch with no upstream and no database change', () => {
    const { work } = fixture()
    commitFile(work, 'apps/worker/src/thing.ts', 'export const a = 1\n')
    const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: work })
    expect(upstream.status).not.toBe(0)
    expect(decide(work).suites).toEqual([])
  })

  // L98: when the branch's own changes cannot be measured, run both rather than
  // pass on nothing, and say why.
  it('runs both suites when the merge base cannot be computed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pre-push-sql-'))
    dirs.push(root)
    git(root, 'init', '-q', '-b', 'feature')
    configure(root)
    commitFile(root, 'apps/worker/src/thing.ts', 'export const a = 1\n')
    const r = decide(root)
    expect(r.status).toBe(0)
    expect(r.suites).toEqual(['main', 'ops'])
    expect(r.stderr).toMatch(/merge base/i)
  })

  // A hung network must not stall the push: the fetch is killed at its deadline
  // and the decision is made from the origin/main already on disk, saying so.
  it('gives up on a hung fetch at its deadline and decides from the local origin/main', () => {
    const { work } = fixture()
    commitFile(work, 'supabase/migrations/20260301000000_mine.sql', 'select 3;\n')
    git(work, 'remote', 'set-url', 'origin', 'ssh://hung.invalid/repo.git')
    const started = Date.now()
    const res = spawnSync('bash', [SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, GIT_SSH_COMMAND: 'sleep 30 #', PRE_PUSH_FETCH_TIMEOUT: '1' },
    })
    const elapsed = Date.now() - started
    expect(res.status, res.stderr).toBe(0)
    expect(elapsed).toBeLessThan(10_000)
    expect(res.stderr).toMatch(/did not finish in 1s/)
    expect(res.stdout.split('\n').filter(Boolean)).toEqual(['main'])
  })

  it('runs both suites when origin/main shares no history with the branch', () => {
    const { work } = fixture()
    git(work, 'checkout', '-q', '--orphan', 'unrelated')
    git(work, 'rm', '-rq', '--cached', '.')
    commitFile(work, 'apps/worker/src/thing.ts', 'export const a = 1\n')
    expect(decide(work).suites).toEqual(['main', 'ops'])
  })
})

describe('.husky/pre-push', () => {
  const hook = readFileSync(path.join(REPO_ROOT, '.husky/pre-push'), 'utf8')

  it('decides the SQL suites through the script, not from the upstream', () => {
    expect(hook).toContain('scripts/pre-push-sql-suites.sh')
    expect(hook).not.toMatch(/@\{upstream\}/)
  })

  it('still honours SKIP_SQL_SUITE around both suites', () => {
    const skip = hook.indexOf('if [ -z "$SKIP_SQL_SUITE" ]')
    expect(skip).toBeGreaterThan(-1)
    expect(hook.indexOf('scripts/pre-push-sql-suites.sh')).toBeGreaterThan(skip)
  })
})
