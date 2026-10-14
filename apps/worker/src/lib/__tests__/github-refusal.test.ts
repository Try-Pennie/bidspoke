import { describe, expect, it } from 'vitest'
import { describeGithubRefusal, readGithubRefusal, GITHUB_RATE_LIMIT_FIX } from '../github-refusal'

// #835: the fix named only GITHUB_ACTIONS_TOKEN, while the checks fall back to
// GITHUB_TOKEN when it is unset, and called the allowance hourly, which a
// secondary limit is not.
describe('the rate limit fix line', () => {
  it('names both tokens the checks can be using, and no hourly allowance', () => {
    expect(GITHUB_RATE_LIMIT_FIX).toContain('GITHUB_ACTIONS_TOKEN')
    expect(GITHUB_RATE_LIMIT_FIX).toMatch(/GITHUB_TOKEN`? when/)
    expect(GITHUB_RATE_LIMIT_FIX).not.toMatch(/hourly/)
  })
})

/**
 * Telling GitHub's refusals apart (#1365).
 *
 * GitHub answers 403 for two unrelated causes: the account that owns the
 * credential has used up its request allowance, which clears on its own within
 * the hour, and the credential lacking a permission, which needs a person to fix
 * it. The response says which, in its rate limit headers and its JSON message.
 * On 2026-09-16 the checks threw that away and told the reader to replace a
 * credential that had worked an hour earlier (L11).
 *
 * The bodies below are GitHub's documented shapes for each refusal.
 */
const NOW = Date.parse('2026-09-16T20:00:00Z')
const RESET_ISO = '2026-09-16T21:07:08.000Z'
const RESET_EPOCH = String(Date.parse(RESET_ISO) / 1000)

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const PRIMARY_LIMIT = {
  message: 'API rate limit exceeded for user ID 1234567.',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api',
  status: '403',
}
const SECONDARY_LIMIT = {
  message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
  status: '403',
}
const NOT_PERMITTED = {
  message: 'Resource not accessible by personal access token',
  documentation_url: 'https://docs.github.com/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow',
  status: '403',
}

describe('readGithubRefusal: which refusal GitHub gave', () => {
  it('reads an exhausted primary limit from the headers, with when it resets', async () => {
    const refusal = await readGithubRefusal(
      json(PRIMARY_LIMIT, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': RESET_EPOCH }),
      NOW,
    )
    expect(refusal).toEqual({ kind: 'rate_limited', status: 403, resetsAtIso: RESET_ISO, message: PRIMARY_LIMIT.message })
  })

  it('reads a secondary limit from retry-after, which carries no remaining count', async () => {
    const refusal = await readGithubRefusal(json(SECONDARY_LIMIT, 403, { 'retry-after': '60' }), NOW)
    expect(refusal).toEqual({
      kind: 'rate_limited',
      status: 403,
      resetsAtIso: '2026-09-16T20:01:00.000Z',
      message: SECONDARY_LIMIT.message,
    })
  })

  it('recognises a limit from the message alone when a proxy stripped the headers', async () => {
    const refusal = await readGithubRefusal(json(PRIMARY_LIMIT, 403), NOW)
    expect(refusal).toEqual({ kind: 'rate_limited', status: 403, resetsAtIso: null, message: PRIMARY_LIMIT.message })
  })

  it('treats a 429 as a limit whatever it says', async () => {
    const refusal = await readGithubRefusal(new Response('slow down', { status: 429 }), NOW)
    expect(refusal.kind).toBe('rate_limited')
  })

  it('keeps a permission refusal a refusal, in the words GitHub used', async () => {
    const refusal = await readGithubRefusal(json(NOT_PERMITTED, 403, { 'x-ratelimit-remaining': '4990' }), NOW)
    expect(refusal).toEqual({ kind: 'refused', status: 403, resetsAtIso: null, message: NOT_PERMITTED.message })
  })

  it('survives a body that is not JSON, without inventing a message', async () => {
    const refusal = await readGithubRefusal(new Response('<html>forbidden</html>', { status: 403 }), NOW)
    expect(refusal).toEqual({ kind: 'refused', status: 403, resetsAtIso: null, message: null })
  })
})

describe('describeGithubRefusal: what the reader is told', () => {
  it('says a limit clears on its own, when, and does not send anyone to the credential', async () => {
    const text = describeGithubRefusal(
      await readGithubRefusal(
        json(PRIMARY_LIMIT, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': RESET_EPOCH }),
        NOW,
      ),
    )
    expect(text).toContain('rate limit')
    expect(text).toContain('403')
    expect(text).toContain('5:07 PM EDT')
    expect(text).toContain('clears on its own')
    expect(text).not.toMatch(/cannot read|permission/i)
  })

  it('says a limit with no reset time still clears on its own, without inventing a time', async () => {
    const text = describeGithubRefusal(await readGithubRefusal(json(PRIMARY_LIMIT, 403), NOW))
    expect(text).toContain('clears on its own')
    expect(text).not.toContain('resets at')
  })

  // #835: a secondary limit is about how fast requests arrive, not an allowance
  // that ran out, so "used up" was false for it.
  it('does not call a secondary limit an allowance used up', async () => {
    const text = describeGithubRefusal(await readGithubRefusal(json(SECONDARY_LIMIT, 403, { 'retry-after': '60' }), NOW))
    expect(text).not.toContain('used up')
    expect(text).toContain('secondary')
    expect(text).toContain('clears on its own')
  })

  it('quotes the message GitHub sent for a permission refusal', async () => {
    const text = describeGithubRefusal(await readGithubRefusal(json(NOT_PERMITTED, 403), NOW))
    expect(text).toContain('403')
    expect(text).toContain('Resource not accessible by personal access token')
    expect(text).not.toContain('rate limit')
  })
})
