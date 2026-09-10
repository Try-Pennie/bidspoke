/**
 * The erasure path never interpolates a value into its SQL (#1006).
 *
 * `archive-erasure.ts` DELETEs from `execution_archive`, `LEAD_SIGHTINGS` and
 * `LEAD_SIGHTING_BIDS` on a caller-supplied SSN, as the one credential in the
 * account that can destroy archived rows. It used to build those statements by
 * concatenation and defend them with `escapeSqlLiteral`, which was correct and
 * whose correctness rested on every future edit remembering to call it.
 *
 * The values are now bound. This is what stops the concatenation coming back:
 * a rule stated only in a comment is enforced by nothing (L27), and the file
 * that matters most is the one where a quiet regression is worst.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const ERASURE = path.join(REPO_ROOT, 'apps/worker/src/lib/archive-erasure.ts')
// Assembled, so this file does not itself contain the name it searches for.
const ESCAPER = ['escape', 'Sql', 'Literal'].join('')

describe('the erasure binds its values', () => {
  const source = readFileSync(ERASURE, 'utf8')

  it('reads the file it means to check', () => {
    // A path that resolves to nothing reports no offenders and looks clean (L98).
    expect(source).toContain('eraseSubject')
    expect(source.length).toBeGreaterThan(1000)
  })

  it('does not reach for the escaping helper at all', () => {
    expect(
      source.includes(ESCAPER),
      'the erasure builds its statements with bindings; escaping a value into the SQL is the class this removed',
    ).toBe(false)
  })

  it('has no quoted interpolation of a value into a statement', () => {
    // The shape that was here: '${...}' inside a template literal.
    const quotedInterpolation = /'\$\{[^}]+\}'/g
    const found = [...source.matchAll(quotedInterpolation)].map((m) => m[0])

    expect(found, 'a value is being quoted into SQL rather than bound').toEqual([])
  })
})
