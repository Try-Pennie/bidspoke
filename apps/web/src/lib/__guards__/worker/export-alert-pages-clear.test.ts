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
 * Pages that are a point-in-time STATEMENT, not a standing condition, so they
 * are deliberately never cleared. `archive/alerts.ts` documents why the killed
 * takeover is one: it reports that a replacement invocation recovered a dead
 * predecessor's lock, which is a fact about an invocation that is already over,
 * not a state the archive is in, so a later healthy run is not evidence about
 * it. Anything added here needs that same justification in its source.
 */
const POINT_IN_TIME_EXEMPT = new Set<string>(['ARCHIVE_JOB_NAMES.killed'])

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
    const neverCleared = [...pagedWithLiteral].filter(
      (job) => !cleared.has(job) && !POINT_IN_TIME_EXEMPT.has(job),
    )
    expect(neverCleared).toEqual([])
  })

  it('still flags the exempt point-in-time pages as never cleared, so the exemption is doing work', () => {
    // If one of these ever gained a clear path, or stopped being paged, the
    // exemption would be stale. Keeping it honest: every exempt job must actually
    // be a paged-with-literal, never-cleared job, or the list is lying (L129).
    const { pagedWithLiteral, cleared } = scan()
    for (const job of POINT_IN_TIME_EXEMPT) {
      expect(pagedWithLiteral.has(job), `${job} is exempt but no longer paged with a literal`).toBe(true)
      expect(cleared.has(job), `${job} is exempt but now has a clear path, so drop the exemption`).toBe(false)
    }
  })
})
