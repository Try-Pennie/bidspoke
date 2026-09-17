/**
 * reportPartnerBlock (#1265): one partner block sighting in, at most one Slack post out, on
 * a cadence the standing-condition backoff owns, never on the lead's critical path.
 *
 * What it must get right, each with its own test: post on the first sighting; stay quiet
 * inside the cooldown and while another isolate holds the claim; say nothing to Slack on a
 * test run or in local dev while still writing the log line (the rule every engine alert
 * follows, #547); back off for a few minutes after a failed post rather than letting every
 * sighting in a Slack outage look the connection up again; and remind, not repeat, while
 * the block stands. The KV fake honours expiry against an injected clock, so nothing sleeps.
 */
import { describe, it, expect, vi } from 'vitest'
import { reportPartnerBlock, PARTNER_BLOCK_CONDITION_TTL_SECONDS, POST_RETRY_HOLD_SECONDS, type PartnerBlockDeps, type PartnerBlockRunContext } from '../partner-block-alert'
import { ALERT_CLAIM_TTL_SECONDS } from '../volume-cliff'
import { BACKOFF_STEPS_SECONDS, readCondition } from '../alert-backoff'
import type { PartnerBlockSighting } from '../../types'
import type { PartnerBlockAlertPayload } from '../slack'

function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  return {
    store,
    get: async (k: string) => live(k)?.value ?? null,
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    delete: async (k: string) => { store.delete(k) },
  }
}

function fakeClaims(refuse = false) {
  const claimed: Array<[string, number]> = []
  const released: string[] = []
  return {
    claimed, released,
    claim: async (key: string, ttl: number) => { claimed.push([key, ttl]); return !refuse },
    release: async (key: string) => { released.push(key) },
  }
}

const sighting: PartnerBlockSighting = {
  host: 'oauth.prd.ffngcp.com', status: 403, vendor: 'cloudflare',
  bodyRayId: 'a369312f2f2faa85', edgeRayId: 'a369312f2f2faa85-EWR',
  markers: ['Sorry, you have been blocked'], seenIn: 'code:pennie_or_eligibility',
  siblingHosts: ['fdrapis-gateway.prd.fdrgcp.com', 'api.freedomfinancialnet.com'],
}

const run: PartnerBlockRunContext = { orgId: 'org-1', workflowId: 'wf-1', workflowName: 'Main Flow', traceId: 'trace-1' }

function makeDeps(overrides: Partial<PartnerBlockDeps> = {}) {
  const clock = { now: Date.parse('2026-09-17T15:00:00Z') }
  const kv = fakeKv(clock)
  const claims = fakeClaims()
  const sent: Array<{ channel: string; payload: PartnerBlockAlertPayload }> = []
  const logs: string[] = []
  const deps: PartnerBlockDeps = {
    kv, claims,
    resolveSlack: async () => ({ bot_token: 'xoxb-test', default_channel: '#ops' }),
    send: async (_slack, channel, payload) => { sent.push({ channel, payload }); return '1700000000.000100' },
    now: () => clock.now,
    log: (line) => { logs.push(line) },
    silent: false,
    appUrl: 'https://app.test',
    ...overrides,
  }
  return { deps, clock, kv, claims, sent, logs }
}

describe('reportPartnerBlock: first sighting', () => {
  it('posts once, records the standing condition and writes the event line', async () => {
    const { deps, sent, logs, kv } = makeDeps()
    const outcome = await reportPartnerBlock(deps, run, sighting)
    expect(outcome).toBe('posted')
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('#ops')
    expect(sent[0].payload.host).toBe('oauth.prd.ffngcp.com')
    expect(sent[0].payload.bodyRayId).toBe('a369312f2f2faa85')
    expect(sent[0].payload.workflowName).toBe('Main Flow')
    expect(sent[0].payload.repeat).toBeNull()
    const standing = await readCondition(kv, 'partner-block:oauth.prd.ffngcp.com')
    expect(standing?.alerts).toBe(1)
    expect(logs.some((l) => l.includes('event=partner_block_page') && l.includes('host=oauth.prd.ffngcp.com') && l.includes('status=403') && l.includes('body_ray=a369312f2f2faa85') && l.includes('seen_in=code:pennie_or_eligibility') && l.includes('trace=trace-1'))).toBe(true)
  })

  it('claims for the short claim window, not the backoff interval', async () => {
    const { deps, claims } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    expect(claims.claimed).toEqual([['partner-block:oauth.prd.ffngcp.com', ALERT_CLAIM_TTL_SECONDS]])
  })

  it('expires the standing record on its own, since only a new sighting can refresh it', async () => {
    const { deps, kv, clock } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    const entry = kv.store.get('partner-block:oauth.prd.ffngcp.com:condition')
    expect(entry?.expiresAt).toBe(clock.now + PARTNER_BLOCK_CONDITION_TTL_SECONDS * 1000)
    expect(PARTNER_BLOCK_CONDITION_TTL_SECONDS).toBeLessThanOrEqual(25 * 60 * 60)
  })

  it('names the partner\'s other hosts that are also standing blocked', async () => {
    const { deps, sent } = makeDeps()
    await reportPartnerBlock(deps, run, { ...sighting, host: 'fdrapis-gateway.prd.fdrgcp.com', siblingHosts: ['oauth.prd.ffngcp.com'] })
    await reportPartnerBlock(deps, run, sighting)
    expect(sent).toHaveLength(2)
    expect(sent[1].payload.alsoBlocked).toEqual(['fdrapis-gateway.prd.fdrgcp.com'])
  })
})

describe('reportPartnerBlock: staying quiet', () => {
  it('inside the cooldown a second sighting logs and does not post or claim', async () => {
    const { deps, sent, claims, logs, clock } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    clock.now += 60 * 1000
    const outcome = await reportPartnerBlock(deps, run, sighting)
    expect(outcome).toBe('cooldown')
    expect(sent).toHaveLength(1)
    expect(claims.claimed).toHaveLength(1)
    expect(logs.filter((l) => l.includes('event=partner_block_page'))).toHaveLength(2)
  })

  it('when another isolate holds the claim it does not post', async () => {
    const { deps, sent } = makeDeps({ claims: fakeClaims(true) })
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('claimed_elsewhere')
    expect(sent).toHaveLength(0)
  })

  it('on a test run or in local dev it writes the event line and touches nothing else', async () => {
    const { deps, sent, claims, kv, logs } = makeDeps({ silent: true })
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('logged')
    expect(sent).toHaveLength(0)
    expect(claims.claimed).toHaveLength(0)
    expect(kv.store.size).toBe(0)
    expect(logs.some((l) => l.includes('event=partner_block_page'))).toBe(true)
  })

  it('with no Slack connection it releases the claim and says so', async () => {
    const { deps, claims, logs } = makeDeps({ resolveSlack: async () => null })
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('no_slack')
    expect(claims.released).toEqual(['partner-block:oauth.prd.ffngcp.com'])
    expect(logs.some((l) => l.includes('no Slack connection'))).toBe(true)
  })
})

describe('reportPartnerBlock: a failed post', () => {
  it('holds further attempts for a few minutes, releases the claim and records no condition', async () => {
    const send = vi.fn(async () => null)
    const { deps, claims, kv, clock } = makeDeps({ send })
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('post_failed')
    expect(claims.released).toEqual(['partner-block:oauth.prd.ffngcp.com'])
    expect(await readCondition(kv, 'partner-block:oauth.prd.ffngcp.com')).toBeNull()
    clock.now += 60 * 1000
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('cooldown')
    expect(send).toHaveBeenCalledTimes(1)
    clock.now += (POST_RETRY_HOLD_SECONDS + 1) * 1000
    send.mockResolvedValueOnce('1700000000.000200' as never)
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('posted')
  })
})

describe('reportPartnerBlock: while the block stands', () => {
  it('reminds after the first interval and says how long it has stood', async () => {
    const { deps, sent, clock, kv } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    clock.now += (BACKOFF_STEPS_SECONDS[0] + 1) * 1000
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('posted')
    expect(sent).toHaveLength(2)
    expect(sent[1].payload.repeat).toMatch(/standing for ~6h/)
    expect(sent[1].payload.repeat).toMatch(/reminder 2/)
    expect((await readCondition(kv, 'partner-block:oauth.prd.ffngcp.com'))?.alerts).toBe(2)
  })

  it('a sighting after the record has expired starts a fresh incident rather than a stale reminder', async () => {
    const { deps, sent, clock } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    clock.now += (PARTNER_BLOCK_CONDITION_TTL_SECONDS + 1) * 1000
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('posted')
    expect(sent[1].payload.repeat).toBeNull()
  })
})
