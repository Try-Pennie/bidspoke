/**
 * OpsInternal, the ops Worker's internal entrypoint (#1946, the self-dispatch the
 * #1698 run engine needs), and the public edge that must never reach it.
 *
 * Self-dispatch rides a service binding to a NAMED entrypoint (wrangler.ops.toml:
 * SELF, entrypoint OpsInternal). Cloudflare routes a public request only to a
 * Worker's default export, so the public edge cannot call OpsInternal at all
 * (measured in production on 2026-10-16, docs/ops-ceilings-spike.md P5 and P6);
 * the default fetch handler must also never grow a path that forwards to it.
 * These tests pin both, and that OpsInternal refuses outside the ops lane. That
 * the real binding reaches OpsInternal inside workerd is proven in
 * self-dispatch.workers.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import worker, { OpsInternal, OPS_IDENTITY_HEADER, type OpsEnv } from '../index'
import { dispatchKey, signDispatch } from '../dispatch-auth'
import { observeDispatch, opsInternalIdentity, OpsInternalRefused } from '../internal'

const NOW = Date.parse('2026-10-17T10:02:31.000Z')

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

describe('OpsInternal over the binding', () => {
  it('answers ping with the identity', () => {
    const entry = new OpsInternal({} as ExecutionContext, { LANE: 'ops' } as unknown as OpsEnv)
    expect(entry.ping()).toEqual({ lane: 'ops', entrypoint: 'OpsInternal' })
  })

  it('exposes ping and observe and nothing else until the run engine adds its run method (B3)', () => {
    expect(Object.getOwnPropertyNames(OpsInternal.prototype).sort()).toEqual(['constructor', 'observe', 'ping'])
  })

  it('observe verifies a signed dispatch and answers what it observed (#1949)', async () => {
    const env = { LANE: 'ops', PORTING_CAPTURE_MASTER: 'master-secret' } as unknown as OpsEnv
    const signed = await signDispatch(await dispatchKey('master-secret'), { v: 1, tick_id: 'tick-1', signed_at: new Date(NOW).toISOString(), item: { kind: 'probe' } })
    expect(await observeDispatch(env, signed, NOW)).toEqual({ observed: true, tick_id: 'tick-1', kind: 'probe' })
  })

  it('observe refuses outside the ops lane, without the master secret, and on a bad signature', async () => {
    const signed = await signDispatch(await dispatchKey('master-secret'), { v: 1, tick_id: 'tick-1', signed_at: new Date(NOW).toISOString(), item: { kind: 'probe' } })
    await expect(observeDispatch({ LANE: 'money', PORTING_CAPTURE_MASTER: 'master-secret' } as unknown as OpsEnv, signed, NOW)).rejects.toThrow(/lane_not_ops/)
    await expect(observeDispatch({ LANE: 'ops' } as unknown as OpsEnv, signed, NOW)).rejects.toThrow(/dispatch_key_unset/)
    await expect(observeDispatch({ LANE: 'ops', PORTING_CAPTURE_MASTER: 'another' } as unknown as OpsEnv, signed, NOW)).rejects.toThrow(/bad_signature/)
  })

  it('the entrypoint answers a refusal as a value, so nothing throws across the binding', async () => {
    const signed = await signDispatch(await dispatchKey('another'), { v: 1, tick_id: 'tick-1', signed_at: new Date().toISOString(), item: { kind: 'probe' } })
    const entry = new OpsInternal({} as ExecutionContext, { LANE: 'ops', PORTING_CAPTURE_MASTER: 'master-secret' } as unknown as OpsEnv)
    expect(await entry.observe(signed)).toEqual({ observed: false, refused: 'bad_signature' })
  })
})

describe('the ops Worker module', () => {
  it('exports OpsInternal as a named entrypoint beside the default fetch handler and the minute cron (#1949)', () => {
    expect(typeof OpsInternal).toBe('function')
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
  })
})

describe('the public edge never reaches OpsInternal (fail closed)', () => {
  const env = (b: ReturnType<typeof bucket>) => {
    const self = { ping: vi.fn() }
    return { self, env: { LANE: 'ops', PORTING_CAPTURE_MASTER: 'm', PORTING_TEE: b as unknown as R2Bucket, SELF: self } as unknown as OpsEnv }
  }

  it.each([
    ['POST', '/internal/run/r_1'],
    ['GET', '/internal/run/r_1'],
    ['POST', '/ping'],
    ['POST', '/OpsInternal/ping'],
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
    expect(b.put).not.toHaveBeenCalled()
    expect(b.head).not.toHaveBeenCalled()
  })
})
