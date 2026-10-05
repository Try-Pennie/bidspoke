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
import { reportPartnerBlock, PARTNER_BLOCK_CONDITION_TTL_SECONDS, POST_RETRY_HOLD_SECONDS, PARTNER_REACHABILITY_RECOVERY_PREFIX, PROBE_SEEN_IN, type PartnerBlockDeps, type PartnerBlockRunContext } from '../partner-block-alert'
import { recoveryKey, activeKey } from '../alert-recovery'
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
    resolveSlack: async () => [{ bot_token: 'xoxb-test', default_channel: '#ops' }],
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
    const { deps, claims, logs } = makeDeps({ resolveSlack: async () => [] })
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

  // Every sighting carries its own Ray IDs, workflow and trace, so a reminder that
  // said "nothing about it has changed" was false on almost every post (#1768).
  it('says nothing has changed only when the block reads word for word as the last post did', async () => {
    const { deps, sent, clock, kv } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    clock.now += (BACKOFF_STEPS_SECONDS[0] + 1) * 1000
    await reportPartnerBlock(deps, run, sighting)
    expect(sent[1].payload.repeat).toContain('nothing about it has changed')

    kv.store.delete('partner-block:oauth.prd.ffngcp.com:cooldown')
    await reportPartnerBlock(deps, { ...run, traceId: 'trace-2' }, { ...sighting, bodyRayId: 'b471a2f0c1d2e3f4', edgeRayId: 'b471a2f0c1d2e3f4-EWR' })
    expect(sent[2].payload.repeat).toContain('same problem as before')
    expect(sent[2].payload.repeat).not.toContain('nothing about it has changed')
    expect(sent[2].payload.repeat).toContain('reminder 3')
  })

  it('posts a block recorded before fingerprints as new once its cooldown has passed', async () => {
    const { deps, sent, kv, clock } = makeDeps()
    await kv.put('partner-block:oauth.prd.ffngcp.com:condition', JSON.stringify({ since: new Date(clock.now - 30 * 3_600_000).toISOString(), alerts: 3 }))

    expect(await reportPartnerBlock(deps, run, sighting)).toBe('posted')
    expect(sent[0].payload.repeat).toBeNull()
    expect(await readCondition(kv, 'partner-block:oauth.prd.ffngcp.com')).toMatchObject({ alerts: 1, since: new Date(clock.now).toISOString() })
  })

  it('a sighting after the record has expired starts a fresh incident rather than a stale reminder', async () => {
    const { deps, sent, clock } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    clock.now += (PARTNER_BLOCK_CONDITION_TTL_SECONDS + 1) * 1000
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('posted')
    expect(sent[1].payload.repeat).toBeNull()
  })
})

describe('reportPartnerBlock: arming the all-clear for either observer (#1274)', () => {
  // The probe owns transitions on this key, but a lead usually sees a block first and
  // its post arms the cooldown, so the probe's own post is suppressed. If only the poster
  // armed the all-clear, the commonest incident would never get one (L397, L593). So the
  // reporter itself, at the layer both observers share, records the running end of the
  // incident on EVERY sighting and keeps the recovery marker alive from the condition's
  // first-seen time.
  it('records the last time the block was seen, on every sighting, posted or not', async () => {
    const { deps, kv, clock } = makeDeps()
    await reportPartnerBlock(deps, run, sighting)
    clock.now += 60 * 1000
    await reportPartnerBlock(deps, run, sighting)
    expect(kv.store.get(activeKey(PARTNER_REACHABILITY_RECOVERY_PREFIX, sighting.host))?.value).toBe(new Date(clock.now).toISOString())
  })

  it('keeps the recovery marker alive from the first sighting, refreshed by every later one, so a five day block still gets its all-clear', async () => {
    const { deps, kv, clock } = makeDeps()
    const first = clock.now
    await reportPartnerBlock(deps, run, sighting)
    clock.now += 23 * 60 * 60 * 1000
    await reportPartnerBlock(deps, run, sighting)
    const marker = kv.store.get(recoveryKey(PARTNER_REACHABILITY_RECOVERY_PREFIX, sighting.host))
    expect(marker?.value).toBe(new Date(first).toISOString())
    expect(marker?.expiresAt).toBeGreaterThan(clock.now + 20 * 60 * 60 * 1000)
  })

  it('refreshes the standing condition so it outlives a long block, keeping its first-seen time', async () => {
    const { deps, kv, clock } = makeDeps()
    const first = clock.now
    await reportPartnerBlock(deps, run, sighting)
    clock.now += 24 * 60 * 60 * 1000
    await reportPartnerBlock(deps, run, sighting)
    const entry = kv.store.get('partner-block:oauth.prd.ffngcp.com:condition')
    expect(entry?.expiresAt).toBe(clock.now + PARTNER_BLOCK_CONDITION_TTL_SECONDS * 1000)
    expect((await readCondition(kv, 'partner-block:oauth.prd.ffngcp.com'))?.since).toBe(new Date(first).toISOString())
  })

  it('posts to every org holding a Slack connection inside the one claim', async () => {
    const { deps, sent, claims } = makeDeps({ resolveSlack: async () => [{ bot_token: 'a', default_channel: '#a' }, { bot_token: 'b', default_channel: '#b' }] })
    expect(await reportPartnerBlock(deps, run, sighting)).toBe('posted')
    expect(sent.map((s) => s.channel).sort()).toEqual(['#a', '#b'])
    expect(claims.claimed).toHaveLength(1)
  })

  it('accepts a sighting from the probe, which has no workflow or trace, and logs a dash for them', async () => {
    const { deps, sent, logs } = makeDeps()
    const outcome = await reportPartnerBlock(deps, { orgId: 'org-1' }, { ...sighting, seenIn: PROBE_SEEN_IN })
    expect(outcome).toBe('posted')
    expect(sent[0].payload.workflowId).toBeUndefined()
    expect(logs.some((l) => l.includes('workflow=- trace=-') && l.includes(`seen_in=${PROBE_SEEN_IN}`))).toBe(true)
  })
})
