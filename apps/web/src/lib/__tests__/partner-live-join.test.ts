/**
 * The browser's join of the partners page channel (#2135): with the signed in
 * person's JWT, on a private channel, re-running setAuth whenever the session
 * refreshes, and reporting a MissingPartition refusal as such (ADR 0012). The
 * Supabase client is a fake that records what it was asked.
 */
import { describe, expect, it, vi } from 'vitest'
import { browserJoin, type LiveSupabase } from '../partner-live-join'

type Status = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'

function fakeSupabase(token: string | null = 'jwt-1') {
  let authListener: ((event: string, session: { access_token: string } | null) => void) | null = null
  const setAuth = vi.fn(async (_t: string) => {})
  const removed: string[] = []
  const channels: Array<{ topic: string; opts: unknown; event: string | null; handler: ((m: { payload?: unknown }) => void) | null; status: ((s: Status, e?: Error) => void) | null }> = []
  // Like realtime-js, channel() hands back the channel it still holds for a topic rather than a new one.
  const held = new Map<string, { topic: string; api: unknown }>()
  const client: LiveSupabase = {
    auth: {
      getSession: async () => ({ data: { session: token ? { access_token: token } : null } }),
      onAuthStateChange: (cb) => { authListener = cb; return { data: { subscription: { unsubscribe: () => { authListener = null } } } } },
    },
    realtime: { setAuth },
    getChannels: () => [...held.values()].map((h) => h.api) as ReturnType<LiveSupabase['getChannels']>,
    channel: (topic, opts) => {
      const existing = held.get(topic)
      if (existing) return existing.api as ReturnType<LiveSupabase['channel']>
      const ch = { topic, opts, event: null as string | null, handler: null as ((m: { payload?: unknown }) => void) | null, status: null as ((s: Status, e?: Error) => void) | null }
      channels.push(ch)
      const api = {
        topic: `realtime:${topic}`,
        on: (_type: 'broadcast', filter: { event: string }, handler: (m: { payload?: unknown }) => void) => { ch.event = filter.event; ch.handler = handler; return api },
        subscribe: (cb: (s: Status, e?: Error) => void) => { ch.status = cb; return api },
      }
      held.set(topic, { topic: `realtime:${topic}`, api })
      return api
    },
    removeChannel: async (c) => {
      for (const [topic, h] of held) if (h.api === c) held.delete(topic)
      removed.push('channel')
      return 'ok'
    },
  }
  return { client, setAuth, channels, removed, fireAuth: (event: string, session: { access_token: string } | null) => authListener?.(event, session), hasListener: () => authListener !== null }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('browserJoin (#2135)', () => {
  it('sets the person\'s JWT before joining a private channel on the notice event, and is admitted on SUBSCRIBED', async () => {
    const s = fakeSupabase()
    const live = browserJoin(s.client)
    const payloads: unknown[] = []
    const pending = live.join('partners:org-1', (p) => payloads.push(p), () => {})
    await flush()
    expect(s.setAuth).toHaveBeenCalledWith('jwt-1')
    expect(s.channels[0]).toMatchObject({ topic: 'partners:org-1', opts: { config: { private: true } }, event: 'partner_changed' })
    s.channels[0].status!('SUBSCRIBED')
    const answer = await pending
    expect(answer.ok).toBe(true)
    s.channels[0].handler!({ payload: { kind: 'partner' } })
    expect(payloads).toEqual([{ kind: 'partner' }])
  })

  it('a refusal naming MissingPartition says so, and the channel is removed', async () => {
    const s = fakeSupabase()
    const live = browserJoin(s.client)
    const pending = live.join('partners:org-1', () => {}, () => {})
    await flush()
    s.channels[0].status!('CHANNEL_ERROR', new Error('MissingPartition: Realtime was unable to find the expected messages partition'))
    expect(await pending).toEqual({ ok: false, reason: 'MissingPartition: Realtime was unable to find the expected messages partition', missingPartition: true })
    expect(s.removed).toHaveLength(1)
  })

  it('reports an admitted channel that later errors as one drop, and the CLOSED its own leave causes as nothing', async () => {
    const s = fakeSupabase()
    const live = browserJoin(s.client)
    const drops: string[] = []
    const pending = live.join('partners:org-1', () => {}, (r) => drops.push(r))
    await flush()
    s.channels[0].status!('SUBSCRIBED')
    const answer = await pending
    s.channels[0].status!('CHANNEL_ERROR', new Error('socket closed'))
    s.channels[0].status!('TIMED_OUT')
    expect(drops).toEqual(['socket closed'])

    const second = live.join('partners:org-1', () => {}, (r) => drops.push(`second ${r}`))
    await flush()
    s.channels[1].status!('SUBSCRIBED')
    const admitted = await second
    if (!admitted.ok || !answer.ok) throw new Error('expected both admitted')
    await admitted.leave()
    s.channels[1].status!('CLOSED')
    expect(drops).toEqual(['socket closed'])
  })

  it('each join has its own channel, though the client hands back the one it holds for a topic, so an older join\'s leave cannot remove a newer one', async () => {
    // A form mounted twice (React's development double mount, or a quick partner
    // switch) starts a second join before the first is left (seen locally: the
    // second join's channel was the first's, and the first's leave removed it).
    const s = fakeSupabase()
    const live = browserJoin(s.client)
    const first = live.join('partners:org-1', () => {}, () => {})
    await flush()
    const second = live.join('partners:org-1', () => {}, () => {})
    await flush()
    expect(s.channels).toHaveLength(2)
    s.channels[1].status!('SUBSCRIBED')
    const admitted = await second
    expect(admitted.ok).toBe(true)
    s.channels[0].status!('CLOSED')
    expect((await first).ok).toBe(false)
    expect(s.client.getChannels()).toHaveLength(1)
  })

  it('a signed out page is refused without joining', async () => {
    const s = fakeSupabase(null)
    const answer = await browserJoin(s.client).join('partners:org-1', () => {}, () => {})
    expect(answer).toEqual({ ok: false, reason: 'You are signed out.', missingPartition: false })
    expect(s.channels).toHaveLength(0)
  })

  it('re-runs setAuth with each refreshed token, and stops listening on dispose', async () => {
    const s = fakeSupabase()
    const live = browserJoin(s.client)
    s.fireAuth('TOKEN_REFRESHED', { access_token: 'jwt-2' })
    s.fireAuth('SIGNED_IN', { access_token: 'jwt-3' })
    s.fireAuth('SIGNED_OUT', null)
    expect(s.setAuth.mock.calls.map((c) => c[0])).toEqual(['jwt-2', 'jwt-3'])
    live.dispose()
    expect(s.hasListener()).toBe(false)
  })

  it('listens again on the next join after a dispose, as a provider mounted twice needs', async () => {
    const s = fakeSupabase()
    const live = browserJoin(s.client)
    live.dispose()
    void live.join('partners:org-1', () => {}, () => {})
    await flush()
    expect(s.hasListener()).toBe(true)
    s.fireAuth('TOKEN_REFRESHED', { access_token: 'jwt-9' })
    expect(s.setAuth).toHaveBeenLastCalledWith('jwt-9')
  })

  it('gives up on a join that gets no answer within the timeout, on the injected clock', async () => {
    const s = fakeSupabase()
    let fire: (() => void) | null = null
    const live = browserJoin(s.client, { timeoutMs: 10_000, setTimeout: (fn) => { fire = fn; return () => { fire = null } } })
    const pending = live.join('partners:org-1', () => {}, () => {})
    await flush()
    fire!()
    expect(await pending).toEqual({ ok: false, reason: 'Realtime gave no answer to the join within 10 seconds', missingPartition: false })
  })
})
