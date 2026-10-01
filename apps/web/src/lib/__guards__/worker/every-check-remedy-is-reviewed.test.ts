/**
 * Every alert remedy the worker declares must be listed in the worker test that
 * reads its wording (2026-09-10).
 *
 * A scheduled check that borrows the shared export alerter now has to supply its
 * own wording, which `tsc` enforces because the argument is required. What the
 * type cannot see is whether the wording a check supplies is itself export
 * wording. `check-remedies-say-what-they-measured.test.ts` in the worker asserts
 * that, over a list written by hand, on purpose: the point is that a person read
 * each sentence.
 *
 * A list maintained beside the thing it mirrors is exempt from itself, so a new
 * remedy would simply not be checked (L41, L96). This closes that: it reads the
 * worker source for every declared remedy and fails when one is not named in
 * that file.
 *
 * It reads worker source, so it lives here rather than in `lib/__tests__/`,
 * which `worker-guards-placement.test.ts` enforces.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const SOURCE_DIRS = ['apps/worker/src/lib', 'apps/worker/src/archive']
const REVIEW_FILE = path.join(
  REPO_ROOT,
  'apps/worker/src/lib/__tests__/check-remedies-say-what-they-measured.test.ts',
)

function declaredRemedies(): string[] {
  const found: string[] = []
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(path.join(REPO_ROOT, dir))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const src = readFileSync(path.join(REPO_ROOT, dir, file), 'utf8')
      for (const m of src.matchAll(/export const ([A-Z0-9_]*REMEDY)\s*:\s*(?:AlertRemedy|TitledRemedy)\b/g)) {
        found.push(m[1])
      }
    }
  }
  return found
}

describe('every check remedy is reviewed', () => {
  it('finds the remedies at all, so an empty scan cannot read as full coverage', () => {
    // A scan that matched nothing would report every remedy as reviewed, which
    // is the same answer as a repo with no remedies in it (L98).
    expect(declaredRemedies().length).toBeGreaterThanOrEqual(14)
  })

  it('names every declared remedy in the worker review test', () => {
    const review = readFileSync(REVIEW_FILE, 'utf8')
    const missing = declaredRemedies().filter((name) => !review.includes(name))
    expect(missing).toEqual([])
  })
})
