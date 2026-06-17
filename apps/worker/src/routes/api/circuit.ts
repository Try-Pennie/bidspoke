// Circuit breaker status + manual reset endpoints
// GET  /api/circuit/:name/status  — view current state
// POST /api/circuit/:name/reset   — manually close the circuit

import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const circuit = new Hono<{ Bindings: Env; Variables: Variables }>()

// Breaker names are partner slugs (the engine only ever opens a breaker as
// CircuitBreakerClient(env, partner.slug)). Verify the slug belongs to the
// caller's org before reading/resetting it — otherwise any authenticated user
// could read or force-close any partner's breaker mid-incident (#103). Returns
// the partner_config row (incl. its id, used as the audit entity id) or null.
async function ownedPartner(env: Env, orgId: string, slug: string) {
  const supabase = createSupabaseClient(env)
  const { data } = await supabase
    .from('partner_configs')
    .select('id, slug')
    .eq('slug', slug)
    .eq('organization_id', orgId)
    .maybeSingle()
  return { supabase, partner: data as { id: string; slug: string } | null }
}

circuit.get('/:name/status', async (c) => {
  const { orgId } = c.get('user')
  const slug = c.req.param('name')
  const { partner } = await ownedPartner(c.env, orgId, slug)
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  const cb = new CircuitBreakerClient(c.env, slug)
  const status = await cb.status()
  return c.json(status)
})

circuit.post('/:name/reset', async (c) => {
  const { orgId, userId } = c.get('user')
  const slug = c.req.param('name')
  const { supabase, partner } = await ownedPartner(c.env, orgId, slug)
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  const cb = new CircuitBreakerClient(c.env, slug)
  await cb.reset()

  await writeAuditLog(supabase, orgId, 'circuit_breaker', partner.id, 'circuit_force_closed', userId, { name: slug })

  return c.json({ ok: true, state: 'closed' })
})

export default circuit
