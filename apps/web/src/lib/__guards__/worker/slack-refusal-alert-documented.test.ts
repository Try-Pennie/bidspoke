/**
 * The Better Stack alert for Slack refusing alert posts is recorded with the
 * line it matches on (#2364).
 *
 * The alert lives in Better Stack, created by hand after the merge, and matches
 * on the exact text of SLACK_REFUSED_LINE. docs/reference/observability.md is
 * where the person creating it reads that text from, so the doc must carry the
 * line the Worker sends, word for word, and the alert's name, or the alert
 * matches nothing and the first anyone hears of it is the next three day
 * outage. The doc also used to say that when Slack refuses every post no page
 * can be heard, which this check makes untrue.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const SOURCE = readFileSync(path.join(WORKER_SRC, 'lib/slack-refusal-watch.ts'), 'utf8')
const DOC = readFileSync(path.join(REPO_ROOT, 'docs/reference/observability.md'), 'utf8')

function constant(name: string): string {
  const m = SOURCE.match(new RegExp(`export const ${name} = '([^']+)'`))
  expect(m, `${name} is no longer a single quoted string constant in slack-refusal-watch.ts`).not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

describe('the Slack refusal alert is documented as the code sends it', () => {
  it('the doc carries the exact line the alert matches on', () => {
    expect(DOC).toContain(constant('SLACK_REFUSED_LINE'))
  })

  it('the doc names the alert the code names', () => {
    expect(DOC).toContain(constant('SLACK_REFUSING_ALERT_NAME'))
  })

  it('the doc no longer says a Slack outage of every post cannot be heard', () => {
    expect(DOC).not.toContain('no Slack page can be heard, this one included')
  })
})
