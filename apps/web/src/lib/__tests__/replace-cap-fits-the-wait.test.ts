/**
 * A Replace's cap is sized to the page's wait (#2338, Dan 2026-10-27): the
 * route allows only as many workflows as its slowest measured run can move
 * before the page's line would say it stalled. The page and the route each
 * hold the two numbers, since the web build never imports the Worker, so this
 * holds them equal: a longer route cap, or a shorter page wait, would let the
 * stalled line show while the route is still writing.
 */
import { describe, expect, it } from 'vitest'
import { CONNECTION_REPLACE_MOST, CONNECTION_REPLACE_TIMEOUT_MS } from '../api'
import { REPLACE_CLIENT_WAIT_MS, REPLACE_WORKFLOWS_MAX } from '../../../../worker/src/lib/connection-replace'

describe("a Replace's cap fits the page's wait", () => {
  it("the route sizes its cap to the page's own wait", () => {
    expect(REPLACE_CLIENT_WAIT_MS).toBe(CONNECTION_REPLACE_TIMEOUT_MS)
  })

  it('the dialog offers no more workflows than the route allows', () => {
    expect(CONNECTION_REPLACE_MOST).toBe(REPLACE_WORKFLOWS_MAX)
  })
})
