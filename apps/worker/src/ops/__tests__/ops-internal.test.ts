/**
 * OpsInternal, the ops Worker's internal entrypoint (#1946, the self-dispatch the
 * #1698 run engine needs), and the public edge that must never reach it.
 *
 * Self-dispatch rides a service binding to a NAMED entrypoint (wrangler.ops.toml:
 * SELF, entrypoint OpsInternal). Cloudflare routes a public request only to a
 * Worker's default export, so the public edge cannot call OpsInternal at all; the
 * default fetch handler must also never grow a path that forwards to it. These
 * tests pin both, and that OpsInternal itself refuses outside the ops lane and
 * runs a probe only for the current arming (fail closed behind the binding too).
 * That the real binding reaches OpsInternal inside workerd is proven in
 * self-dispatch.workers.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import worker, { OpsInternal, OPS_IDENTITY_HEADER, type OpsEnv } from '../index'
import { handleCalleeProbe, opsInternalIdentity, OpsInternalRefused } from '../internal'
import type { ProbeRuntime } from '../spike/ceilings'

const NOW = Date.parse('2026-10-20T15:00:00Z')
const arm = (probe: string, nonce = 'spike-test-0002') =>
  JSON.stringify({ probe, nonce, until: new Date(NOW + 3_600_000).toISOString() })

function runtime(): ProbeRuntime & { logs: Record<string, unknown>[] } {
  let t = NOW
  const logs: Record<string, unknown>[] = []
  return {
    logs,
    now: () => t,
    sleep: async (ms) => { t += ms },
    burn: () => {},
    log: (e) => { logs.push(e) },
    limits: { wallCapMs: 20_000, wallStepMs: 10_000, cpuSliceUnits: 1, cpuMaxSlices: 2, cpuWallCapMs: 60_000, cpuLogEvery: 1, subrequestCap: 3, subrequestLogEvery: 1, fanout: 2 },
  }
}

const bucket = () => ({ head: vi.fn(async () => null), put: vi.fn() })

describe('OpsInternal identity', () => {
  it('answers with its lane and name in the ops lane', () => {
    expect(opsInternalIdentity({ LANE: 'ops' })).toEqual({ lane: 'ops', entrypoint: 'OpsInternal' })
  })

  it.each([[undefined], [''], ['money']])('refuses by name when LANE is %j', (lane) => {
    expect(() => opsInternalIdentity({ LANE: lane })).toThrow(OpsInternalRefused)
    expect(() => opsInternalIdentity({ LANE: lane })).toThrow(/lane/)
  })
})

describe('OpsInternal.probe', () => {
  it('runs the callee probe asked for when the arming names a dispatch probe and the same nonce', async () => {
    const rt = runtime()
    const b = bucket()
    const env = { LANE: 'ops', OPS_SPIKE_ARM: arm('dispatch_wall'), PORTING_TEE: b as unknown as R2Bucket }
    expect(await handleCalleeProbe(env, { kind: 'wall', nonce: 'spike-test-0002' }, rt)).toEqual({ elapsedMs: 20_000, steps: 2 })
    expect(rt.logs.every((l) => l.role === 'callee')).toBe(true)
  })

  it('runs the subrequest probe against the spike key only', async () => {
    const b = bucket()
    const env = { LANE: 'ops', OPS_SPIKE_ARM: arm('dispatch_subrequests'), PORTING_TEE: b as unknown as R2Bucket }
    expect(await handleCalleeProbe(env, { kind: 'subrequests', nonce: 'spike-test-0002' }, runtime())).toEqual({ completed: 3, error: null })
    expect(b.head).toHaveBeenCalledWith('spike/1946/subrequest-probe')
  })

  it.each([
    ['unarmed', undefined, { kind: 'wall', nonce: 'spike-test-0002' }, 'not_armed'],
    ['another nonce', arm('dispatch_wall'), { kind: 'wall', nonce: 'spike-test-9999' }, 'nonce_mismatch'],
    ['a cron probe armed', arm('cron_wall'), { kind: 'wall', nonce: 'spike-test-0002' }, 'not_a_dispatch_arming'],
    ['an unknown kind', arm('dispatch_wall'), { kind: 'drop', nonce: 'spike-test-0002' }, 'unknown_kind'],
  ])('refuses %s and runs nothing', async (_label, armValue, request, reason) => {
    const rt = runtime()
    const b = bucket()
    const env = { LANE: 'ops', OPS_SPIKE_ARM: armValue, PORTING_TEE: b as unknown as R2Bucket }
    await expect(handleCalleeProbe(env, request as never, rt)).rejects.toThrow(reason)
    expect(b.head).not.toHaveBeenCalled()
    expect(rt.logs.some((l) => l.stage === 'progress')).toBe(false)
  })

  it('refuses outside the ops lane before reading the arm', async () => {
    const env = { LANE: 'money', OPS_SPIKE_ARM: arm('dispatch_wall'), PORTING_TEE: bucket() as unknown as R2Bucket }
    await expect(handleCalleeProbe(env, { kind: 'wall', nonce: 'spike-test-0002' }, runtime())).rejects.toThrow(OpsInternalRefused)
  })
})

describe('OpsInternal over the binding', () => {
  const ctx = {} as ExecutionContext
  it('answers a refused probe with the reason as a value, since an error crossing RPC keeps only its message', async () => {
    const entry = new OpsInternal(ctx, { LANE: 'ops', PORTING_TEE: bucket() } as unknown as OpsEnv)
    expect(await entry.probe({ kind: 'wall', nonce: 'spike-test-0002' })).toEqual({ refused: 'not_armed' })
  })

  it('answers ping with the identity', () => {
    const entry = new OpsInternal(ctx, { LANE: 'ops' } as unknown as OpsEnv)
    expect(entry.ping()).toEqual({ lane: 'ops', entrypoint: 'OpsInternal' })
  })
})

describe('the ops Worker module', () => {
  it('exports OpsInternal as a named entrypoint beside the default handler', () => {
    expect(typeof OpsInternal).toBe('function')
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
  })
})

describe('the public edge never reaches OpsInternal (fail closed)', () => {
  const env = (b: { put: ReturnType<typeof vi.fn>; head: ReturnType<typeof vi.fn> }) => {
    const self = { ping: vi.fn(), probe: vi.fn() }
    return { self, env: { LANE: 'ops', PORTING_CAPTURE_MASTER: 'm', OPS_SPIKE_ARM: arm('dispatch_ping'), PORTING_TEE: b as unknown as R2Bucket, SELF: self } as unknown as OpsEnv }
  }

  it.each([
    ['POST', '/internal/run/r_1'],
    ['GET', '/internal/run/r_1'],
    ['POST', '/ping'],
    ['POST', '/OpsInternal/ping'],
    ['POST', '/OpsInternal/probe'],
    ['GET', '/spike/1946/anything'],
    ['POST', '/porting/capture/../../internal/run/r_1'],
  ])('answers %s %s with the ops not found, touching no binding', async (method, path) => {
    const b = bucket()
    const { self, env: e } = env(b)
    const res = await worker.fetch(new Request(`https://ops.trypennie.dev${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) }), e)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(res.headers.get(OPS_IDENTITY_HEADER)).toBe('ops')
    expect(self.ping).not.toHaveBeenCalled()
    expect(self.probe).not.toHaveBeenCalled()
    expect(b.put).not.toHaveBeenCalled()
    expect(b.head).not.toHaveBeenCalled()
  })
})
