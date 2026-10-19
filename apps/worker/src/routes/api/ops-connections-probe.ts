/**
 * GET /api/admin/ops-connections-probe: the deploy's real call through the
 * OPS_CONNECTIONS binding (#2335, PR 9 of phase 5 of #1689).
 *
 * The Phase 0 spike (#2330) measured that Cloudflare deploys a binding to an
 * entrypoint the deployed ops Worker does not export green, and every call then
 * throws "internal error; reference = <id>". Nothing in the deploy refuses it,
 * so Deploy calls this route after the Workers deploy
 * (.github/scripts/ops-connections-probe.mjs) and fails the run unless it
 * answers 200.
 *
 * Who may call it: any signed in user on the access allowlist, as for every
 * /api/admin route (jwtAuth; there is no admin role). Whose data it touches:
 * nobody's. It sends OpsConnections.health the probe request
 * (OPS_CONNECTIONS_PROBE_REQUEST), which names no organization, so ops refuses
 * it by name after its lane check and before it builds a database client: no
 * read and no write on either Worker, and nothing of the caller's organization
 * crosses. Its cost is one refused call, bounded by health's deadline.
 *
 *   200 { ok: true, method, answer }  ops answered the expected refusal: the
 *       binding resolved, the deployed ops exports OpsConnections with health,
 *       and its LANE is ops
 *   503 ops_connections_unavailable   the binding is absent, threw (reference
 *       id kept), did not answer in time, or answered something unreadable
 *   502 ops_connections_probe_unexpected  ops answered, but not that refusal
 */
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { OPS_CONNECTIONS_UNAVAILABLE_STATUS, probeOpsConnections } from '../../lib/ops-connections-client'

const opsConnectionsProbe = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

opsConnectionsProbe.get('/', async (c) => {
  const result = await probeOpsConnections(c.env)
  switch (result.outcome) {
    case 'answered':
      return c.json({ ok: true, method: result.method, answer: result.answer })
    case 'unavailable':
      return c.json(
        { error: 'ops_connections_unavailable', method: result.method, cause: result.cause, reference: result.reference, message: result.detail },
        OPS_CONNECTIONS_UNAVAILABLE_STATUS,
      )
    case 'unexpected':
      return c.json(
        { error: 'ops_connections_probe_unexpected', method: result.method, answer: result.answer, message: `OpsConnections answered ${result.answer}, not the refusal the probe request earns` },
        502,
      )
  }
})

export default opsConnectionsProbe
