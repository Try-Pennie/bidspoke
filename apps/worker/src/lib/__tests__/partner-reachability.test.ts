/**
 * The scheduled partner reachability probe (#1274).
 *
 * Block detection (#1265) fires only when a real lead calls the partner, so a block that
 * lifts produces no event at all and a block that returns is seen tens of minutes late.
 * This probe asks every five minutes, records reachable, blocked or unreachable per host,
 * alerts on a transition in either direction, and owns the all-clear on the same
 * `partner-block:<host>` key the lead path reports on.
 *
 * Every threshold here is judged on the clock from the moment a state began, never on a
 * count of ticks (a delayed or retried cron would move a count without moving time, L386).
 * The clock, the fetch, the KV store, the claim and every Slack send are injected, so no
 * test waits, reaches a network, or depends on the wall clock (L524, L2, L130).
 */
import { describe, it, expect } from 'vitest'
import { outboxEvents, transitions } from './_incident-events'
import {
  classifyProbe,
  probeTargets,
  runPartnerReachabilityCheck,
  CONTROL_HOST,
  UNREACHABLE_ALERT_AFTER_MS,
  CONTROL_ALERT_AFTER_MS,
  PROBE_BROKEN_AFTER_MS,
  PROBE_CONTROL_KEY,
  unreachableKey,
  stateKey,
  type ReachabilityDeps,
  type ProbeOutcome,
} from '../partner-reachability'
import { partnerBlockKey, PROBE_SEEN_IN, PARTNER_REACHABILITY_RECOVERY_PREFIX } from '../partner-block-alert'
import { readCondition } from '../alert-backoff'
import { recoveryKey } from '../alert-recovery'
import { RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { ACHIEVE_HOSTS, ACHIEVE_CLIENT_HEADER, ACHIEVE_KEY_HEADER } from '../../engine/nodes/achieve-identity'
import { ACHIEVE_CLOUDFLARE_BLOCK_PAGE } from './fixtures/achieve-cloudflare-block-page'

const MIN = 60 * 1000

function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  const unreadable = new Set<string>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  let puts = 0
  return {
    store, unreadable,
    get puts() { return puts },
    get: async (k: string) => {
      if (unreadable.has(k)) throw new Error(`KV read failed for ${k}`)
      return live(k)?.value ?? null
    },
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      puts += 1
      store.set(k, { value, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    delete: async (k: string) => { store.delete(k) },
  }
}

/** Claims expire against the clock, as the Durable Object's do; `held` maps key to expiry. */
function fakeClaims(clock: { now: number }, refuse = false) {
  const claimed: string[] = []
  const held = new Map<string, number>()
  return {
    claimed,
    claim: async (key: string, ttlSeconds: number) => {
      claimed.push(key)
      const until = held.get(key)
      if (refuse || (until !== undefined && until > clock.now)) return false
      held.set(key, clock.now + ttlSeconds * 1000)
      return true
    },
    release: async (key: string) => { held.delete(key) },
    held,
  }
}

type Answer =
  | { kind: 'ok'; status: number; body?: string; type?: string; headers?: Record<string, string> }
  | { kind: 'throw'; error: string }
  | { kind: 'block' }
  | { kind: 'cf'; code: number }

const answer = (a: Answer): ProbeOutcome => {
  if (a.kind === 'throw') return { status: null, body: '', headers: null, error: a.error, redirect: null }
  if (a.kind === 'block') return { status: 403, body: ACHIEVE_CLOUDFLARE_BLOCK_PAGE, headers: { 'content-type': 'text/html', 'cf-ray': 'a369312f2f2faa85-EWR' }, error: null, redirect: null }
  if (a.kind === 'cf') return { status: 403, body: `error code: ${a.code}`, headers: { 'content-type': 'text/plain; charset=UTF-8', 'cf-ray': 'b1c2d3e4f5a6b7c8-EWR' }, error: null, redirect: null }
  return { status: a.status, body: a.body ?? '', headers: { 'content-type': a.type ?? 'application/json', ...(a.headers ?? {}) }, error: null, redirect: null }
}

/** What the fake network answers per host on this tick; unset hosts answer 404 JSON (reachable). */
type Plan = Partial<Record<string, Answer>>

function makeDeps(overrides: Partial<ReachabilityDeps> = {}) {
  const clock = { now: Date.parse('2026-09-17T18:00:00Z') }
  const kv = fakeKv(clock)
  const claims = fakeClaims(clock)
  const plan: { current: Plan } = { current: {} }
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const sent: Array<{ kind: string; channel: string; payload: unknown }> = []
  const logs: string[] = []
  const deps: ReachabilityDeps = {
    kv, claims,
    env: { ACHIEVE_PARTNER_KEY: 'pk-test', APP_URL: 'https://app.test', PARTNER_PROBE_ALERTS: 'on' },
    probe: async (target) => {
      requests.push({ url: target.url, headers: target.headers })
      const a = plan.current[target.host] ?? { kind: 'ok', status: 404, body: '{"error":"Not Found"}' }
      return answer(a)
    },
    resolveSlack: async () => [{ bot_token: 'xoxb-test', default_channel: '#ops' }],
    senders: {
      block: async (_s, channel, payload) => { sent.push({ kind: 'block', channel, payload }); return '1.1' },
      unreachable: async (_s, channel, payload) => { sent.push({ kind: 'unreachable', channel, payload }); return '1.2' },
      control: async (_s, channel, payload) => { sent.push({ kind: 'control', channel, payload }); return '1.3' },
      recovery: async (_s, channel, payload) => { sent.push({ kind: 'recovery', channel, payload }); return true },
      probeBroken: async (_s, channel, payload) => { sent.push({ kind: 'probe-broken', channel, payload }); return '1.4' },
    },
    now: () => clock.now,
    log: (line) => { logs.push(line) },
    ...overrides,
  }
  /** Run one tick with the network answering `p`, then advance the clock by five minutes. */
  const tick = async (p: Plan = {}) => {
    plan.current = p
    const summary = await runPartnerReachabilityCheck(deps)
    clock.now += 5 * MIN
    return summary
  }
  /** Run ticks until `ms` has elapsed on the clock, every five minutes. */
  const ticksFor = async (ms: number, p: Plan = {}) => {
    const end = clock.now + ms
    while (clock.now < end) await tick(p)
  }
  return { deps, clock, kv, claims, sent, logs, requests, tick, ticksFor, plan }
}

const ACHIEVE = [...ACHIEVE_HOSTS]
const blockedAchieve = (): Plan => Object.fromEntries(ACHIEVE.map((h) => [h, { kind: 'block' }]))
const healthy = (): Plan => ({ [CONTROL_HOST]: { kind: 'block' } })

describe('probeTargets', () => {
  it('lists the three Achieve hosts and the control, nothing else', () => {
    const targets = probeTargets({ ACHIEVE_PARTNER_KEY: 'pk' })
    expect(targets.map((t) => t.host).sort()).toEqual([...ACHIEVE, CONTROL_HOST].sort())
  })

  it('sends the identity headers Achieve keys its Skip rule on, on every Achieve probe', () => {
    // A header-less GET is exactly the request their IP block refuses, so a probe without
    // them would read blocked for ever while leads flow fine (L472).
    for (const t of probeTargets({ ACHIEVE_PARTNER_KEY: 'pk' }).filter((t) => !t.control)) {
      expect(t.headers[ACHIEVE_CLIENT_HEADER], t.host).toBe('pennie')
      expect(t.headers[ACHIEVE_KEY_HEADER], t.host).toBe('pk')
      expect(t.headers['User-Agent']).toMatch(/bidspoke/i)
    }
  })

  it('names the other Achieve hosts as siblings, so one block reads as one story', () => {
    const oauth = probeTargets({ ACHIEVE_PARTNER_KEY: 'pk' }).find((t) => t.host === 'oauth.prd.ffngcp.com')!
    expect(oauth.siblings.sort()).toEqual(ACHIEVE.filter((h) => h !== 'oauth.prd.ffngcp.com').sort())
  })

  it('expects the control blocked and everything else reachable', () => {
    const targets = probeTargets({})
    expect(targets.find((t) => t.host === CONTROL_HOST)?.expect).toBe('blocked')
    expect(targets.filter((t) => !t.control).every((t) => t.expect === 'reachable')).toBe(true)
  })
})

describe('classifyProbe: one classifier, the same one the lead path uses', () => {
  it('reads the real Cloudflare block page as blocked', () => {
    const r = classifyProbe(answer({ kind: 'block' }))
    expect(r.state).toBe('blocked')
    expect(r.block?.vendor).toBe('cloudflare')
    expect(r.block?.bodyRayId).toBe('a369312f2f2faa85')
  })

  it('reads a plain text Cloudflare firewall code as blocked, the form a non-browser client is served', () => {
    const r = classifyProbe(answer({ kind: 'cf', code: 1020 }))
    expect(r.state).toBe('blocked')
    expect(r.block?.markers.join(' ')).toMatch(/1020/)
  })

  it('reads a plain text Cloudflare edge error that is not a firewall code as unreachable, naming the code', () => {
    // Measured on block-probe.trypennie.dev on 2026-09-17: `error code: 1014` (CNAME Cross-User
    // Banned). Our request never reached an application, which is not the same as the
    // application refusing us (L11).
    const r = classifyProbe(answer({ kind: 'cf', code: 1014 }))
    expect(r.state).toBe('unreachable')
    expect(r.reason).toBe('cloudflare_error:1014')
  })

  it.each([502, 504, 520, 521, 523, 526, 530])('reads a %s origin error as unreachable', (status) => {
    const r = classifyProbe(answer({ kind: 'ok', status, body: '<html>error</html>', type: 'text/html' }))
    expect(r.state).toBe('unreachable')
    expect(r.reason).toBe(`origin_error:${status}`)
  })

  it('reads a thrown fetch as unreachable with the error text', () => {
    const r = classifyProbe(answer({ kind: 'throw', error: 'TimeoutError: The operation was aborted' }))
    expect(r.state).toBe('unreachable')
    expect(r.reason).toMatch(/aborted/)
  })

  it.each([
    ['a 401 JSON refusal', { kind: 'ok', status: 401, body: '{"error":"unauthorized"}' } as Answer],
    ['a 404 text', { kind: 'ok', status: 404, body: '404 page not found', type: 'text/plain' } as Answer],
    ['a 405', { kind: 'ok', status: 405 } as Answer],
    ['a 204 with no body', { kind: 'ok', status: 204, type: '' } as Answer],
    ['a 400 JSON', { kind: 'ok', status: 400, body: '{"error":"unsupported_grant_type"}' } as Answer],
  ])('reads %s as reachable: the application answered', (_label, a) => {
    expect(classifyProbe(answer(a)).state).toBe('reachable')
  })

  it('reads a redirect as reachable rather than following it onto another host', () => {
    const r = classifyProbe({ status: 301, body: '', headers: { location: 'https://www.example.com/' }, error: null, redirect: 'https://www.example.com/' })
    expect(r.state).toBe('reachable')
    expect(r.reason).toMatch(/redirect/)
  })

  it('reads a 403 HTML page with no firewall markers as reachable and says so', () => {
    // A bare root on an API gateway commonly answers a branded 403 page while the real
    // path works. The lead path reports that shape on a DATA endpoint as a finding; on a
    // root it is not one. Deliberate, documented divergence.
    const r = classifyProbe(answer({ kind: 'ok', status: 403, body: '<!DOCTYPE html><html><body><h1>Forbidden</h1></body></html>', type: 'text/html' }))
    expect(r.state).toBe('reachable')
    expect(r.html403).toBe(true)
  })
})

describe('the probe on a healthy day', () => {
  it('logs one line per host with its state and how long it has held, and posts nothing', async () => {
    const { tick, logs, sent } = makeDeps()
    const s = await tick(healthy())
    expect(s.probed).toBe(4)
    expect(s.reachable).toBe(3)
    expect(s.blocked).toBe(1)
    expect(sent).toHaveLength(0)
    for (const h of ACHIEVE) expect(logs.some((l) => l.includes('event=partner_probe') && l.includes(`host=${h}`) && l.includes('state=reachable'))).toBe(true)
  })

  it('marks the control line as the canary so a count of blocked lines excludes it', async () => {
    const { tick, logs } = makeDeps()
    await tick(healthy())
    const line = logs.find((l) => l.includes(`host=${CONTROL_HOST}`))!
    expect(line).toMatch(/control=true/)
    expect(line).toMatch(/expect=blocked/)
    expect(line).toMatch(/state=blocked/)
  })

  it('writes state only when a host changes state, not on every tick', async () => {
    const { tick, kv } = makeDeps()
    await tick(healthy())
    const after = kv.puts
    await tick(healthy())
    await tick(healthy())
    expect(kv.puts).toBe(after)
  })

  it('stamps the moment the control first read blocked, for ever', async () => {
    const { tick, kv, clock } = makeDeps()
    const t0 = clock.now
    await tick(healthy())
    await tick(healthy())
    const state = JSON.parse(kv.store.get(stateKey(CONTROL_HOST))!.value) as { controlPassedAt: string }
    expect(state.controlPassedAt).toBe(new Date(t0).toISOString())
  })
})

describe('a block seen by the probe', () => {
  it('posts the block alert once through the shared reporter, marked as seen by the probe', async () => {
    const { tick, sent } = makeDeps()
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    const posts = sent.filter((s) => s.kind === 'block')
    expect(posts).toHaveLength(1)
    const payload = posts[0].payload as { host: string; seenIn: string; workflowId?: string }
    expect(payload.host).toBe('oauth.prd.ffngcp.com')
    expect(payload.seenIn).toBe(PROBE_SEEN_IN)
    expect(payload.workflowId).toBeUndefined()
  })

  it('stays quiet on the next tick inside the reporter cooldown', async () => {
    const { tick, sent } = makeDeps()
    const p = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } as Answer }
    await tick(p)
    await tick(p)
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(1)
  })

  it('arms the all-clear and records the running end of the incident on every blocked tick', async () => {
    const { tick, kv, clock } = makeDeps()
    const p = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } as Answer }
    await tick(p)
    const firstTick = clock.now - 5 * MIN
    await tick(p)
    expect(kv.store.get(recoveryKey(PARTNER_REACHABILITY_RECOVERY_PREFIX, 'oauth.prd.ffngcp.com'))?.value).toBe(new Date(firstTick).toISOString())
    expect(kv.store.get(`${PARTNER_REACHABILITY_RECOVERY_PREFIX}-active:oauth.prd.ffngcp.com`)?.value).toBe(new Date(clock.now - 5 * MIN).toISOString())
  })

  it('does not treat a blocked reading as unmeasured even when the control is silent, since a block page proves the host answered', async () => {
    const { tick, sent } = makeDeps()
    await tick({ [CONTROL_HOST]: { kind: 'throw', error: 'fetch failed' }, 'oauth.prd.ffngcp.com': { kind: 'block' } })
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(1)
  })
})

describe('the all-clear', () => {
  it('posts once after the re-arm window of clean probes, and clears both conditions so the next block pages at once', async () => {
    const { tick, ticksFor, sent, kv } = makeDeps()
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    await ticksFor(RECOVERY_REARM_MINUTES * MIN - 5 * MIN, healthy())
    expect(sent.filter((s) => s.kind === 'recovery')).toHaveLength(0)
    await tick(healthy())
    await tick(healthy())
    const recoveries = sent.filter((s) => s.kind === 'recovery')
    expect(recoveries).toHaveLength(1)
    const payload = recoveries[0].payload as { items: Array<{ subject: string }>; recoveredPhrase: string }
    expect(payload.items.map((i) => i.subject)).toEqual(['oauth.prd.ffngcp.com'])
    expect(payload.recoveredPhrase).toMatch(/block page/)
    expect(await readCondition(kv, partnerBlockKey('oauth.prd.ffngcp.com'))).toBeNull()
    expect(kv.store.has(recoveryKey(PARTNER_REACHABILITY_RECOVERY_PREFIX, 'oauth.prd.ffngcp.com'))).toBe(false)
    // The next block is a fresh incident, not a suppressed repeat.
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(2)
  })

  it('posts the all-clear for a block a LEAD saw first, which the probe itself never posted', async () => {
    // The commonest case (L397): a lead's sighting posts and arms the cooldown, so the
    // probe's own post is suppressed. The reporter arms the all-clear for either observer.
    const { deps, tick, ticksFor, sent, kv, clock } = makeDeps()
    const { reportPartnerBlock } = await import('../partner-block-alert')
    await reportPartnerBlock(
      { kv, claims: deps.claims, resolveSlack: deps.resolveSlack, send: deps.senders.block, now: deps.now, log: deps.log, silent: false, appUrl: 'https://app.test' },
      { orgId: 'org-1', workflowId: 'wf-1', workflowName: 'Main Flow', traceId: 't-1' },
      { host: 'oauth.prd.ffngcp.com', status: 403, vendor: 'cloudflare', bodyRayId: 'a369312f2f2faa85', edgeRayId: null, markers: ['Sorry, you have been blocked'], seenIn: 'code:x' },
    )
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(1)
    clock.now += 2 * MIN
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(1)
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    expect(sent.filter((s) => s.kind === 'recovery')).toHaveLength(1)
  })

  it('holds the all-clear when a relapse lands inside the window, and does not page a second time either', async () => {
    const { tick, ticksFor, sent } = makeDeps()
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    await ticksFor(20 * MIN, healthy())
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    await ticksFor(20 * MIN, healthy())
    expect(sent.filter((s) => s.kind === 'recovery')).toHaveLength(0)
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(1)
  })

  it('announces the three Achieve hosts recovering together as one message', async () => {
    const { tick, ticksFor, sent } = makeDeps()
    await tick({ ...healthy(), ...blockedAchieve() })
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    const recoveries = sent.filter((s) => s.kind === 'recovery')
    expect(recoveries).toHaveLength(1)
    expect((recoveries[0].payload as { items: Array<{ subject: string }> }).items.map((i) => i.subject).sort()).toEqual([...ACHIEVE].sort())
  })

  it('takes a claim before posting, so a retried cron cannot announce twice', async () => {
    const { tick, ticksFor, sent, claims, deps, clock } = makeDeps()
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    expect(sent.filter((s) => s.kind === 'recovery')).toHaveLength(1)
    expect(claims.claimed.some((k) => k.includes('recovery'))).toBe(true)
    // Two runs at the same instant, the second refused the claim: one message.
    claims.held.clear()
    await tick({ ...healthy(), 'fdrapis-gateway.prd.fdrgcp.com': { kind: 'block' } })
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 5 * MIN, healthy())
    const before = sent.filter((s) => s.kind === 'recovery').length
    const frozen = clock.now
    await runPartnerReachabilityCheck(deps)
    clock.now = frozen
    await runPartnerReachabilityCheck(deps)
    expect(sent.filter((s) => s.kind === 'recovery').length).toBeLessThanOrEqual(before + 1)
  })
})

describe('a host that does not answer', () => {
  it('posts nothing before the alert window has passed on the clock', async () => {
    const { ticksFor, sent, logs } = makeDeps()
    await ticksFor(UNREACHABLE_ALERT_AFTER_MS - 5 * MIN, { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error: 'connect ECONNRESET' } })
    expect(sent).toHaveLength(0)
    expect(logs.some((l) => l.includes('state=unreachable') && l.includes('reason="connect ECONNRESET"'))).toBe(true)
  })

  it('posts its own "not answering" message once the window has passed, with a claim, and reminds on the backoff', async () => {
    const { ticksFor, tick, sent, claims, kv } = makeDeps()
    const p = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error: 'connect ECONNRESET' } as Answer }
    await ticksFor(UNREACHABLE_ALERT_AFTER_MS, p)
    await tick(p)
    const posts = sent.filter((s) => s.kind === 'unreachable')
    expect(posts).toHaveLength(1)
    expect((posts[0].payload as { host: string; reason: string }).reason).toBe('connect ECONNRESET')
    expect(claims.claimed).toContain(unreachableKey('oauth.prd.ffngcp.com'))
    expect((await readCondition(kv, unreachableKey('oauth.prd.ffngcp.com')))?.alerts).toBe(1)
    await ticksFor(60 * MIN, p)
    expect(sent.filter((s) => s.kind === 'unreachable')).toHaveLength(1)
  })

  it('is judged on the clock, so a delayed scheduler with fewer ticks still alerts on time', async () => {
    const { deps, clock, sent } = makeDeps()
    const p: Plan = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error: 'x' } }
    const plan = deps.probe
    deps.probe = async (t) => (p[t.host] ? answer(p[t.host]!) : plan(t))
    await runPartnerReachabilityCheck(deps)
    clock.now += UNREACHABLE_ALERT_AFTER_MS + 1
    await runPartnerReachabilityCheck(deps)
    expect(sent.filter((s) => s.kind === 'unreachable')).toHaveLength(1)
  })

  it('gets the same all-clear once it answers again for the re-arm window', async () => {
    const { ticksFor, tick, sent } = makeDeps()
    const p = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error: 'x' } as Answer }
    await ticksFor(UNREACHABLE_ALERT_AFTER_MS + 5 * MIN, p)
    expect(sent.filter((s) => s.kind === 'unreachable')).toHaveLength(1)
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    await tick(healthy())
    expect(sent.filter((s) => s.kind === 'recovery')).toHaveLength(1)
  })
})

describe('the incident record (#2099)', () => {
  const HOST = 'oauth.prd.ffngcp.com'
  const mine = (store: Parameters<typeof transitions>[0]) => transitions(store).filter((t) => t.includes(HOST))

  it('records a block as one platform incident: opened, the page that went out, and the all-clear', async () => {
    const { tick, ticksFor, kv } = makeDeps()
    const p = { ...healthy(), [HOST]: { kind: 'block' } as Answer }
    await tick(p)
    await tick(p)
    await tick(p)
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    expect(mine(kv.store)).toEqual([`opened ${HOST}`, `paged ${HOST}`, `ended ${HOST} all_clear`])
    for (const e of outboxEvents(kv.store).filter((e) => e.subject === HOST)) {
      // The probe reports as the literal org 'probe'; the record must never read it as an owner.
      expect(e).toMatchObject({ signal: 'partner-reachability', scope: 'platform', organizationId: null, subjectLabel: HOST })
    }
  })

  it('records a host not answering from the moment it is armed, with one page per post', async () => {
    const { ticksFor, kv, sent } = makeDeps()
    const p = { ...healthy(), [HOST]: { kind: 'throw', error: 'connect ECONNRESET' } as Answer }
    await ticksFor(UNREACHABLE_ALERT_AFTER_MS + 60 * MIN, p)
    expect(sent.filter((s) => s.kind === 'unreachable')).toHaveLength(1)
    expect(mine(kv.store)).toEqual([`opened ${HOST}`, `paged ${HOST}`])
  })

  it('in observe mode records the incident but no page, since nothing was posted', async () => {
    const { tick, ticksFor, kv } = makeDeps({ env: { ACHIEVE_PARTNER_KEY: 'pk', APP_URL: 'https://app.test' } })
    await tick({ ...healthy(), [HOST]: { kind: 'block' } })
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    expect(mine(kv.store)).toEqual([`opened ${HOST}`, `ended ${HOST} all_clear`])
  })

  it('puts a recording KV refused in the run\'s errors, and the alert still goes out', async () => {
    const { tick, kv, sent } = makeDeps()
    const put = kv.put
    kv.put = async (k, v, o) => { if (k.startsWith('incident-outbox:')) throw new Error('KV refused the write'); return put(k, v, o) }
    const summary = await tick({ ...healthy(), [HOST]: { kind: 'block' } })
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(1)
    expect(summary.errors.some((e) => e.includes('incident record') && e.includes('KV refused'))).toBe(true)
  })
})

describe('the positive control', () => {
  it('posts the "never passed" wording when the control has never once read blocked since deploy', async () => {
    const { ticksFor, sent } = makeDeps()
    await ticksFor(CONTROL_ALERT_AFTER_MS + 5 * MIN, { [CONTROL_HOST]: { kind: 'cf', code: 1014 } })
    const posts = sent.filter((s) => s.kind === 'control')
    expect(posts).toHaveLength(1)
    const payload = posts[0].payload as { everPassed: boolean; status: number | null; bodyHead: string }
    expect(payload.everPassed).toBe(false)
    expect(payload.status).toBe(403)
    expect(payload.bodyHead).toMatch(/1014/)
  })

  it('posts the "stopped" wording once it had passed and then reads reachable for the window', async () => {
    const { tick, ticksFor, sent } = makeDeps()
    await tick(healthy())
    await ticksFor(CONTROL_ALERT_AFTER_MS + 5 * MIN, { [CONTROL_HOST]: { kind: 'ok', status: 200, body: '<html>ok</html>', type: 'text/html' } })
    const posts = sent.filter((s) => s.kind === 'control')
    expect(posts).toHaveLength(1)
    expect((posts[0].payload as { everPassed: boolean }).everPassed).toBe(true)
  })

  it('never hands the control host to the block reporter', async () => {
    const { ticksFor, sent, kv } = makeDeps()
    await ticksFor(60 * MIN, healthy())
    expect(sent.filter((s) => s.kind === 'block')).toHaveLength(0)
    expect(await readCondition(kv, partnerBlockKey(CONTROL_HOST))).toBeNull()
  })

  it('posts an all-clear when it reads blocked again for the re-arm window', async () => {
    const { tick, ticksFor, sent } = makeDeps()
    await tick(healthy())
    await ticksFor(CONTROL_ALERT_AFTER_MS + 5 * MIN, { [CONTROL_HOST]: { kind: 'ok', status: 200 } })
    expect(sent.filter((s) => s.kind === 'control')).toHaveLength(1)
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    const recoveries = sent.filter((s) => s.kind === 'recovery')
    expect(recoveries).toHaveLength(1)
    expect((recoveries[0].payload as { items: Array<{ subject: string }> }).items[0].subject).toBe(CONTROL_HOST)
  })
})

describe('when the probe itself cannot fetch', () => {
  it('marks every other reading unmeasured and holds their state, rather than paging four partner outages', async () => {
    const { tick, ticksFor, sent, logs, kv } = makeDeps()
    await tick(healthy())
    const before = new Map([...kv.store].filter(([k]) => k.startsWith('partner-reachability:state:')))
    const dead: Plan = { [CONTROL_HOST]: { kind: 'throw', error: 'fetch failed' }, ...Object.fromEntries(ACHIEVE.map((h) => [h, { kind: 'throw', error: 'fetch failed' }])) }
    const s = await tick(dead)
    expect(s.unmeasured).toBe(3)
    expect(logs.some((l) => l.includes('probe_unmeasured=true'))).toBe(true)
    await ticksFor(UNREACHABLE_ALERT_AFTER_MS + 10 * MIN, dead)
    expect(sent.filter((s) => s.kind === 'unreachable')).toHaveLength(0)
    for (const h of ACHIEVE) expect(kv.store.get(stateKey(h))?.value).toBe(before.get(stateKey(h))?.value)
  })

  it('posts one "probe cannot measure" line after its own window, under the control key with a claim', async () => {
    const { ticksFor, sent, claims } = makeDeps()
    await ticksFor(PROBE_BROKEN_AFTER_MS + 5 * MIN, { [CONTROL_HOST]: { kind: 'throw', error: 'fetch failed' } })
    expect(sent.filter((s) => s.kind === 'probe-broken')).toHaveLength(1)
    expect(sent.filter((s) => s.kind === 'control')).toHaveLength(0)
    expect(claims.claimed).toContain(PROBE_CONTROL_KEY)
  })

  // Two different alerts share the control key, so a control failing after the
  // probe had been unable to fetch was held for the probe alert's cooldown and
  // then posted as its reminder, "nothing about it has changed" included (#1768).
  it('posts the control failing after a probe that could not fetch as a new alert, not a reminder of it', async () => {
    const { ticksFor, sent, kv } = makeDeps()
    await ticksFor(PROBE_BROKEN_AFTER_MS + 5 * MIN, { [CONTROL_HOST]: { kind: 'throw', error: 'fetch failed' } })
    expect(sent.filter((s) => s.kind === 'probe-broken')).toHaveLength(1)

    await ticksFor(CONTROL_ALERT_AFTER_MS + 10 * MIN, { [CONTROL_HOST]: { kind: 'ok', status: 200 } })

    const control = sent.filter((s) => s.kind === 'control')
    expect(control).toHaveLength(1)
    expect((control[0].payload as { repeat: string | null }).repeat).toBeNull()
    expect((await readCondition(kv, PROBE_CONTROL_KEY))?.alerts).toBe(1)
  })
})

describe('a reminder about a host that does not answer (#1768)', () => {
  it('says nothing has changed only when the reason is the one already posted', async () => {
    const { ticksFor, tick, sent, kv } = makeDeps()
    const p = (error: string): Plan => ({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error } })
    await ticksFor(UNREACHABLE_ALERT_AFTER_MS + 5 * MIN, p('connect ECONNRESET'))
    kv.store.delete(`${unreachableKey('oauth.prd.ffngcp.com')}:cooldown`)
    await tick(p('connect ECONNRESET'))
    kv.store.delete(`${unreachableKey('oauth.prd.ffngcp.com')}:cooldown`)
    await tick(p('connect ETIMEDOUT'))

    const repeats = sent.filter((s) => s.kind === 'unreachable').map((s) => (s.payload as { repeat: string | null }).repeat)
    expect(repeats).toHaveLength(3)
    expect(repeats[0]).toBeNull()
    expect(repeats[1]).toContain('nothing about it has changed')
    expect(repeats[2]).toContain('same problem as before')
    expect(repeats[2]).not.toContain('nothing about it has changed')
  })
})

describe('failures of the probe\'s own machinery', () => {
  it('skips a host whose stored state cannot be read, without resetting its clock, and counts the error', async () => {
    const { tick, kv, logs } = makeDeps()
    const p = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error: 'x' } as Answer }
    await tick(p)
    const stored = kv.store.get(stateKey('oauth.prd.ffngcp.com'))?.value
    kv.unreadable.add(stateKey('oauth.prd.ffngcp.com'))
    const s = await tick(p)
    expect(s.errors.some((e) => e.includes('oauth.prd.ffngcp.com'))).toBe(true)
    expect(kv.store.get(stateKey('oauth.prd.ffngcp.com'))?.value).toBe(stored)
    expect(logs.some((l) => l.includes('state=unreadable'))).toBe(true)
  })

  it('replaces a malformed stored state rather than skipping that host on every later run (#1933)', async () => {
    for (const bad of ['garbage', '{"state":"blocked"}', '{"state":"weird","reason":"x","since":"2026-09-17T17:00:00.000Z"}', '{"state":"unreachable","reason":"x","since":"not a time"}']) {
      const { tick, ticksFor, kv, logs, sent } = makeDeps()
      await kv.put(stateKey('oauth.prd.ffngcp.com'), bad)
      const p = { ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'throw', error: 'connect ECONNRESET' } as Answer }
      const first = await tick(p)
      expect(first.errors.some((e) => e.includes('oauth.prd.ffngcp.com') && e.includes('state malformed')), bad).toBe(true)
      expect(logs.some((l) => l.includes('host=oauth.prd.ffngcp.com') && l.includes('state_malformed=true')), bad).toBe(true)
      expect(JSON.parse(kv.store.get(stateKey('oauth.prd.ffngcp.com'))!.value).state, bad).toBe('unreachable')
      // Judged normally from here: the host reads unreachable long enough to alert.
      await ticksFor(UNREACHABLE_ALERT_AFTER_MS, p)
      expect(sent.filter((s) => s.kind === 'unreachable').length, bad).toBe(1)
    }
  })

  it('keeps a still readable control pass time when it replaces a malformed control record', async () => {
    const { tick, kv } = makeDeps()
    await kv.put(stateKey(CONTROL_HOST), JSON.stringify({ state: 'blocked', reason: 'x', since: 'not a time', controlPassedAt: '2026-09-01T00:00:00.000Z' }))
    await tick(healthy())
    const stored = JSON.parse(kv.store.get(stateKey(CONTROL_HOST))!.value)
    expect(stored.controlPassedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('one host throwing inside the probe does not stop the others being recorded', async () => {
    const { deps, tick, logs } = makeDeps()
    const inner = deps.probe
    deps.probe = async (t) => { if (t.host === 'oauth.prd.ffngcp.com') throw new Error('boom'); return inner(t) }
    const s = await tick(healthy())
    expect(s.errors.some((e) => e.includes('boom'))).toBe(true)
    expect(logs.filter((l) => l.includes('event=partner_probe')).length).toBeGreaterThanOrEqual(3)
  })

  it('posts to every org that holds a Slack connection', async () => {
    const { tick, sent } = makeDeps({ resolveSlack: async () => [{ bot_token: 'a', default_channel: '#a' }, { bot_token: 'b', default_channel: '#b' }] })
    await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    expect(sent.filter((s) => s.kind === 'block').map((s) => s.channel).sort()).toEqual(['#a', '#b'])
  })
})

describe('observe mode and local dev', () => {
  it('in observe mode runs the whole state machine, logs what it would have posted, and posts nothing', async () => {
    const { tick, ticksFor, sent, logs, kv } = makeDeps({ env: { ACHIEVE_PARTNER_KEY: 'pk', APP_URL: 'https://app.test' } })
    const s = await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    expect(s.mode).toBe('observe')
    await ticksFor(RECOVERY_REARM_MINUTES * MIN + 10 * MIN, healthy())
    expect(sent).toHaveLength(0)
    expect(logs.some((l) => l.includes('would_post=block') && l.includes('oauth.prd.ffngcp.com'))).toBe(true)
    expect(logs.some((l) => l.includes('would_post=recovery'))).toBe(true)
    expect(kv.store.has(stateKey('oauth.prd.ffngcp.com'))).toBe(true)
  })

  it('in local dev probes and logs but writes nothing', async () => {
    const { tick, sent, kv, logs } = makeDeps({ env: { LOCAL_DEV: '1', PARTNER_PROBE_ALERTS: 'on', ACHIEVE_PARTNER_KEY: 'pk', APP_URL: 'x' } })
    const s = await tick({ ...healthy(), 'oauth.prd.ffngcp.com': { kind: 'block' } })
    expect(s.mode).toBe('silent')
    expect(sent).toHaveLength(0)
    expect(kv.store.size).toBe(0)
    expect(logs.some((l) => l.includes('event=partner_probe'))).toBe(true)
  })
})

describe('fetchProbe, the one real seam', () => {
  it('sends one GET with the target headers, never follows a redirect, carries a deadline, and caps the body', async () => {
    const { fetchProbe, PROBE_TIMEOUT_MS } = await import('../partner-reachability')
    const { BLOCK_CAPTURE_BODY_HEAD_BYTES } = await import('../code-node-deployer')
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response('x'.repeat(BLOCK_CAPTURE_BODY_HEAD_BYTES + 500), { status: 301, headers: { location: 'https://elsewhere.test/' } })
    }) as unknown as typeof fetch
    const target = probeTargets({ ACHIEVE_PARTNER_KEY: 'pk' })[0]
    const out = await fetchProbe(target, fakeFetch)
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.redirect).toBe('manual')
    expect((calls[0].init.headers as Record<string, string>)[ACHIEVE_KEY_HEADER]).toBe('pk')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
    expect(out.status).toBe(301)
    expect(out.redirect).toBe('https://elsewhere.test/')
    expect(out.body.length).toBe(BLOCK_CAPTURE_BODY_HEAD_BYTES)
  })

  it('turns a thrown fetch into an outcome with the error text rather than throwing', async () => {
    const { fetchProbe } = await import('../partner-reachability')
    const fakeFetch = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    const out = await fetchProbe(probeTargets({})[0], fakeFetch)
    expect(out.status).toBeNull()
    expect(out.error).toMatch(/ECONNREFUSED/)
  })
})

describe('resolveSlackForEveryOrg: the probe belongs to no org, so it posts to every one that has Slack', () => {
  const supabaseWith = (rows: Array<{ organization_id: string }> | null, error: { message: string } | null) => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: rows, error }) }) }),
  }) as unknown as import('@supabase/supabase-js').SupabaseClient

  it('returns one connection per org that holds one, deduplicating repeated org rows', async () => {
    const { resolveSlackForEveryOrg } = await import('../standing-alert')
    const asked: string[] = []
    const found = await resolveSlackForEveryOrg({
      supabase: supabaseWith([{ organization_id: 'a' }, { organization_id: 'b' }, { organization_id: 'a' }], null),
      getConnection: async (_s, orgId) => { asked.push(orgId); return orgId === 'a' ? { bot_token: 'ta', default_channel: '#a' } : null },
      lastGood: async () => new Map(),
      log: () => {},
      logPrefix: '[partner-reachability]',
    })
    expect(asked).toEqual(['a', 'b'])
    expect(found).toEqual([{ bot_token: 'ta', default_channel: '#a' }])
  })

  it('falls back to the last-good KV copy when the database does not answer, and says so', async () => {
    // A partner block has nothing to do with Supabase, so this alert must not go quiet
    // during a database wobble (L682).
    const { resolveSlackForEveryOrg } = await import('../standing-alert')
    const logs: string[] = []
    const found = await resolveSlackForEveryOrg({
      supabase: supabaseWith(null, { message: 'connection refused' }),
      getConnection: async () => { throw new Error('should not be asked') },
      lastGood: async () => new Map([['a', { bot_token: 'tk', default_channel: '#k' }]]),
      log: (l) => { logs.push(l) },
      logPrefix: '[partner-reachability]',
    })
    expect(found).toEqual([{ bot_token: 'tk', default_channel: '#k' }])
    expect(logs.some((l) => l.includes('last-good') && l.includes('connection refused'))).toBe(true)
  })

  it('returns an empty list, with the reason logged, when both the database and the copy fail', async () => {
    const { resolveSlackForEveryOrg } = await import('../standing-alert')
    const logs: string[] = []
    const found = await resolveSlackForEveryOrg({
      supabase: supabaseWith(null, { message: 'down' }),
      getConnection: async () => null,
      lastGood: async () => { throw new Error('kv unreadable') },
      log: (l) => { logs.push(l) },
      logPrefix: '[partner-reachability]',
    })
    expect(found).toEqual([])
    expect(logs.some((l) => l.includes('kv unreadable'))).toBe(true)
  })

  it('reports an unresolved Slack destination in the run summary, not only in a log line', async () => {
    const { tick } = makeDeps({ resolveSlack: async () => { throw new Error('slack lookup exploded') } })
    const s = await tick(healthy())
    expect(s.errors.some((e) => e.includes('slack lookup exploded'))).toBe(true)
  })
})
