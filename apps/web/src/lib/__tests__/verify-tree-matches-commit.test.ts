/**
 * The pre-push check that what is committed matches what the tests ran on
 * (#889).
 *
 * Local checks read the WORKING TREE. CI reads the COMMIT. When they diverge
 * every local signal is green and the pull request is broken, and no amount of
 * local testing can see it, because the local tools are on the wrong side of the
 * divergence.
 *
 * The case that produced this: on 2026-08-19 in PR #888 a file was renamed and
 * its import fixed in the tree, but the `git add` listed the file's old
 * pre-rename path alongside the new one. Git rejects the WHOLE command when any
 * path is bad, so it staged nothing, stderr went to /dev/null and the exit code
 * was never checked. The commit kept the stale import. Two CI jobs failed on it
 * while the full local suite passed.
 *
 * The second describe block runs the real script against real temporary git
 * repositories rather than only feeding strings to the parser. That is the point
 * of it: a test whose only outside dependency is a stub I wrote can confirm my
 * assumption about `git status --porcelain` and nothing else (L52), and the
 * parsing of that format is precisely where this can be wrong.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyTreeState, SOURCE_DIRS } from '../../../../../scripts/verify-tree-matches-commit.mjs'

/** Build the NUL-separated payload `git status --porcelain -z` produces. */
const porcelain = (...entries: string[]) => entries.join('\0') + '\0'

describe('classifyTreeState', () => {
  it('reports nothing on a clean tree', () => {
    const r = classifyTreeState('', SOURCE_DIRS)
    expect(r.modified).toEqual([])
    expect(r.stagedNotCommitted).toEqual([])
    expect(r.untrackedSource).toEqual([])
    expect(r.clean).toBe(true)
  })

  // The core case: the tests ran on this content and the commit does not have it.
  it('reports a tracked file modified in the tree but not staged', () => {
    const r = classifyTreeState(porcelain(' M apps/worker/src/engine/index.ts'), SOURCE_DIRS)
    expect(r.modified).toEqual(['apps/worker/src/engine/index.ts'])
    expect(r.clean).toBe(false)
  })

  // The PR #888 shape: staged, so it looks handled, but never committed, so the
  // commit CI reads does not contain it.
  it('reports a staged change that is not in a commit yet', () => {
    const r = classifyTreeState(porcelain('M  apps/worker/src/lib/slack.ts'), SOURCE_DIRS)
    expect(r.stagedNotCommitted).toEqual(['apps/worker/src/lib/slack.ts'])
    expect(r.clean).toBe(false)
  })

  it('reports a file that is both staged and further modified in the tree', () => {
    const r = classifyTreeState(porcelain('MM apps/worker/src/lib/slack.ts'), SOURCE_DIRS)
    expect(r.stagedNotCommitted).toContain('apps/worker/src/lib/slack.ts')
    expect(r.modified).toContain('apps/worker/src/lib/slack.ts')
  })

  it('reports a deleted tracked file', () => {
    const r = classifyTreeState(porcelain(' D apps/worker/src/lib/gone.ts'), SOURCE_DIRS)
    expect(r.modified).toEqual(['apps/worker/src/lib/gone.ts'])
  })

  // An untracked file under a source directory is the same class: the suite
  // imported it locally and CI will not have it at all. This is the exact shape
  // of a new test fixture that was never added.
  it('reports an untracked file inside a source directory', () => {
    const r = classifyTreeState(porcelain('?? apps/worker/src/engine/new-thing.ts'), SOURCE_DIRS)
    expect(r.untrackedSource).toEqual(['apps/worker/src/engine/new-thing.ts'])
    expect(r.clean).toBe(false)
  })

  // And an untracked file OUTSIDE them is not, which is what stops this being a
  // gate nobody can get past. Scratch files, editor droppings and
  // supabase/.temp are not able to change a test result.
  it('ignores an untracked file outside the source directories', () => {
    const r = classifyTreeState(
      porcelain('?? supabase/.temp/linked-project.json', '?? notes.md', '?? /tmp-thing'),
      SOURCE_DIRS,
    )
    expect(r.untrackedSource).toEqual([])
    expect(r.clean).toBe(true)
  })

  // Renames arrive as two NUL-separated fields under -z, so a parser written for
  // the space-separated ` -> ` form silently mis-reads them. This is the very
  // operation that produced the incident.
  it('reads a staged rename without mangling the path', () => {
    const r = classifyTreeState(
      'R  apps/worker/src/lib/new-name.ts\0apps/worker/src/lib/old-name.ts\0',
      SOURCE_DIRS,
    )
    expect(r.stagedNotCommitted).toEqual(['apps/worker/src/lib/new-name.ts'])
    expect(r.modified).toEqual([])
  })

  it('handles a path containing a space', () => {
    const r = classifyTreeState(porcelain(' M apps/web/src/app/(app)/my page/page.tsx'), SOURCE_DIRS)
    expect(r.modified).toEqual(['apps/web/src/app/(app)/my page/page.tsx'])
  })

  it('covers every source package, not just the worker', () => {
    const r = classifyTreeState(
      porcelain(' M apps/web/src/x.ts', ' M apps/worker-tail/src/y.ts', ' M packages/uuidv7/index.ts'),
      SOURCE_DIRS,
    )
    expect(r.modified.length).toBe(3)
  })
})

/**
 * The real script against real git. Everything above only proves the parser
 * agrees with my idea of the format.
 */
describe('the script against a real repository', () => {
  let dir: string
  const SCRIPT = path.resolve(__dirname, '../../../../../scripts/verify-tree-matches-commit.mjs')

  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const run = (env: Record<string, string> = {}) =>
    spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tree-check-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    mkdirSync(path.join(dir, 'apps/worker/src'), { recursive: true })
    writeFileSync(path.join(dir, 'apps/worker/src/a.ts'), 'export const a = 1\n')
    git('add', 'apps/worker/src/a.ts')
    git('commit', '-qm', 'first')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // The positive control comes first. A check that only ever fails proves
  // nothing about the case it is supposed to allow (L159).
  it('passes on a clean tree, by exit code', () => {
    const res = run()
    expect(res.status).toBe(0)
  })

  it('fails when a tracked file is modified and not committed', () => {
    writeFileSync(path.join(dir, 'apps/worker/src/a.ts'), 'export const a = 2\n')
    const res = run()

    // Judged by the exit code, never by the output, which is the same trap that
    // hid the original failure (L184).
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}${res.stderr}`).toContain('apps/worker/src/a.ts')

    git('checkout', '--', 'apps/worker/src/a.ts')
    expect(run().status).toBe(0)
  })

  // The incident itself, reproduced: stage a rename, fix the import afterwards,
  // and leave the fix uncommitted.
  it('fails on the rename-then-fix-the-import shape from PR #888', () => {
    git('mv', 'apps/worker/src/a.ts', 'apps/worker/src/b.ts')
    writeFileSync(path.join(dir, 'apps/worker/src/b.ts'), 'export const b = 1\n')

    const res = run()
    expect(res.status).not.toBe(0)

    git('add', 'apps/worker/src/b.ts')
    git('commit', '-qm', 'rename')
    expect(run().status).toBe(0)
  })

  it('fails on an untracked file inside a source directory', () => {
    writeFileSync(path.join(dir, 'apps/worker/src/never-added.ts'), 'export const c = 1\n')
    expect(run().status).not.toBe(0)
    rmSync(path.join(dir, 'apps/worker/src/never-added.ts'))
    expect(run().status).toBe(0)
  })

  it('passes with an untracked file outside the source directories', () => {
    writeFileSync(path.join(dir, 'scratch-notes.txt'), 'hello\n')
    expect(run().status).toBe(0)
    rmSync(path.join(dir, 'scratch-notes.txt'))
  })

  // The override exists for the same one-off reason the other gates have one,
  // and it has to actually work or somebody reaches for --no-verify instead,
  // which skips every gate rather than this one.
  it('can be skipped deliberately', () => {
    writeFileSync(path.join(dir, 'apps/worker/src/b.ts'), 'export const b = 99\n')
    expect(run().status).not.toBe(0)
    expect(run({ SKIP_TREE_CHECK: '1' }).status).toBe(0)
    git('checkout', '--', 'apps/worker/src/b.ts')
  })
})
