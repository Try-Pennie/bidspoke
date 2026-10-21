/**
 * The Slack wording of the partners page delivery monitor (#2135). Two problems,
 * two messages (L11): the channel did not deliver the monitor's own notice, or
 * the monitor could not run at all. Each says what a person sees, that saves
 * are unaffected, and what to do next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendPartnerPageLiveAlert } from '../slack'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.1' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const posted = async () => (await slackPostOf(fetchMock.mock.calls[0])) as { text: string; blocks: Array<{ text?: { text?: string } }> }
const text = async () => (await posted()).blocks.map((b) => b.text?.text ?? '').join('\n')

describe('the partners page live alert', () => {
  it('says live updates are not arriving, what a person sees, and that saves are safe, in Eastern time', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'no notice arrived within 10 seconds', since: '2026-10-15T17:00:00.000Z', checks: { runs: 1, misses: 1 }, repeat: null, at: Date.parse('2026-10-15T17:00:00Z'),
    })
    expect((await posted()).text).toBe('Partners page live updates are not arriving')
    expect((await text())).toMatch(/1:00 PM EDT/)
    expect((await text())).toMatch(/no notice arrived within 10 seconds/)
    expect((await text())).toMatch(/may not see another person's save appear/)
    expect((await text())).toMatch(/Saves are not affected/)
    expect((await text())).toMatch(/status\.supabase\.com/)
  })

  // #2263: an alert that stood 12 hours read "has not received its own test
  // notice since 9:45 PM" while two of every three runs received it.
  it('says how many runs missed out of how many since the first miss, never that every run did', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'no notice arrived within 10 seconds', since: '2026-10-16T01:45:00.000Z', checks: { runs: 12, misses: 4 }, repeat: null, at: Date.parse('2026-10-16T02:40:00Z'),
    })
    expect((await text())).toMatch(/The delivery check failed in 4 of 12 runs since Oct 15, 9:45 PM EDT/)
    expect((await text())).not.toMatch(/has not received/)
  })

  // #2579: the alert pages on two misses in a row. When it paged on one because
  // the check could not tell whether the run before also missed, it says so,
  // rather than read as the rule having changed.
  it('says it paged on one miss because the record of the run before could not be read', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'no notice arrived within 10 seconds', since: '2026-10-21T08:00:38.000Z', checks: { runs: 1, misses: 1 }, firstMissOnly: 'unread', repeat: null, at: Date.parse('2026-10-21T08:00:38Z'),
    })
    expect((await text())).toMatch(/This check pages after two misses in a row, but it could not read whether the run before this one missed, so it paged on this one\./)
  })

  it('says it paged on one miss because this miss could not be saved for the next run', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'no notice arrived within 10 seconds', since: '2026-10-21T08:00:38.000Z', checks: { runs: 1, misses: 1 }, firstMissOnly: 'unsaved', repeat: null, at: Date.parse('2026-10-21T08:00:38Z'),
    })
    expect((await text())).toMatch(/This check pages after two misses in a row, but it could not save this miss for the next run to see, so it paged on this one\./)
  })

  it('says nothing about the rule when it paged on two misses in a row', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'no notice arrived within 10 seconds', since: '2026-10-21T08:00:38.000Z', checks: { runs: 2, misses: 2 }, repeat: null, at: Date.parse('2026-10-21T08:05:38Z'),
    })
    expect((await text())).toMatch(/The delivery check failed in 2 of 2 runs since Oct 21, 4:00 AM EDT/)
    expect((await text())).not.toMatch(/two misses in a row/)
  })

  it('says what Realtime\'s pool size wording means here, so nobody goes to change a pool setting', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'the monitor could not join the channel: IncreaseConnectionPool: Please increase your connection pool size',
      since: '2026-10-16T04:45:00.000Z', checks: { runs: 1, misses: 1 }, repeat: null, at: Date.parse('2026-10-16T04:45:00Z'),
    })
    expect((await text())).toMatch(/IncreaseConnectionPool/)
    expect((await text())).toMatch(/Realtime words a join this way when it arrives while Realtime is closing this project's idle connection/)
    expect((await text())).toMatch(/not a pool size setting/)
  })

  it('adds no such explanation for any other reason', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'channel', reason: 'the monitor could not join the channel: Unauthorized', since: '2026-10-16T04:45:00.000Z', checks: { runs: 1, misses: 1 }, repeat: null, at: Date.parse('2026-10-16T04:45:00Z'),
    })
    expect((await text())).not.toMatch(/idle connection/)
  })

  it('says the check cannot run, names the step, and points at the setup steps', async () => {
    await sendPartnerPageLiveAlert({ bot_token: 't' }, '#ops', {
      problem: 'monitor', reason: 'PARTNER_PAGE_MONITOR_PASSWORD is not set on the worker', since: '2026-10-15T17:00:00.000Z', repeat: 'This is reminder 2.', at: Date.parse('2026-10-15T17:30:00Z'),
    })
    expect((await posted()).text).toBe('Bidspoke cannot check partners page live updates')
    expect((await text())).toMatch(/PARTNER_PAGE_MONITOR_PASSWORD is not set/)
    expect((await text())).toMatch(/docs\/adr\/0012-partner-page-live-channel\.md/)
    expect((await text())).toMatch(/This is reminder 2\./)
    expect((await text())).not.toMatch(/not arriving/)
  })
})
