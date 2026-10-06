/**
 * The ops Worker serves only the ops lane (#1709, plan 0.E).
 *
 * The bidding Worker's lane is fixed in code (moneyRuntime, #1707). The ops
 * Worker reads its lane from the LANE var in wrangler.ops.toml, and refuses to
 * serve anything, by name, when that var is unset or names another lane: a
 * deploy that lost or swapped its config must not answer as the ops Worker.
 * The refusal comes before routing, before any secret is read and before any
 * body is. That wrangler.ops.toml sets LANE is asserted in
 * apps/web/src/lib/__tests__/ops-worker-config.test.ts, which can read files.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOpsHandler, type OpsEnv } from '../index'

function setup(lane: string | undefined) {
  const bucket = { put: vi.fn(), head: vi.fn() }
  const env = { LANE: lane, PORTING_CAPTURE_MASTER: 'm', PORTING_TEE: bucket as unknown as R2Bucket } as OpsEnv
  return { handle: createOpsHandler(), env, bucket }
}

const capture = () => new Request('https://ops.test/porting/capture/p_ANY', { method: 'POST', body: '{}' })

describe('the ops Worker lane', () => {
  it.each([[undefined], ['']])('refuses every request by name when LANE is %j', async (lane) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handle, env, bucket } = setup(lane)
    for (const req of [capture(), new Request('https://ops.test/anything-else')]) {
      const res = await handle(req, env)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'lane_unset' })
    }
    expect(bucket.put).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join('\n')).toContain('"outcome":"lane_unset"')
    log.mockRestore()
  })

  it.each([['money'], ['OPS'], ['ops ']])('refuses every request naming the lane when LANE is %j', async (lane) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handle, env, bucket } = setup(lane)
    const res = await handle(capture(), env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'lane_not_ops', lane })
    expect(bucket.put).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('serves when LANE is ops', async () => {
    const { handle, env } = setup('ops')
    const res = await handle(new Request('https://ops.test/nowhere'), env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})
