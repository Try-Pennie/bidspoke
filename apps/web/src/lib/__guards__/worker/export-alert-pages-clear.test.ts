/**
 * Every dedicated export-alert page has a path that CLEARS it (#1967).
 *
 * A check pages through `notifyExportFailure(supabase, JOB, errors, ...)` with a
 * non-empty `errors`, which writes a standing condition at
 * `export-alert:<JOB>:condition`. It stands down only when something calls a
 * clear path for the same JOB: `notifyExportFailure(..., JOB, [], ...)` (empty
 * errors), `notifyExportFailure(..., JOB, <variable>, ...)` (the variable is
 * empty on a healthy run), or `notifyExportRecovery(..., JOB)`.
 *
 * archive-backlog-run.ts paged `ARCHIVE_BACKLOG_JOB` with a hardcoded `[message]`
 * from one call site and had NO clear path anywhere, so a day set aside once left
 * a standing page until the 30-day condition TTL and never recovered. This guards
 * that class: a JOB paged with a NON-EMPTY ARRAY LITERAL (the dedicated
 * single-purpose alert shape, where the array cannot be empty on a healthy run)
 * must also have a clear path. A check that pages with a variable is not flagged,
 * because its variable goes empty on a healthy run and that IS its clear path.
 *
 * It reads worker source, so it lives here, which `worker-guards-placement.test.ts`
 * enforces.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const WORKER_SRC = 'apps/worker/src'
const SOURCE_DIRS = [`${WORKER_SRC}/lib`, `${WORKER_SRC}/archive`]
const EXTRA_FILES = [`${WORKER_SRC}/index.ts`]

/**
 * Every dedicated literal-array page now has a clear path, so there is no
 * exemption. `ARCHIVE_JOB_NAMES.killed` was the last one: it is still a
 * point-in-time statement about a dead invocation, but #1784 clears its standing
 * record at lock acquisition (a clean take is evidence no predecessor was killed
 * this cycle) so a later kill posts as a fresh incident rather than a stale
 * "(still)". A genuinely never-cleared page in future re-introduces an exemption
 * here with its justification, in the same change (L129).
 */

function workerSourceFiles(): string[] {
  const files: string[] = []
  for (const dir of SOURCE_DIRS) {
    for (const name of readdirSync(path.join(REPO_ROOT, dir))) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      files.push(path.join(REPO_ROOT, dir, name))
    }
  }
  for (const f of EXTRA_FILES) files.push(path.join(REPO_ROOT, f))
  return files
}

// jobName (group 1) and its errors argument (group 2: an array literal or an
// identifier) from the first three args of a notifyExportFailure call. Tolerant
// of line breaks between the args.
const FAILURE_CALL = /notifyExportFailure\(\s*[\w.]+\s*,\s*([\w.]+)\s*,\s*(\[[^\]]*\]|[\w.]+)/g
// jobName (group 1) from a notifyExportRecovery call.
const RECOVERY_CALL = /notifyExportRecovery\(\s*[\w.]+\s*,\s*([\w.]+)/g

interface Scan {
  pagedWithLiteral: Set<string>
  cleared: Set<string>
}

function scan(): Scan {
  const pagedWithLiteral = new Set<string>()
  const cleared = new Set<string>()
  for (const file of workerSourceFiles()) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(FAILURE_CALL)) {
      const job = m[1]
      const errors = m[2].trim()
      const isArrayLiteral = errors.startsWith('[')
      const isEmptyArray = /^\[\s*\]$/.test(errors)
      if (isArrayLiteral && !isEmptyArray) {
        pagedWithLiteral.add(job)
      } else {
        // An empty-array literal, or a variable (which is empty on a healthy run),
        // is this JOB's clear path.
        cleared.add(job)
      }
    }
    for (const m of src.matchAll(RECOVERY_CALL)) cleared.add(m[1])
  }
  return { pagedWithLiteral, cleared }
}

describe('every dedicated export-alert page has a clear path (#1967)', () => {
  it('finds dedicated literal-array alerts at all, so an empty scan cannot read as full coverage', () => {
    // A scan that matched nothing would report every page as cleared, which is the
    // same answer as a repo with no dedicated alerts in it (L98).
    expect(scan().pagedWithLiteral.size).toBeGreaterThanOrEqual(3)
  })

  it('every job paged with a non-empty array literal also has a clear path', () => {
    const { pagedWithLiteral, cleared } = scan()
    const neverCleared = [...pagedWithLiteral].filter((job) => !cleared.has(job))
    expect(neverCleared).toEqual([])
  })

  it('counts the killed takeover as a page that now has a clear path (#1784)', () => {
    // The last point-in-time exemption. It is still paged with a literal, and
    // since #1784 it is also cleared (at lock acquisition), so it belongs to the
    // main guard above rather than to an exemption list.
    const { pagedWithLiteral, cleared } = scan()
    expect(pagedWithLiteral.has('ARCHIVE_JOB_NAMES.killed')).toBe(true)
    expect(cleared.has('ARCHIVE_JOB_NAMES.killed')).toBe(true)
  })
})
