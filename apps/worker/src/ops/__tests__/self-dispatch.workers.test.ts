/**
 * Self-dispatch, proven inside workerd against the real wrangler.ops.toml (#1946,
 * the #1698 run engine's Spike 0 exit criteria).
 *
 * 1. The SELF service binding reaches OpsInternal: a real binding to this
 *    Worker's own named entrypoint, never a fetch (L3, L535).
 * 2. The public edge cannot reach it: every internal looking path on the default
 *    fetch handler answers the ops not found.
 *
 * In production the same binding was accepted on upload and a scheduled()
 * invocation reached OpsInternal through it (2026-10-16): docs/ops-ceilings-spike.md P5.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { dispatchKey, signDispatch } from '../dispatch-auth'
import worker, { OPS_IDENTITY_HEADER, type OpsEnv } from '../index'

const opsEnv = env as unknown as OpsEnv

describe('self-dispatch through the SELF binding (workerd)', () => {
  it('reaches OpsInternal and answers with the ops identity', async () => {
    expect(opsEnv.SELF).toBeDefined()
    expect(await opsEnv.SELF?.ping()).toEqual({ lane: 'ops', entrypoint: 'OpsInternal' })
  })
})

describe('the public edge (workerd)', () => {
  it.each(['/internal/run/r_1', '/ping', '/OpsInternal/ping', '/spike/1946/x'])('answers POST %s with the ops not found', async (path) => {
    const res = await worker.fetch(new Request(`https://ops.trypennie.dev${path}`, { method: 'POST', body: '{}' }), opsEnv)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(res.headers.get(OPS_IDENTITY_HEADER)).toBe('ops')
  })
})

/**
 * The minute cron's dispatch through the real binding (#1949): a signed observe
 * call reaches OpsInternal and is verified there, and a tampered one is refused
 * across the binding, so the refusal is the receiver's, not a caller's check.
 */
describe('observe through the SELF binding (workerd)', () => {
  const master = 'workerd-test-master'
  const item = { kind: 'probe' as const }

  it('verifies a signed dispatch and answers what it observed', async () => {
    if (!opsEnv.PORTING_CAPTURE_MASTER) return expect.unreachable('the test config sets PORTING_CAPTURE_MASTER')
    const signed = await signDispatch(await dispatchKey(opsEnv.PORTING_CAPTURE_MASTER), { v: 1, tick_id: 'workerd', signed_at: new Date().toISOString(), item })
    expect(await opsEnv.SELF?.observe(signed)).toEqual({ observed: true, tick_id: 'workerd', kind: 'probe' })
  })

  it('refuses one signed with another key, on the far side of the binding', async () => {
    const signed = await signDispatch(await dispatchKey(`${master}-other`), { v: 1, tick_id: 'workerd', signed_at: new Date().toISOString(), item })
    expect(await opsEnv.SELF!.observe(signed)).toEqual({ observed: false, refused: 'bad_signature' })
  })
})
