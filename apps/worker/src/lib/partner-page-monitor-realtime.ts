/**
 * The partners page delivery monitor acting as a signed in person (#2135): the
 * sign in and the private Realtime join, which must run with the monitor user's
 * JWT, not the service key, or they would prove nothing about what a person's
 * page can do.
 *
 * The one place in the Worker that builds a Supabase client with the publishable
 * key. It reads and writes no table and calls no RPC: the service role client
 * guard (apps/web/src/lib/__guards__/worker/worker-service-role-client-guard.test.ts)
 * exempts this file on exactly that condition and fails if a `.from(` or `.rpc(`
 * appears here.
 *
 * The subscriber is the one PR0 proved in workerd (packages/realtime-spike/
 * worker/index.ts, ADR 0012: SUBSCRIBED and received 106 ms after the send).
 */
import { createClient, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'
import { PARTNER_PAGE_NOTICE_EVENT } from '@bidspoke/partner-page-live'
import { formatErr } from './format-error'
import type { JoinAnswer, MeasureDeps } from './partner-page-monitor'

/** How long one join may take before it counts as refused. */
export const JOIN_TIMEOUT_MS = 10_000

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const

/** Signs the monitor user in with its password. Never throws. */
export function signInAsMonitor(url: string, publishableKey: string): MeasureDeps['signIn'] {
  return async (email, password) => {
    try {
      const client = createClient(url, publishableKey, CLIENT_OPTIONS)
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error) return { ok: false, reason: error.message }
      const jwt = data.session?.access_token
      if (!jwt) return { ok: false, reason: 'the sign in returned no session' }
      // Local scope revokes this session's refresh token, so a run every five
      // minutes leaves no live session behind.
      return { ok: true, jwt, signOut: async () => { await client.auth.signOut({ scope: 'local' }) } }
    } catch (e) {
      return { ok: false, reason: formatErr(e) }
    }
  }
}

/** Joins a private topic as the person the JWT names, as the page does. Never throws. */
export async function joinPrivateTopic(url: string, publishableKey: string, jwt: string, topic: string, onPayload: (payload: unknown) => void): Promise<JoinAnswer> {
  const client = createClient(url, publishableKey, CLIENT_OPTIONS)
  try {
    await client.realtime.setAuth(jwt)
  } catch (e) {
    return { ok: false, reason: `the JWT was not accepted by Realtime: ${formatErr(e)}`, missingPartition: false }
  }
  const channel = client
    .channel(topic, { config: { private: true } })
    .on('broadcast', { event: PARTNER_PAGE_NOTICE_EVENT }, (message: { payload?: unknown }) => onPayload(message.payload))
  const leave = async () => {
    await client.removeChannel(channel)
    await client.realtime.disconnect()
  }
  return new Promise<JoinAnswer>((resolve) => {
    let settled = false
    const settle = (answer: JoinAnswer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!answer.ok) void leave().catch(() => undefined)
      resolve(answer)
    }
    const timer = setTimeout(() => settle({ ok: false, reason: `Realtime gave no answer to the join within ${JOIN_TIMEOUT_MS / 1000} seconds`, missingPartition: false }), JOIN_TIMEOUT_MS)
    channel.subscribe((status, err) => {
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        settle({ ok: true, leave })
        return
      }
      const reason = err?.message ?? String(status)
      // Realtime refuses a private join with MissingPartition until the day's
      // partition exists (ADR 0012, measured on production 2026-10-15).
      settle({ ok: false, reason, missingPartition: /MissingPartition/.test(reason) })
    })
  })
}
