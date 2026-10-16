/**
 * The Better Stack alert for "nobody can be told" is recorded with the line it
 * matches on (#2063).
 *
 * The alert lives in Better Stack, created by hand, and matches on the exact text
 * of NOBODY_TOLD_LINE. docs/reference/observability.md is where the person
 * creating or fixing that alert reads the text from, so the doc must carry the
 * line the worker sends, word for word, and name the alert the code names. A
 * wording change in one place only would leave the alert matching nothing, with
 * nothing to say so until an outage nobody hears about.
 *
 * It reads worker source, so it lives here rather than in the worker's own tests.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const SOURCE = readFileSync(path.join(WORKER_SRC, 'lib/nobody-told-page.ts'), 'utf8')
const DOC = readFileSync(path.join(REPO_ROOT, 'docs/reference/observability.md'), 'utf8')

function constant(name: string): string {
  const m = SOURCE.match(new RegExp(`export const ${name} = '([^']+)'`))
  expect(m, `${name} is no longer a single quoted string constant in nobody-told-page.ts`).not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

describe('the nobody can be told alert is documented as the code sends it', () => {
  it('the doc carries the exact line the alert matches on', () => {
    expect(DOC).toContain(constant('NOBODY_TOLD_LINE'))
  })

  it('the doc names the alert the code names', () => {
    expect(DOC).toContain(constant('BETTER_STACK_ALERT_NAME'))
  })
})
