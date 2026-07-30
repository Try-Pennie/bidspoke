/**
 * #327: the root handler exposes the commit the worker was deployed from
 * (DEPLOYED_SHA, stamped by the deploy workflow). A scheduled check compares
 * this against the latest worker-touching commit on main to catch a "committed
 * but never deployed" stranded worker.
 *
 * This covers only the runtime half, and it does so by handing DEPLOYED_SHA
 * straight to the handler. It is therefore structurally incapable of noticing
 * that no deploy supplies one, and for a long time none did (#726: pnpm
 * swallowed the `--var` flag, so the live worker answered "unknown" while these
 * assertions stayed green). Delivery is guarded separately by
 * apps/web/src/lib/__tests__/deploy-sha-wiring.test.ts. Keep both.
 */
import { describe, it, expect } from 'vitest'
import worker from '../index'
import type { Env } from '../index'

function get(path: string, env: Partial<Env>) {
  return worker.fetch(new Request(`http://localhost${path}`), env as Env, {} as ExecutionContext)
}

describe('GET / deploy version (#327)', () => {
  it('reports the deployed commit from DEPLOYED_SHA', async () => {
    const res = await get('/', { DEPLOYED_SHA: 'abc1234' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; service: string; version: string }
    expect(body.status).toBe('ok')
    expect(body.service).toBe('bidspoke-worker')
    expect(body.version).toBe('abc1234')
  })

  it("falls back to 'unknown' when DEPLOYED_SHA is unset", async () => {
    const res = await get('/', {})
    const body = (await res.json()) as { version: string }
    expect(body.version).toBe('unknown')
  })
})
