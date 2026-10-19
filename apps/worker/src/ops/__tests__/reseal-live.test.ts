/**
 * How the reseal is reached and run (#2333): OpsInternal.resealConnections,
 * through this Worker's own SELF binding only, and the minute cron that calls
 * it while OPS_RESEAL is set on the ops Worker (reseal-live.ts). Unset, nothing
 * runs; "preview" asks it to say what it would do; "apply" asks it to write.
 * The reseal's own rules are reseal.test.ts's.
 */
import { seal } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { OpsInternal, scheduledTick, type OpsEnv } from '../index'
import { liveResealDeps, RESEAL_DEADLINE_MS, ResealNotConfigured, scheduledReseal } from '../reseal-live'
import { KEYGEN_TIMEOUT_MS, opsKeyPair, type OpsKeyPair } from './ops-key-fixture'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '00000000-0000-4000-8000-000000002333'

let pair: OpsKeyPair
beforeAll(async () => {
  pair = await opsKeyPair(4096)
}, KEYGEN_TIMEOUT_MS)

function self(answer: () => unknown) {
  const calls: unknown[] = []
  return {
    calls,
    binding: {
      ping: async () => ({}),
      observe: async () => ({}),
      resealConnections: async (request: unknown) => { calls.push(request); return answer() },
    },
  }
}

function logs() {
  return vi.spyOn(console, 'log').mockImplementation(() => {})
}

const lines = (spy: ReturnType<typeof logs>) => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)

describe('scheduledReseal, the minute cron\'s call', () => {
  it('runs nothing and logs nothing while OPS_RESEAL is unset or blank', async () => {
    for (const mode of [undefined, '', '  ']) {
      const s = self(() => ({ ok: true }))
      const spy = logs()
      expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: mode, SELF: s.binding } as unknown as OpsEnv)).toBe('off')
      expect(s.calls).toEqual([])
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })

  it.each([['preview', false], ['apply', true]] as const)('asks OpsInternal through SELF to %s, and logs its report', async (mode, apply) => {
    const report = { ok: true, mode, current_kid: 'ops-2026-10', complete: true, rows: { current: 2 }, objects: { none: 2 }, left: 0, nothing_left: true, problems: [] }
    const s = self(() => report)
    const spy = logs()
    expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: mode, SELF: s.binding } as unknown as OpsEnv)).toBe('reported')
    expect(s.calls).toEqual([{ apply }])
    expect(lines(spy)).toEqual([{ event: 'ops_reseal', outcome: 'reported', asked: mode, ...report }])
    spy.mockRestore()
  })

  it('refuses a mode it does not know by name, and runs nothing', async () => {
    const s = self(() => ({ ok: true }))
    const spy = logs()
    expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: 'yes', SELF: s.binding } as unknown as OpsEnv)).toBe('refused')
    expect(s.calls).toEqual([])
    expect(lines(spy)).toEqual([{ event: 'ops_reseal', outcome: 'mode_unknown', detail: 'OPS_RESEAL must be preview or apply' }])
    spy.mockRestore()
  })

  it('logs a refusal the reseal answered, a missing SELF binding, a throw and a timeout by name, and never throws', async () => {
    const spy = logs()
    const refused = self(() => ({ ok: false, refused: 'no_current_kid', detail: 'no kid is current on this Worker, so nothing may be sealed' }))
    expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: 'apply', SELF: refused.binding } as unknown as OpsEnv)).toBe('refused')
    expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: 'apply' } as unknown as OpsEnv)).toBe('refused')
    const thrower = self(() => { throw new TypeError('the binding broke') })
    expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: 'apply', SELF: thrower.binding } as unknown as OpsEnv)).toBe('failed')
    const never = self(() => new Promise(() => {}))
    expect(await scheduledReseal({ LANE: 'ops', OPS_RESEAL: 'apply', SELF: never.binding } as unknown as OpsEnv, { delay: async () => {} })).toBe('failed')
    expect(lines(spy)).toEqual([
      { event: 'ops_reseal', outcome: 'refused', asked: 'apply', refused: 'no_current_kid', detail: 'no kid is current on this Worker, so nothing may be sealed' },
      { event: 'ops_reseal', outcome: 'self_missing', detail: 'the SELF binding is missing from this deploy' },
      // The error's kind only, never its message.
      { event: 'ops_reseal', outcome: 'failed', asked: 'apply', error: 'TypeError' },
      { event: 'ops_reseal', outcome: 'failed', asked: 'apply', error: `no answer within ${RESEAL_DEADLINE_MS / 1000} s` },
    ])
    spy.mockRestore()
  })
})

describe('the minute cron runs the reseal after the tick', () => {
  it('calls it once per tick, with the tick\'s env, after the tick has run', async () => {
    const order: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // With no database and no gateway the tick still runs its boundaries, and reports not_configured.
    const env = { LANE: 'ops' } as unknown as OpsEnv
    await scheduledTick({ scheduledTime: Date.UTC(2026, 9, 19, 14) }, env, async (e) => { order.push('reseal'); expect(e).toBe(env) }).catch(() => order.push('tick threw'))
    expect(order[0]).toBe('reseal')
    spy.mockRestore()
    errors.mockRestore()
  })

  it('still runs the reseal when the tick throws, and then raises the tick\'s throw', async () => {
    const reseal = vi.fn(async () => {})
    const env = { LANE: 'ops' } as unknown as OpsEnv
    const tick = await import('../tick')
    const failing = vi.spyOn(tick, 'runOpsTick').mockRejectedValue(new Error('the tick broke'))
    await expect(scheduledTick({ scheduledTime: Date.UTC(2026, 9, 19, 14) }, env, reseal)).rejects.toThrow('the tick broke')
    expect(reseal).toHaveBeenCalledTimes(1)
    failing.mockRestore()
  })

  it('runs no reseal outside the ops lane', async () => {
    const reseal = vi.fn(async () => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(scheduledTick({ scheduledTime: 0 }, { LANE: 'money' } as unknown as OpsEnv, reseal)).rejects.toThrow(/lane_not_ops/)
    expect(reseal).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('OpsInternal.resealConnections', () => {
  it('is on the entrypoint, so it is reached only through the SELF binding', () => {
    expect(Object.getOwnPropertyNames(OpsInternal.prototype)).toContain('resealConnections')
  })

  it('refuses outside the ops lane, and a request it cannot read, as values', async () => {
    const outside = new OpsInternal({} as ExecutionContext, { LANE: 'money' } as unknown as OpsEnv)
    expect(await outside.resealConnections({ apply: true })).toMatchObject({ ok: false, refused: 'lane_refused' })
    const inside = new OpsInternal({} as ExecutionContext, { LANE: 'ops' } as unknown as OpsEnv)
    expect(await inside.resealConnections({ apply: 'yes' })).toMatchObject({ ok: false, refused: 'request_invalid' })
    expect(await inside.resealConnections('apply')).toMatchObject({ ok: false, refused: 'request_invalid' })
  })

  it('refuses by name when a binding it needs is missing, before anything is read', async () => {
    const entry = new OpsInternal({} as ExecutionContext, { LANE: 'ops' } as unknown as OpsEnv)
    expect(await entry.resealConnections({})).toEqual({ ok: false, refused: 'not_configured', detail: 'the OPS_GATEWAY binding to the bidding Worker is missing from this deploy' })
  })

  it('previews by default, through the live bindings: asks every object without apply, and writes nothing', async () => {
    const committed = { 'ops-test-old': pair.publicPem }
    const envelope = await seal(committed, 'reseal live canary', { organization_id: ORG, connection_id: CONN, service: 'example', generation: 1, kid: 'ops-test-old' })
    const gateway = {
      opsConnections: vi.fn(async () => ({
        served_at: '2026-10-19T14:00:00.000Z', complete: true, tombstones: [],
        connections: [{ id: CONN, organization_id: ORG, service: 'example', generation: 1, envelope, public_config: {}, target: null, serve_until: '2026-10-19T20:00:00.000Z' }],
      })),
      replaceConnectionEnvelope: vi.fn(async () => { throw new Error('a preview writes nothing') }),
    }
    const resealLogin = vi.fn(async () => ({ ok: true, state: 'none', fromKid: null }))
    const tokens = { idFromName: (name: string) => name, get: () => ({ resealLogin }) }
    const env = { LANE: 'ops', OPS_GATEWAY: gateway, CONNECTION_TOKENS: tokens, OPS_CONNECTIONS_PRIVATE_KEY: pair.privatePem } as unknown as OpsEnv
    const deps = liveResealDeps(env, { registry: { currentKid: 'ops-test-new', publicKeys: { ...committed, 'ops-test-new': pair.publicPem } } })
    const { resealConnections } = await import('../reseal')
    const report = await resealConnections(deps, {})
    expect(report).toMatchObject({ ok: true, mode: 'preview', current_kid: 'ops-test-new', left: 1 })
    expect(resealLogin).toHaveBeenCalledWith({ organizationId: ORG, connectionId: CONN, service: 'example', apply: false })
    expect(gateway.replaceConnectionEnvelope).not.toHaveBeenCalled()
  }, KEYGEN_TIMEOUT_MS)

  it('names the missing token objects binding, since the logins they hold must be covered too', () => {
    const env = { LANE: 'ops', OPS_GATEWAY: {} } as unknown as OpsEnv
    expect(() => liveResealDeps(env)).toThrow(ResealNotConfigured)
    expect(() => liveResealDeps(env)).toThrow('the CONNECTION_TOKENS binding is missing from this deploy')
  })
})
