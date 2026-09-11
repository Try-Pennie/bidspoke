/**
 * Every archive job opens its run record through the one wrapper (#1251).
 *
 * The record exists to tell a run the platform KILLED from a run that had
 * nothing to do, and that distinction rests entirely on the ending being
 * written in a `finally`. Hand written at each site, that is one chance per
 * site to put the close on the success path instead, and the site that gets it
 * wrong is silent: it simply reports nothing, which is what a killed run looks
 * like.
 *
 * So the wrapper is the only caller of `startJobRun`, and this fails on the
 * next hand rolled copy rather than leaving the rule in a comment (L27, L613).
 */
import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT } from '../../__tests__/_scan-utils'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const WORKER_SRC = path.join(REPO_ROOT, 'apps/worker/src')
// Assembled, so this file does not itself contain the name it searches for.
const OPENER = ['start', 'Job', 'Run'].join('')
const WRAPPER = ['with', 'Job', 'Run'].join('')

/** Where the wrapper itself lives, and is allowed to call the opener. */
const OWNER = path.join(WORKER_SRC, 'lib/job-run-record.ts')

/**
 * `execution-archive` was the one stated exception until #1277 converted it.
 *
 * It was exempt because its `finally` closes the record and then releases the
 * run lock, in that order, and the reasoning was that moving the close into the
 * wrapper would invert it. It does not: putting the wrapper INSIDE the try whose
 * finally releases the lock keeps the order, because an inner finally runs
 * first.
 *
 * That ordering is guarded, but NOT here. The worker's
 * `archive-record-closes-before-lock.test.ts` drives a real run and asserts the
 * order the two writes reach the outside world, which a source scan cannot see:
 * the nesting can be rearranged without any of the words in this file changing,
 * and a scan keyed on how the call happens to be wrapped across lines breaks on
 * the first reformat while proving nothing (L103).
 */

function workerSources(): string[] {
  return listFiles(WORKER_SRC)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.includes('__tests__'))
}

describe('archive run records go through one wrapper', () => {
  it('scans a real body of worker source, so a miss cannot read as a pass', () => {
    // A file list that resolves to nothing reports zero offenders and looks
    // clean (L98).
    const files = workerSources()
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f === OWNER)).toBe(true)
  })

  it('has only the wrapper calling the opener directly', () => {
    const callers = workerSources().filter((f) => readFileSync(f, 'utf8').includes(`${OPENER}(`))

    expect(
      callers.map((f) => path.relative(REPO_ROOT, f)).sort(),
      'only the wrapper may open a run record; every job uses the wrapper so the ending cannot be left off the failure path',
    ).toEqual([path.relative(REPO_ROOT, OWNER)])
  })

  it('has all five archive jobs going through the wrapper', () => {
    // Named individually rather than counted, because a count passes when one
    // job is swapped for another (L63).
    const expected = [
      'lib/archive-gate.ts',
      'lib/archive-settings-check.ts',
      'lib/archive-identity-check.ts',
      'lib/archive-backlog-run.ts',
      'lib/execution-archive.ts',
    ]
    for (const rel of expected) {
      const source = readFileSync(path.join(WORKER_SRC, rel), 'utf8')
      expect(source, `${rel} does not record its runs`).toContain(`${WRAPPER}(`)
    }
  })
})
