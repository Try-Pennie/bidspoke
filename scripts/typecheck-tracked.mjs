// Project-wide typecheck that only FAILS on errors in git-tracked files.
//
// The husky pre-commit/pre-push hooks used to run `pnpm typecheck` over the
// whole tree, so an untracked work-in-progress file from a parallel session
// could block commits of unrelated, clean work (hit 2026-06-10: an uncommitted
// test file failed tsc and forced --no-verify on a clean commit). Per-file tsc
// would lose project context, so instead: run the full per-package tsc, parse
// its error lines, and partition by tracked-ness. Errors in tracked files
// fail the hook; errors in untracked files are printed as warnings (CI never
// sees untracked files, so they can't break the build either way).
//
// Note an important non-loophole: if a TRACKED file imports an untracked one,
// the tracked file gets its own resolution/type errors and still blocks —
// which is right, because CI wouldn't have the untracked file at all.

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['apps/web', 'apps/worker', 'apps/worker-tail']

// tsc error lines look like: `src/lib/foo.ts(12,3): error TS2345: ...`
const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\): error TS/

/**
 * Partition tsc output lines into errors in tracked files vs untracked files.
 * Pure, for tests. `pkgDir` is the cwd tsc ran in (paths in the output are
 * relative to it); `tracked` holds repo-relative paths.
 */
export function partitionTscErrors(outputLines, pkgDir, tracked) {
  const trackedErrors = []
  const untrackedErrors = []
  for (const line of outputLines) {
    const m = line.match(TSC_ERROR_RE)
    if (!m) continue
    const repoRel = path.posix.normalize(path.posix.join(pkgDir, m[1].replaceAll('\\', '/')))
    if (tracked.has(repoRel)) trackedErrors.push(line)
    else untrackedErrors.push(`${pkgDir}: ${line}`)
  }
  return { trackedErrors, untrackedErrors }
}

function main() {
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  )

  let failed = false
  const allUntracked = []
  for (const pkg of PACKAGES) {
    const res = spawnSync('npx', ['tsc', '--noEmit'], {
      cwd: path.join(ROOT, pkg),
      encoding: 'utf8',
    })
    const lines = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.split('\n')
    const { trackedErrors, untrackedErrors } = partitionTscErrors(lines, pkg, tracked)
    allUntracked.push(...untrackedErrors)
    if (trackedErrors.length > 0) {
      failed = true
      console.error(`\n${pkg}: ${trackedErrors.length} type error(s) in tracked files:`)
      for (const line of trackedErrors) console.error(`  ${line}`)
    } else if (res.status !== 0 && untrackedErrors.length === 0) {
      // tsc failed without any parseable per-file error (config problem,
      // crash). Don't silently pass — surface the raw output.
      failed = true
      console.error(`\n${pkg}: tsc exited ${res.status} with no per-file errors:`)
      console.error(res.stdout)
      console.error(res.stderr)
    }
  }

  if (allUntracked.length > 0) {
    console.warn(`\nIgnored ${allUntracked.length} type error(s) in untracked files (not blocking; CI never sees them):`)
    for (const line of allUntracked) console.warn(`  ${line}`)
  }

  if (failed) process.exit(1)
  console.log('Typecheck passed for all tracked files.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
