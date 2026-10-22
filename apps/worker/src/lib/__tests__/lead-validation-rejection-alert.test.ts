/**
 * The page the lead validation rejection watch sends (#2592): what moved, by how
 * much against the week before, and what to do, which is the rollback trigger
 * written on #2592.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendLeadValidationRejectionAlert } from '../slack'
import { slackOk, slackPostOf } from '../../__tests__/helpers/slack-fetch'

const WF = '6624acd0-bf61-4d21-85fc-4371ca7ed77d'

describe('sendLeadValidationRejectionAlert', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names each moved reason with both shares and counts, and says to restore the version before the swap', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => slackOk({ ts: '1.2' }))
    vi.stubGlobal('fetch', fetchMock)
    const delivered = await sendLeadValidationRejectionAlert({ bot_token: 'xoxb' }, '#rml', {
      workflow_id: WF,
      workflow_name: 'RML - Bidding Workflow (GigFi)',
      namespace: 'validate_bidding_and_state',
      runs: 612,
      baseline_runs: 20_835,
      baseline_days: 7,
      shifts: [
        { bucket: 'ineligible state', direction: 'fell', count: 0, share: 0, baselineCount: 2_384, baselineShare: 2_384 / 20_835 },
        { bucket: 'unqualified', direction: 'rose', count: 400, share: 400 / 612, baselineCount: 0, baselineShare: 0 },
      ],
      window_minutes: 120,
      window_end: '2026-10-22T17:58:00.000Z',
      app_url: 'https://app.test',
    })
    expect(delivered).toBe(true)
    const post = await slackPostOf(fetchMock.mock.calls[0])
    const text = JSON.stringify(post.blocks)
    expect(post.channel).toBe('#rml')
    expect(text).toContain('Lead Rejections Changed')
    expect(text).toContain('RML - Bidding Workflow (GigFi)')
    expect(text).toContain('ineligible state: 0 of 612 (0.0%), against 11.4% (2,384 of 20,835) in the 7 days before')
    expect(text).toContain('unqualified: 400 of 612 (65.4%), against 0.0% (0 of 20,835) in the 7 days before')
    expect(text).toContain('Version history')
    expect(text).toContain(`https://app.test/workflows/${WF}`)
  })

  it('reports a refused post as not delivered, so no incident is opened for it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => slackOk({ ok: false, error: 'channel_not_found' })))
    const delivered = await sendLeadValidationRejectionAlert({ bot_token: 'xoxb' }, '#gone', {
      workflow_id: WF, workflow_name: 'W', namespace: 'v', runs: 300, baseline_runs: 3_000, baseline_days: 7, shifts: [], window_minutes: 120, window_end: '2026-10-22T17:58:00.000Z', app_url: 'https://app.test',
    })
    expect(delivered).toBe(false)
  })
})
