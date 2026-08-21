// Pre-push check: what is committed must match what the tests ran on (#889).
//
// Local checks read the WORKING TREE. CI reads the COMMIT. When they diverge,
// every local signal is green and the pull request is broken, and no amount of
// local testing can see it, because every local tool is on the wrong side of the
// divergence. The test gate and the placement guard cannot catch this either:
// they run against the working tree too.
//
// The case it was written for, PR #888 on 2026-08-19: a file was renamed and its
// import fixed in the tree, but the `git add` listed the file's old pre-rename
// path alongside the new one. Git rejects the WHOLE command when any path is bad,
// so it staged nothing, stderr was sent to /dev/null and the exit code was never
// checked. The commit kept the stale import, and two CI jobs failed on it while
// the full local suite passed.
//
// Three states are refused, and each is named separately, because the remedy
// differs and a single "tree is dirty" message would leave the reader guessing:
//
//   modified            a tracked file changed in the tree and not staged. The
//                       suite ran on this content; the commit does not have it.
//   stagedNotCommitted  staged, so it LOOKS handled, but no commit contains it.
//                       This is the PR #888 shape.
//   untrackedSource     a new file under a source directory that was never
//                       added. The suite imported it; CI will not have it at
//                       all. A new test fixture that was never staged is exactly
//                       this.
//
// Untracked files OUTSIDE the source directories are deliberately allowed. They
// cannot change a test result, and refusing them would make this a gate nobody
// can get past (scratch files, editor droppings, supabase/.temp), which ends in
// somebody using --no-verify and skipping every gate rather than this one.
//
// Skip for one push with SKIP_TREE_CHECK=1, the same one-off escape the test and
// style gates have. Explain it rather than using it silently.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Directories whose contents can change what a local test run reports. Anything
 * a test runner collects or a package imports.
 */
export const SOURCE_DIRS = ['apps/web/src', 'apps/worker/src', 'apps/worker-tail/src', 'packages/']

/**
 * Classify `git status --porcelain -z` output. Pure, for tests.
 *
 * `-z` matters: under it a rename arrives as two NUL-separated fields rather
 * than the `old -> new` form, so a parser written for the human-readable output
 * silently mis-reads the very operation that produced the incident.
 */
export function classifyTreeState(porcelainZ, sourceDirs = SOURCE_DIRS) {
  const fields = porcelainZ.split('\0').filter((f) => f.length > 0)
  const modified = []
  const stagedNotCommitted = []
  const untrackedSource = []

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    // 'XY path', so the status is the first two characters and the path starts
    // at index 3. Paths may contain spaces, so never split on whitespace.
    const index = entry[0]
    const worktree = entry[1]
    const filePath = entry.slice(3)
    if (!filePath) continue

    if (index === '?' && worktree === '?') {
      if (sourceDirs.some((d) => filePath.startsWith(d))) untrackedSource.push(filePath)
      continue
    }

    // A rename or copy carries its ORIGIN as the next field. Consume it so the
    // origin path is never mistaken for an entry of its own.
    if (index === 'R' || index === 'C') i++

    if (index !== ' ' && index !== '?') stagedNotCommitted.push(filePath)
    if (worktree !== ' ' && worktree !== '?') modified.push(filePath)
  }

  return {
    modified,
    stagedNotCommitted,
    untrackedSource,
    clean: modified.length === 0 && stagedNotCommitted.length === 0 && untrackedSource.length === 0,
  }
}

function report(label, why, files) {
  if (files.length === 0) return
  console.error(`\n  ${label}`)
  console.error(`  ${why}`)
  for (const f of files) console.error(`    ${f}`)
}

function main() {
  if (process.env.SKIP_TREE_CHECK) {
    console.log('Tree check skipped (SKIP_TREE_CHECK is set).')
    return
  }

  const porcelain = execFileSync('git', ['status', '--porcelain', '-z'], { encoding: 'utf8' })
  const state = classifyTreeState(porcelain)

  if (state.clean) {
    console.log('Working tree matches the commit; local results describe what CI will read.')
    return
  }

  console.error('\nPUSH BLOCKED: the working tree does not match what is committed.')
  console.error('Local tests read the tree, CI reads the commit, so the green run you just')
  console.error('saw does not describe the code being pushed.')

  report(
    'Modified and not staged:',
    'the suite ran on this content and no commit contains it.',
    state.modified,
  )
  report(
    'Staged but not committed:',
    'it looks handled, but the commit CI reads does not have it.',
    state.stagedNotCommitted,
  )
  report(
    'Untracked, inside a source directory:',
    'the suite could import this locally and CI will not have the file at all.',
    state.untrackedSource,
  )

  console.error('\nCommit them, stash them, or if this is genuinely intended, re-run with:')
  console.error('    SKIP_TREE_CHECK=1 <your original git push command>')
  console.error('Explain to the user why skipping is legitimate before overriding.\n')
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
