/**
 * The archive path never interpolates a value into its SQL (#1006).
 *
 * `archive-erasure.ts` DELETEs from `execution_archive`, `LEAD_SIGHTINGS` and
 * `LEAD_SIGHTING_BIDS` on a caller-supplied SSN, as the one credential in the
 * account that can destroy archived rows. `archive-gate.ts` reads a day and a
 * list of execution ids. `archive-read.ts` reads an id that arrives from a URL.
 * Every one of them used to build statements by concatenation and defend them
 * with `escapeSqlLiteral`, which was correct and whose correctness rested on
 * every future edit remembering to call it.
 *
 * The values are now bound. This is what stops the concatenation coming back:
 * a rule stated only in a comment is enforced by nothing (L27).
 *
 * ONE FILE IS OUT OF SCOPE, and named rather than quietly omitted.
 * `execution-archive-send.ts` builds a multi-row INSERT whose rows carry around
 * fifteen columns each, so binding it means thousands of placeholders per
 * statement and is a different change with a different risk. #1006 said to
 * start with the paths that DELETE and the ones a caller can reach, which is
 * what this covers. That file writes rows we produced ourselves, and it is
 * listed below as an exception so it cannot be mistaken for a file nobody
 * looked at (L233).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const WORKER_LIB = path.join(REPO_ROOT, 'apps/worker/src/lib')
// Assembled, so this file does not itself contain the name it searches for.
const ESCAPER = ['escape', 'Sql', 'Literal'].join('')

/** Every archive-path file that must bind, each named so none is lost silently. */
const BOUND = ['archive-erasure.ts', 'archive-gate.ts', 'archive-read.ts', 'archive-identity-check.ts']

/** Something each file must contain, so a renamed or emptied file cannot pass. */
const PROOF_OF_LIFE: Record<string, string> = {
  'archive-erasure.ts': 'eraseSubject',
  'archive-gate.ts': 'countsStatement',
  'archive-read.ts': 'readArchivedExecution',
  'archive-identity-check.ts': 'deleteProbeStatement',
}

describe.each(BOUND)('%s binds its values', (file) => {
  const source = readFileSync(path.join(WORKER_LIB, file), 'utf8')

  it('reads the file it means to check', () => {
    // A path that resolves to nothing reports no offenders and looks clean (L98).
    expect(source).toContain(PROOF_OF_LIFE[file])
    expect(source.length).toBeGreaterThan(1000)
  })

  it('does not reach for the escaping helper at all', () => {
    expect(
      source.includes(ESCAPER),
      'this file builds its statements with bindings; escaping a value into the SQL is the class that removed',
    ).toBe(false)
  })

  it('has no quoted interpolation of a value into a statement', () => {
    // The shape that was here: '${...}' inside a template literal.
    const quotedInterpolation = /'\$\{[^}]+\}'/g
    const found = [...source.matchAll(quotedInterpolation)].map((m) => m[0])

    expect(found, 'a value is being quoted into SQL rather than bound').toEqual([])
  })
})

describe('the one file deliberately left interpolating', () => {
  it('is the bulk send, and it still escapes rather than having quietly stopped', () => {
    // An exception is only an exception while the thing it excuses is still
    // true. If this file stopped escaping, it would pass by being broken.
    const send = readFileSync(path.join(WORKER_LIB, 'execution-archive-send.ts'), 'utf8')
    expect(send).toContain('buildInsert')
    expect(send.includes(ESCAPER), 'the send still defends its interpolation with the escaper').toBe(true)
  })
})
