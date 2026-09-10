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
 * The one job that still opens its own record, and why.
 *
 * `execution-archive` closes its record in a `finally` that ALSO releases the
 * run lock, in that order, and the order is deliberate: the record is closed
 * while the lock is still held. Moving it into the wrapper would invert that,
 * because an inner `finally` runs before an outer one, and this is the job that
 * matters most. So it is exempt for a stated reason rather than because nobody
 * looked (L233), it is checked below against the rule the wrapper exists to
 * enforce rather than merely excused, and #1277 tracks converting it.
 */
const EXEMPT = path.join(WORKER_SRC, 'lib/execution-archive.ts')

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

  it('has only the wrapper and the one stated exception calling the opener directly', () => {
    const callers = workerSources().filter((f) => readFileSync(f, 'utf8').includes(`${OPENER}(`))

    expect(
      callers.map((f) => path.relative(REPO_ROOT, f)).sort(),
      'only the wrapper may open a run record; every job uses the wrapper so the ending cannot be left off the failure path',
    ).toEqual([OWNER, EXEMPT].map((f) => path.relative(REPO_ROOT, f)).sort())
  })

  it('holds the exempt job to the rule the wrapper exists to enforce', () => {
    // An exemption that stops checking anything is just a hole. This one still
    // has to close its record in a `finally`, which is the whole property.
    const source = readFileSync(EXEMPT, 'utf8')
    const finallyBlock = source.slice(source.lastIndexOf('} finally {'))
    expect(finallyBlock, 'the exempt job must still close its record in a finally').toContain('finishJobRun(')
  })

  it('has all four archive jobs going through the wrapper', () => {
    // Named individually rather than counted, because a count passes when one
    // job is swapped for another (L63).
    const expected = [
      'lib/archive-gate.ts',
      'lib/archive-settings-check.ts',
      'lib/archive-identity-check.ts',
      'lib/archive-backlog-run.ts',
    ]
    for (const rel of expected) {
      const source = readFileSync(path.join(WORKER_SRC, rel), 'utf8')
      expect(source, `${rel} does not record its runs`).toContain(`${WRAPPER}(`)
    }
  })
})
