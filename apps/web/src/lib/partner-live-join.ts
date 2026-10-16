/**
 * The browser's join of the partners page channel (#2135, PR4 of #2114), the
 * JoinFn PartnerLiveChannel is given on the page.
 *
 * Realtime admits a private join only for the person its JWT names (ADR 0012),
 * so the session's token is set before each join and again on every refresh:
 * a socket left on an expired token is refused at its next rejoin. The same
 * subscriber the delivery monitor uses (apps/worker/src/lib/
 * partner-page-monitor-realtime.ts), with the browser's session in place of a
 * sign in.
 */
import { PARTNER_PAGE_NOTICE_EVENT } from '@bidspoke/partner-page-live'
import type { JoinAnswer, JoinFn } from './partner-live-channel'

/** How long one join may take before it counts as refused (the monitor's figure). */
export const JOIN_TIMEOUT_MS = 10_000

type SubscribeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'

interface LiveChannelHandle {
  on(type: 'broadcast', filter: { event: string }, handler: (message: { payload?: unknown }) => void): LiveChannelHandle
  subscribe(callback: (status: SubscribeStatus, err?: Error) => void): LiveChannelHandle
}

/** The part of the Supabase browser client the join uses. */
export interface LiveSupabase {
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string } | null } }>
    onAuthStateChange(callback: (event: string, session: { access_token: string } | null) => void): { data: { subscription: { unsubscribe(): void } } }
  }
  realtime: { setAuth(token: string): Promise<void> | void }
  channel(topic: string, opts: { config: { private: true } }): LiveChannelHandle
  removeChannel(channel: LiveChannelHandle): Promise<unknown>
}

export interface BrowserJoinOptions {
  timeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => () => void
}

const realSetTimeout = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function browserJoin(client: LiveSupabase, opts: BrowserJoinOptions = {}): { join: JoinFn; dispose: () => void } {
  const timeoutMs = opts.timeoutMs ?? JOIN_TIMEOUT_MS
  const schedule = opts.setTimeout ?? realSetTimeout
  // A refreshed session gets a new token; Realtime is told at once (the issue's
  // "re-run setAuth on session refresh"), so a rejoin is never made on the old one.
  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (session?.access_token && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) {
      void Promise.resolve(client.realtime.setAuth(session.access_token)).catch(() => undefined)
    }
  })

  const join: JoinFn = async (topic, onPayload, onDrop) => {
    let token: string | undefined
    try {
      token = (await client.auth.getSession()).data.session?.access_token
    } catch (err) {
      return { ok: false, reason: `The session could not be read: ${message(err)}`, missingPartition: false }
    }
    if (!token) return { ok: false, reason: 'You are signed out.', missingPartition: false }
    try {
      await client.realtime.setAuth(token)
    } catch (err) {
      return { ok: false, reason: `Realtime did not accept the session: ${message(err)}`, missingPartition: false }
    }

    const channel = client
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: PARTNER_PAGE_NOTICE_EVENT }, (m) => onPayload(m.payload))
    let left = false
    let dropped = false
    const leave = async () => {
      left = true
      await client.removeChannel(channel)
    }

    return new Promise<JoinAnswer>((resolve) => {
      let settled = false
      const cancel = schedule(() => settle({ ok: false, reason: `Realtime gave no answer to the join within ${timeoutMs / 1000} seconds`, missingPartition: false }), timeoutMs)
      function settle(answer: JoinAnswer) {
        if (settled) return
        settled = true
        cancel()
        if (!answer.ok) void leave().catch(() => undefined)
        resolve(answer)
      }
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          settle({ ok: true, leave })
          return
        }
        const reason = err?.message ?? status
        if (!settled) {
          // Realtime refuses a private join with MissingPartition until the
          // day's partition exists (ADR 0012, measured on production 2026-10-15).
          settle({ ok: false, reason, missingPartition: /MissingPartition/.test(reason) })
          return
        }
        // An admitted channel stopped being subscribed: said once, and never
        // for the CLOSED our own leave causes.
        if (left || dropped) return
        dropped = true
        onDrop(reason)
      })
    })
  }

  return { join, dispose: () => data.subscription.unsubscribe() }
}
