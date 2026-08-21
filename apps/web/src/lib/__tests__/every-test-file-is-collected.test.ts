/**
 * A test file that no runner collects is indistinguishable from one that passes
 * (#890).
 *
 * That is the exact failure the test gate exists to prevent, and nothing checked
 * for it. On 2026-08-19 a guard landed in the wrong directory and was caught
 * only because `worker-guards-placement.test.ts` happens to police that one
 * directory; a test file dropped anywhere else would simply never run, and the
 * suite would report green while covering nothing.
 *
 * The collection is ASKED FOR, not reimplemented. `vitest list --filesOnly` is
 * the runner's own answer to "what would you run", so this cannot drift from the
 * globs, the `projects` config, or the default include and exclude sets, which
 * are all things a reimplementation would have to track (L41). It also means the
 * guard stays correct through a vitest upgrade that changes any of them.
 *
 * Playwright collects a second, deliberately separate population: the repo's
 * playwright config sets `testDir: './e2e'` and narrows `testMatch` to
 * `*.spec.ts`, with a comment saying the default would otherwise grab the
 * `*.test.ts` files in that directory, which are vitest tests ABOUT the e2e
 * setup. Both halves of that split are read from the config here rather than
 * assumed, so a change to either is a change this guard sees.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, workspacePackages } from './_scan-utils'

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.next', '.wrangler', 'coverage', '.turbo'])
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** Every file on disk that LOOKS like a test, relative to the package. */
function testFilesOnDisk(pkgDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
      } else if (TEST_FILE.test(entry.name)) {
        out.push(path.relative(pkgDir, path.join(dir, entry.name)))
      }
    }
  }
  walk(pkgDir)
  return out.sort()
}

/**
 * What vitest says it would run, from the runner itself.
 *
 * The web package prints a `[project]` prefix because its config declares
 * projects, so the same file can appear more than once; the set collapses that.
 */
function vitestCollects(pkgDir: string): Set<string> {
  const bin = path.join(pkgDir, 'node_modules', '.bin', 'vitest')
  const runner = existsSync(bin) ? bin : path.join(REPO_ROOT, 'node_modules', '.bin', 'vitest')
  const stdout = execFileSync(runner, ['list', '--filesOnly'], { cwd: pkgDir, encoding: 'utf8' })

  return new Set(
    stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\[[^\]]+\]\s*/, ''))
      .filter((l) => TEST_FILE.test(l)),
  )
}

/** What the playwright config claims, read from the config rather than assumed. */
function playwrightCollects(pkgDir: string): (file: string) => boolean {
  const config = path.join(pkgDir, 'playwright.config.ts')
  if (!existsSync(config)) return () => false
  const src = readFileSync(config, 'utf8')

  const dir = /testDir:\s*'([^']+)'/.exec(src)?.[1]
  const matches = [...src.matchAll(/testMatch:\s*\/([^/]+)\//g)].map((m) => new RegExp(m[1]))

  // A config this cannot read is a loud failure, not a silent "collects
  // nothing": that would make every Playwright spec look uncollected and bury
  // the real finding in noise.
  expect(dir, `could not read testDir from ${config}`).toBeTruthy()
  expect(matches.length, `could not read any testMatch from ${config}`).toBeGreaterThan(0)

  const root = (dir as string).replace(/^\.\//, '')
  return (file: string) => file.startsWith(`${root}/`) && matches.some((re) => re.test(file))
}

describe('every test file is collected by some runner', () => {
  const packages = workspacePackages().filter((p) =>
    ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'].some((c) => existsSync(path.join(p.dir, c))),
  )

  it('finds packages that run vitest, so it is asserting something', () => {
    // An enumeration that returns nothing reports a clean pass while blind,
    // which is the same failure this guard exists to catch (L98).
    expect(packages.length).toBeGreaterThan(0)
  })

  for (const pkg of packages) {
    const who = pkg.name ?? path.relative(REPO_ROOT, pkg.dir)

    it(`${who} collects every test file it holds`, () => {
      const onDisk = testFilesOnDisk(pkg.dir)
      expect(onDisk.length, `${who} appears to hold no test files at all`).toBeGreaterThan(0)

      const collected = vitestCollects(pkg.dir)
      const byPlaywright = playwrightCollects(pkg.dir)
      const orphaned = onDisk.filter((f) => !collected.has(f) && !byPlaywright(f))

      expect(
        orphaned,
        `these files look like tests but no runner collects them, so they never run and their absence ` +
          `is indistinguishable from passing:\n  ${orphaned.join('\n  ')}`,
      ).toEqual([])
    })
  }
})
