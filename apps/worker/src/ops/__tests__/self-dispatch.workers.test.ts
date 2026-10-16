/**
 * Self-dispatch, proven inside workerd against the real wrangler.ops.toml (#1946,
 * the #1698 run engine's Spike 0 exit criteria).
 *
 * 1. The SELF service binding reaches OpsInternal: a real binding to this
 *    Worker's own named entrypoint, never a fetch (L3, L535).
 * 2. scheduled() reaches OpsInternal through that binding and records what it
 *    answered.
 * 3. OpsInternal fails closed behind the binding too: a probe without the
 *    current arming is refused.
 * 4. The public edge cannot reach it: every internal looking path on the default
 *    fetch handler answers the ops not found.
 *
 * What this cannot prove is that Cloudflare accepts a deployed Worker binding to
 * itself, and how the dispatched sub-invocation is limited there. Those are
 * Stage 2 measurements: docs/ops-ceilings-spike.md.
 */
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker, { OPS_IDENTITY_HEADER, type OpsEnv } from '../index'

const opsEnv = env as unknown as OpsEnv

describe('self-dispatch through the SELF binding (workerd)', () => {
  it('reaches OpsInternal and answers with the ops identity', async () => {
    expect(opsEnv.SELF).toBeDefined()
    expect(await opsEnv.SELF?.ping()).toEqual({ lane: 'ops', entrypoint: 'OpsInternal' })
  })

  it('carries scheduled() to OpsInternal and records the answer under the spike prefix', async () => {
    const nonce = `spike-workerd-${Date.now()}`
    const armed = { ...opsEnv, OPS_SPIKE_ARM: JSON.stringify({ probe: 'dispatch_ping', nonce, until: new Date(Date.now() + 3_600_000).toISOString() }) }
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), armed, ctx)
    await waitOnExecutionContext(ctx)
    const stored = await opsEnv.PORTING_TEE.get(`spike/1946/${nonce}/result.json`)
    expect(stored).not.toBeNull()
    expect(JSON.parse(await stored!.text())).toMatchObject({ probe: 'dispatch_ping', outcome: 'completed', result: { lane: 'ops', entrypoint: 'OpsInternal' } })
  })

  it('refuses a probe across the binding when this Worker is not armed for it', async () => {
    expect(await opsEnv.SELF!.probe({ kind: 'wall', nonce: 'spike-workerd-unarmed' })).toEqual({ refused: 'not_armed' })
  })
})

describe('the public edge (workerd)', () => {
  it.each(['/internal/run/r_1', '/ping', '/OpsInternal/ping', '/OpsInternal/probe', '/spike/1946/x'])('answers POST %s with the ops not found', async (path) => {
    const res = await worker.fetch(new Request(`https://ops.trypennie.dev${path}`, { method: 'POST', body: '{}' }), opsEnv)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(res.headers.get(OPS_IDENTITY_HEADER)).toBe('ops')
  })
})
