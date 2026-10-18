/**
 * POST /api/admin/seal-canary: the production half of the ops key restore drill
 * (#2333, phase 3 of #1689).
 *
 * Seals the fixed restore drill canary (packages/connection-seal/src/canary.ts)
 * to the ops PUBLIC key that `kid` names in OPS_CONNECTION_PUBLIC_KEYS, and
 * returns the envelope. scripts/restore-drill/open-seal-canary.ts then opens it
 * with the escrowed private key from 1Password, which proves that copy opens
 * what production seals before any real ops login depends on it (L535, L1).
 *
 * Who may call it: any signed in user on the access allowlist, as for every
 * /api/admin route (there is no admin role). Whose data it touches: nobody's.
 * It reads only the public keys committed in code, and its one write is an
 * audit_log row in the caller's organization naming the caller. It STORES
 * NOTHING ELSE: the envelope is returned and kept nowhere, so no canary service
 * enters service_connections or its CHECK, and nothing appears in GET
 * /api/connections. The canary is fixed text that says it is not a secret,
 * bound to the nil organization and connection, so its envelope can never be
 * opened as a login nor a login as it.
 *
 * Body: { kid }, a kid committed in keys.ts (the current one, or NEXT during a
 * rotation). Anything else is refused by name.
 *
 * The answer carries `drill_id`, the audit row's entity id, and `audited`,
 * whether that row actually landed, since a failed audit write must not read as
 * recorded (L11).
 */
import { Hono } from 'hono'
import { KID_PATTERN, OPS_CONNECTION_PUBLIC_KEYS, RESTORE_DRILL_CANARY, restoreDrillAad, seal } from '@bidspoke/connection-seal'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { recordAuditLog } from '../../lib/audit'
import { formatErr } from '../../lib/format-error'

const sealCanary = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

type KidCheck = { ok: true; kid: string } | { ok: false; error: string; message: string }

/** The kid asked for, if keys.ts commits a public key under it. */
export function committedKid(body: unknown): KidCheck {
  const kid = typeof body === 'object' && body !== null ? (body as { kid?: unknown }).kid : undefined
  const committed = Object.keys(OPS_CONNECTION_PUBLIC_KEYS)
  if (typeof kid !== 'string') {
    return { ok: false, error: 'kid_required', message: `kid must be one of the committed kids: ${committed.join(', ') || 'none'}` }
  }
  if (!KID_PATTERN.test(kid)) {
    return { ok: false, error: 'kid_invalid', message: `kid must match ${String(KID_PATTERN)}` }
  }
  // Own properties only: "constructor" is a well formed kid every object answers to.
  if (!Object.hasOwn(OPS_CONNECTION_PUBLIC_KEYS, kid)) {
    return {
      ok: false,
      error: 'kid_unknown',
      message: `no ops public key is committed under kid ${kid}; the committed kids are: ${committed.join(', ') || 'none'}`,
    }
  }
  return { ok: true, kid }
}

sealCanary.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body: unknown = await c.req.json().catch(() => undefined)
  const check = committedKid(body)
  if (!check.ok) return c.json({ error: check.error, message: check.message }, 400)

  let envelope
  try {
    envelope = await seal(OPS_CONNECTION_PUBLIC_KEYS, RESTORE_DRILL_CANARY, restoreDrillAad(check.kid))
  } catch (err) {
    return c.json({ error: 'seal_failed', message: formatErr(err) }, 500)
  }

  const drillId = crypto.randomUUID()
  const audited = await recordAuditLog(
    createSupabaseClient(c.env),
    orgId,
    'ops_key_restore_drill',
    drillId,
    'canary_sealed',
    userId,
    { kid: check.kid },
  )
  return c.json({ drill_id: drillId, kid: check.kid, envelope, audited })
})

export default sealCanary
