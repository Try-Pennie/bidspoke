// Circuit breaker status + manual reset endpoints
// GET  /api/circuit/:name/status  — view current state
// POST /api/circuit/:name/reset   — manually close the circuit

import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'

type Variables = AuthVariables

const circuit = new Hono<{ Bindings: Env; Variables: Variables }>()

circuit.get('/:name/status', async (c) => {
  const name = c.req.param('name')
  const cb = new CircuitBreakerClient(c.env, name)
  const status = await cb.status()
  return c.json(status)
})

circuit.post('/:name/reset', async (c) => {
  const name = c.req.param('name')
  const cb = new CircuitBreakerClient(c.env, name)
  await cb.reset()
  return c.json({ ok: true, state: 'closed' })
})

export default circuit
