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

  it('the disaster recovery runbook names the same alert', () => {
    const DR = readFileSync(path.join(REPO_ROOT, 'docs/disaster-recovery.md'), 'utf8')
    expect(DR).toContain(constant('BETTER_STACK_ALERT_NAME'))
  })

  it('the doc says how to prove the page works, by the drill route the worker serves (#1303)', () => {
    const ADMIN = readFileSync(path.join(WORKER_SRC, 'routes/api/admin.ts'), 'utf8')
    expect(ADMIN, 'the drill route is no longer in routes/api/admin.ts').toContain("admin.post('/nobody-told-page/drill'")
    expect(DOC).toContain('POST /api/admin/nobody-told-page/drill')
  })
})

/**
 * The drill exists to prove the real page's request reaches Better Stack, so it
 * must make THAT request, not a copy of it that could drift (#1303). The module
 * therefore holds one POST, which the page and the drill both go through.
 */
describe('the drill and the real page share one send', () => {
  it('nobody-told-page.ts makes exactly one POST', () => {
    expect(SOURCE.match(/method: 'POST'/g) ?? []).toHaveLength(1)
  })
})
