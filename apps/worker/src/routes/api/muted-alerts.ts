import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { listMutedAlerts, type MutedAlert } from '../../lib/muted-alerts'

type Variables = AuthVariables

const mutedAlerts = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/muted-alerts
// Powers the dashboard "Muted alerts" panel (#1047). Read-only: lists the
// export-alert cooldown keys currently suppressing a condition, with when each
// one lifts, so a deliberate silence is not mistaken for a healthy system.
//
// Auth: any authenticated, allowlisted user (jwtAuth, applied once in
// routes/api). Deliberately NOT org scoped: these alert mutes are global
// operational state. The export alerter fans one condition out to every Slack
// org, so there is no per-org mute to scope to, and the mutes carry no tenant
// data. KV read only, no Supabase, no writes.
//
// A KV read failure surfaces as a 500 rather than an empty list, because an
// empty list reads as "nothing is muted" (the healthy state) and that is the
// exact silence this panel exists to make legible (L98).
mutedAlerts.get('/', async (c) => {
  let muted: MutedAlert[]
  try {
    muted = await listMutedAlerts(c.env.IDEMPOTENCY)
  } catch (err) {
    console.error('[muted-alerts] could not list muted alerts:', err)
    return c.json({ error: 'Could not read the alert mute list' }, 500)
  }
  return c.json({ muted })
})

export default mutedAlerts
