/**
 * The Better Stack alert for a read stopped at the row cap is recorded with the
 * line it matches on (#1436).
 *
 * The alert lives in Better Stack, created by hand, and matches on the exact
 * text of ROW_CAP_LINE. docs/reference/observability.md is where the person
 * creating or fixing it reads the text from, so the doc must carry the line the
 * worker sends, word for word, and the error code a failed scheduled read
 * carries. A wording change in one place only would leave the alert matching
 * nothing, with nothing to say so.
 *
 * It reads worker source, so it lives here rather than in the worker's own tests.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const SOURCE = readFileSync(path.join(WORKER_SRC, 'lib/row-cap.ts'), 'utf8')
const DOC = readFileSync(path.join(REPO_ROOT, 'docs/reference/observability.md'), 'utf8')

function constant(name: string): string {
  const m = SOURCE.match(new RegExp(`export const ${name} = '([^']+)'`))
  expect(m, `${name} is no longer a single quoted string constant in row-cap.ts`).not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

describe('the row cap alert is documented as the code sends it', () => {
  it('the doc carries the exact line the alert matches on', () => {
    expect(DOC).toContain(constant('ROW_CAP_LINE'))
  })

  it('the doc carries the error code a scheduled read fails with', () => {
    expect(DOC).toContain(constant('ROW_CAP_ERROR_CODE'))
  })
})
