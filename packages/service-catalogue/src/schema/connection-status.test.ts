import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONNECTION_PAGE_STATUSES, CONNECTION_STATUS_WORDS, isConnectionProblem } from '.'

/**
 * The page's one status vocabulary (#2338, R3, D3): three statuses and their
 * words, held to the settled design's own list, so the list route, the
 * Connections page and the step form's Connection field all read one set of
 * words (L605).
 */
const SRC = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(path.resolve(SRC, '../../../..'), 'docs/design/connections-page.fixture.json')

describe('the connection status vocabulary', () => {
  const settled = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { statusVocabulary: Record<string, string> }).statusVocabulary

  it("is the settled design's statusVocabulary, key for key and word for word", () => {
    expect(CONNECTION_STATUS_WORDS).toEqual(settled)
    expect([...CONNECTION_PAGE_STATUSES].sort()).toEqual(Object.keys(settled).sort())
  })

  it('reads the real fixture, so the comparison above is not over an empty list', () => {
    expect(Object.keys(settled)).toHaveLength(3)
  })

  it('counts every status but Working as a problem, which is what the Needs attention group holds', () => {
    expect(CONNECTION_PAGE_STATUSES.filter(isConnectionProblem)).toEqual(['reauth', 'failing'])
  })
})
