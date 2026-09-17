/**
 * The Slack wording the reachability probe posts (#1274). Each sentence claims only what
 * the probe measured (L11), and every message names what to do next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendPartnerBlockAlert, sendPartnerUnreachableAlert, sendProbeControlAlert, sendProbeBrokenAlert } from '../slack'
import { PROBE_SEEN_IN } from '../partner-block-alert'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.1' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const text = () =>
  (JSON.parse(fetchMock.mock.calls[0][1].body).blocks as Array<{ text?: { text?: string } }>)
    .map((b) => b.text?.text ?? '')
    .join('\n')

describe('the block alert from the probe', () => {
  it('names the probe rather than a workflow, and offers no execution link because there is none', async () => {
    await sendPartnerBlockAlert({ bot_token: 't' }, '#ops', {
      host: 'oauth.prd.ffngcp.com', status: 403, vendor: 'cloudflare', bodyRayId: 'abc', edgeRayId: null,
      markers: ['Sorry, you have been blocked'], seenIn: PROBE_SEEN_IN, appUrl: 'https://app.test',
      repeat: null, alsoBlocked: [], ownProxy: false, at: Date.parse('2026-09-17T18:00:00Z'),
    })
    expect(text()).toMatch(/scheduled reachability probe/)
    expect(text()).not.toMatch(/Open the execution/)
    expect(text()).not.toMatch(/undefined/)
  })
})

describe('the not answering alert', () => {
  it('says the host is not answering, why, and since when, without calling it a block', async () => {
    await sendPartnerUnreachableAlert({ bot_token: 't' }, '#ops', {
      host: 'api.freedomfinancialnet.com', reason: 'connect ECONNRESET', since: '2026-09-17T17:30:00.000Z',
      repeat: null, at: Date.parse('2026-09-17T18:00:00Z'),
    })
    expect(text()).toMatch(/not answering/)
    expect(text()).toMatch(/ECONNRESET/)
    expect(text()).not.toMatch(/blocked/)
    expect(text()).toMatch(/How to fix/)
  })
})

describe('the control alert', () => {
  it('when the control has never passed, tells the reader to create the rule', async () => {
    await sendProbeControlAlert({ bot_token: 't' }, '#ops', {
      host: 'block-probe.trypennie.dev', everPassed: false, status: 403, bodyHead: 'error code: 1014', since: '2026-09-17T17:30:00.000Z', repeat: null, at: Date.parse('2026-09-17T18:00:00Z'),
    })
    expect(text()).toMatch(/never/)
    expect(text()).toMatch(/http\.host eq "block-probe\.trypennie\.dev"/)
    expect(text()).toMatch(/1014/)
  })

  it('when the control had passed, says when it stopped and names both causes', async () => {
    await sendProbeControlAlert({ bot_token: 't' }, '#ops', {
      host: 'block-probe.trypennie.dev', everPassed: true, status: 200, bodyHead: '<html>', since: '2026-09-17T17:30:00.000Z', repeat: null, at: Date.parse('2026-09-17T18:00:00Z'),
    })
    expect(text()).toMatch(/stopped/)
    expect(text()).toMatch(/rule/)
    expect(text()).toMatch(/markers/)
  })
})

describe('the probe cannot measure alert', () => {
  it('says the probe itself cannot fetch, so nothing about the partners is known', async () => {
    await sendProbeBrokenAlert({ bot_token: 't' }, '#ops', { reason: 'fetch failed', since: '2026-09-17T17:50:00.000Z', repeat: null, at: Date.parse('2026-09-17T18:00:00Z') })
    expect(text()).toMatch(/cannot fetch/i)
    expect(text()).toMatch(/fetch failed/)
  })
})
