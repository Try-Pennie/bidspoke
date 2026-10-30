import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * #2220: the live post of one live miss notice, through the organization's
 * Slack connection and postMessage (deliverMessage). What each Slack answer
 * comes to, since the run retries only a failure and settles the rest.
 */
const lookupSlackConnection = vi.fn()
const postMessage = vi.fn()
vi.mock('../slack', () => ({
  lookupSlackConnection: (...args: unknown[]) => lookupSlackConnection(...args),
  postMessage: (...args: unknown[]) => postMessage(...args),
}))

const { postLiveMissNotice } = await import('../partner-live-miss-notice')

const supabase = {} as SupabaseClient
const ORG = '0b4c6a2e-6f3e-4d8a-9a51-1d1c4a0f7a11'
const notice = { title: 'A partners page missed a live update', sections: ['One.', '*Fix:* two.'], test: false }
const connection = (alerts = true) => ({ kind: 'live', connection: { bot_token: 'xoxb', default_channel: 'C123', config_alerts_enabled: alerts } })

beforeEach(() => {
  lookupSlackConnection.mockReset()
  postMessage.mockReset()
})

describe('postLiveMissNotice', () => {
  it('posts the title as a header and each section, to the organization\'s alert channel', async () => {
    lookupSlackConnection.mockResolvedValue(connection())
    postMessage.mockResolvedValue('1730000000.000100')
    expect(await postLiveMissNotice(supabase, ORG, notice)).toEqual({ kind: 'posted' })
    expect(lookupSlackConnection).toHaveBeenCalledWith(supabase, ORG)
    const [token, channel, blocks, text, alertKind] = postMessage.mock.calls[0]
    expect([token, channel, text]).toEqual(['xoxb', 'C123', notice.title])
    // Logged under its fixed kind (#2948).
    expect(alertKind).toBe('partner-page-live-miss')
    expect(blocks).toEqual([
      { type: 'header', text: { type: 'plain_text', text: notice.title, emoji: false } },
      { type: 'section', text: { type: 'mrkdwn', text: 'One.' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Fix:* two.' } },
    ])
  })

  it('is a failure when Slack refuses the post (ok:false comes back as no ts)', async () => {
    lookupSlackConnection.mockResolvedValue(connection())
    postMessage.mockResolvedValue(null)
    expect(await postLiveMissNotice(supabase, ORG, notice)).toEqual({ kind: 'failed', reason: 'Slack did not accept the post', refused: true })
  })

  it('throws when Slack gave no answer, which the run records as a failed post', async () => {
    lookupSlackConnection.mockResolvedValue(connection())
    postMessage.mockRejectedValue(new Error('Network connection lost.'))
    await expect(postLiveMissNotice(supabase, ORG, notice)).rejects.toThrow('Network connection lost.')
  })

  it('is a failure when the connection could not be read, never a quiet skip', async () => {
    lookupSlackConnection.mockResolvedValue({ kind: 'unreachable', reason: 'read_failed' })
    expect(await postLiveMissNotice(supabase, ORG, notice)).toEqual({ kind: 'failed', reason: 'the Slack connection could not be read: read_failed' })
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('settles without posting for an organization with no Slack, or with configuration alerts off', async () => {
    lookupSlackConnection.mockResolvedValue({ kind: 'none' })
    expect(await postLiveMissNotice(supabase, ORG, notice)).toEqual({ kind: 'not_posted', reason: 'no_slack' })
    lookupSlackConnection.mockResolvedValue(connection(false))
    expect(await postLiveMissNotice(supabase, ORG, notice)).toEqual({ kind: 'not_posted', reason: 'alerts_off' })
    expect(postMessage).not.toHaveBeenCalled()
  })
})
