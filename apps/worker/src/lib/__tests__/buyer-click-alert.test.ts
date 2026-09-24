/**
 * postClickAlert (#1542): the one way a click sold buyer's send speaks to a
 * person. Two kinds: a PAGE when a click needs somebody (a send with no
 * readable answer, a claim in doubt, a sale or count that could not be
 * recorded), and the OVER CAP notice once a Pacific day. Both go through the
 * alert claim, so a burst is one post: a page once per buyer and reason per
 * cooldown, the over cap notice once per buyer per Pacific day. It never
 * throws, because the send it reports on has already happened.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AlertClaims } from '../alert-claim'
import { CLICK_OVER_CAP_TTL_SECONDS, CLICK_PAGE_COOLDOWN_SECONDS, clickAlertKey, postClickAlert, type ClickAlert, type ClickAlertDeps } from '../buyer-click-alert'

const SLACK = { bot_token: 'xoxb-test', default_channel: 'C1' }

const page: ClickAlert = {
  kind: 'page', reason: 'outcome_unknown', partner_slug: 'liberty1', prospect_id: 'a0B000000000001', detail: 'http 503',
  workflow_id: 'wf-1', trace_id: 'trace-1', at: Date.UTC(2027, 8, 20, 18),
}
const overCap: ClickAlert = {
  kind: 'over_cap', partner_slug: 'liberty1', date: '2027-09-20', count: 60, daily_lead_cap: 50, alert_over_percent: 120, threshold: 60,
  workflow_id: 'wf-1', at: Date.UTC(2027, 8, 20, 18),
}

/** A claim double with the object's semantics: first caller per key per TTL wins. */
function claimsDouble() {
  const held = new Map<string, number>()
  const asked: Array<[string, number]> = []
  const released: string[] = []
  const claims: AlertClaims = {
    claim: async (key, ttl) => {
      asked.push([key, ttl])
      if (held.has(key)) return false
      held.set(key, ttl)
      return true
    },
    release: async (key) => {
      released.push(key)
      held.delete(key)
    },
  }
  return { claims, asked, released }
}

function deps(over: Partial<ClickAlertDeps> = {}): ClickAlertDeps & { lines: string[] } {
  const lines: string[] = []
  return {
    claims: claimsDouble().claims,
    resolveSlack: async () => SLACK,
    send: vi.fn(async () => 'ts-1'),
    appUrl: 'https://app.test',
    log: (line) => lines.push(line),
    lines,
    ...over,
  }
}

describe('clickAlertKey', () => {
  it('keys a page by buyer and reason, and the over cap notice by buyer and Pacific date', () => {
    expect(clickAlertKey(page)).toEqual({ key: 'buyer-click-page:liberty1:outcome_unknown', ttlSeconds: CLICK_PAGE_COOLDOWN_SECONDS })
    expect(clickAlertKey(overCap)).toEqual({ key: 'buyer-click-over-cap:liberty1:2027-09-20', ttlSeconds: CLICK_OVER_CAP_TTL_SECONDS })
  })

  it('the over cap window outlives a whole day, so the notice cannot repeat inside one', () => {
    expect(CLICK_OVER_CAP_TTL_SECONDS).toBeGreaterThanOrEqual(25 * 3600)
  })
})

describe('postClickAlert', () => {
  it('posts a page once, and a burst of the same reason inside the cooldown is one post', async () => {
    const d = deps()
    expect(await postClickAlert(d, page)).toBe('posted')
    expect(await postClickAlert(d, { ...page, prospect_id: 'a0B000000000002' })).toBe('claimed_elsewhere')
    expect(d.send).toHaveBeenCalledTimes(1)
  })

  it('a different reason pages on its own', async () => {
    const d = deps()
    await postClickAlert(d, page)
    expect(await postClickAlert(d, { ...page, reason: 'claim_in_doubt' })).toBe('posted')
    expect(d.send).toHaveBeenCalledTimes(2)
  })

  it('posts the over cap notice once per buyer per Pacific day, and again the next day', async () => {
    const d = deps()
    expect(await postClickAlert(d, overCap)).toBe('posted')
    expect(await postClickAlert(d, { ...overCap, count: 61 })).toBe('claimed_elsewhere')
    expect(await postClickAlert(d, { ...overCap, date: '2027-09-21' })).toBe('posted')
    expect(d.send).toHaveBeenCalledTimes(2)
  })

  it('a Slack post that fails releases the claim, so the next alert can try, and is logged', async () => {
    const c = claimsDouble()
    const d = deps({ claims: c.claims, send: vi.fn(async () => null) })
    expect(await postClickAlert(d, overCap)).toBe('post_failed')
    expect(c.released).toEqual(['buyer-click-over-cap:liberty1:2027-09-20'])
    expect(d.lines.join('\n')).toMatch(/post failed/)
  })

  it('a Slack send that throws is post_failed, never a throw', async () => {
    const d = deps({ send: vi.fn(async () => { throw new Error('socket hang up') }) })
    expect(await postClickAlert(d, page)).toBe('post_failed')
    expect(d.lines.join('\n')).toMatch(/socket hang up/)
  })

  it('no Slack connection is its own outcome, logged, and the claim is released', async () => {
    const c = claimsDouble()
    const d = deps({ claims: c.claims, resolveSlack: async () => null })
    expect(await postClickAlert(d, page)).toBe('no_slack')
    expect(c.released).toHaveLength(1)
    expect(d.lines.join('\n')).toMatch(/no Slack connection/)
  })

  it('a Slack lookup that throws is post_failed, never a throw', async () => {
    const d = deps({ resolveSlack: async () => { throw new Error('db down') } })
    expect(await postClickAlert(d, page)).toBe('post_failed')
  })

  it('with no claim object bound it still posts: the claim fails open, never silent', async () => {
    const d = deps({ claims: undefined })
    expect(await postClickAlert(d, page)).toBe('posted')
  })

  it('the page names the buyer, the prospect, the reason and what is held; the over cap notice names the count and the cap', async () => {
    const send = vi.fn(async () => 'ts')
    await postClickAlert(deps({ send }), page)
    await postClickAlert(deps({ send }), overCap)
    const [pageArgs, capArgs] = send.mock.calls as unknown as Array<[unknown, string, { header: string; body: string; link: string | null }]>
    expect(pageArgs[2].header).toMatch(/liberty1/)
    expect(pageArgs[2].body).toMatch(/a0B000000000001/)
    expect(pageArgs[2].body).toMatch(/http 503/)
    expect(pageArgs[2].body).toMatch(/held/)
    expect(pageArgs[2].link).toBe('https://app.test/workflows/wf-1/executions?trace=trace-1')
    expect(capArgs[2].header).toMatch(/60/)
    expect(capArgs[2].body).toMatch(/50/)
    expect(capArgs[2].body).toMatch(/2027-09-20/)
  })
})
