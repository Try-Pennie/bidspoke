/**
 * OpsConnections reached as a real entrypoint inside workerd, against the real
 * wrangler.ops.toml (#2335, PR 8 of phase 5 of #1689).
 *
 * The Phase 0 spike (#2330) measured that a service binding to an entrypoint the
 * deployed ops Worker does not export deploys green and then throws "internal
 * error" on every call. Here the Workers runtime itself resolves OpsConnections
 * from the ops Worker's main module (the loopback binding enable_ctx_exports
 * gives every named entrypoint, the same resolution a service binding naming
 * `entrypoint = "OpsConnections"` gets), calls it over RPC, and gets the
 * refusal back as a value. Nothing here reaches a database: the test project
 * sets no ops database secret, so the answer names the one that is missing.
 */
import * as workers from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

interface OpsConnectionsRpc {
  verify(request: unknown): Promise<unknown>
  health(request: unknown): Promise<unknown>
  revoke(request: unknown): Promise<unknown>
}

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'

function opsConnections(): OpsConnectionsRpc {
  const exported = (workers as unknown as { exports?: Record<string, unknown> }).exports
  const entry = exported?.OpsConnections
  if (entry === undefined) throw new Error('the ops Worker\'s main module does not export OpsConnections as an entrypoint')
  return entry as OpsConnectionsRpc
}

describe('OpsConnections over RPC (workerd)', () => {
  it('is an entrypoint of the ops Worker, and answers a call as a value', async () => {
    expect(await opsConnections().health({ organization_id: ORG })).toMatchObject({
      ok: false, refused: 'ops_connections_not_configured', detail: expect.stringMatching(/OPS_SUPABASE_URL/),
    })
  })

  it('refuses a malformed request by name, on the far side of the call', async () => {
    expect(await opsConnections().verify({ organization_id: 'acme' })).toMatchObject({ ok: false, refused: 'ops_connections_request_invalid' })
    expect(await opsConnections().revoke('everything')).toMatchObject({ ok: false, refused: 'ops_connections_request_invalid' })
  })
})
