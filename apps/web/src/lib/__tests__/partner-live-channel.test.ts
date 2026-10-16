/**
 * The partners page live channel's connection (#2135, PR4 of #2114).
 *
 * The page joins the private topic partners:<org> and hears another person's
 * save as a notice. Its header shows three states a person can tell apart: Live,
 * paused while it reconnects (with the seconds), and failed (with Retry). A day
 * can start with no realtime.messages partition (ADR 0012), so a join refused
 * as MissingPartition is made again soon and each refusal is counted (L77). The
 * clock is injected, so no test waits on a real timer (L524, L290).
 */
import { describe, expect, it } from 'vitest'
import {
  FAIL_AFTER_MS, MISSING_PARTITION_RETRY_MS, PartnerLiveChannel, REJOIN_DELAYS_MS,
  type JoinAnswer, type JoinFn, type LiveStatus,
} from '../partner-live-channel'

const ORG = '9d9d0d3a-1959-41d5-95ca-c1399fa54590'
const PARTNER = '2b0c6c39-1d1e-4a3f-9d0f-3c0b5a6e7f81'

/** A clock whose timers run only when the test advances it. */
function fakeClock(start = 1_000_000) {
  let now = start
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++
      timers.push({ at: now + ms, fn, id })
      return () => { timers = timers.filter((t) => t.id !== id) }
    },
    /** Move the clock forward, running every timer that falls due, in order. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t.id !== due.id)
        now = due.at
        due.fn()
        await flush()
      }
      now = end
    },
    pending: () => timers.length,
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

interface JoinCall { topic: string; payload: (p: unknown) => void; drop: (r: string) => void; resolve: (a: JoinAnswer) => void }

interface FakeJoin {
  join: JoinFn
  joins: JoinCall[]
  calls: string[]
  /** Answer the oldest join not yet answered. */
  answer: (a: JoinAnswer) => void
  /** Deliver a broadcast payload to the most recent join. */
  send: (payload: unknown) => void
  /** The most recent admitted join drops. */
  drop: (reason: string) => void
  left: number
}

/** A join the test answers by hand, one answer per call, each join keeping its own callbacks. */
function fakeJoin(): FakeJoin {
  let answered = 0
  const f: FakeJoin = {
    joins: [],
    get calls() { return f.joins.map((j) => j.topic) },
    left: 0,
    join: (topic, payload, drop) => new Promise((resolve) => { f.joins.push({ topic, payload, drop, resolve }) }),
    answer: (a) => f.joins[answered++].resolve(a),
    send: (p) => f.joins[f.joins.length - 1].payload(p),
    drop: (r) => f.joins[f.joins.length - 1].drop(r),
  }
  return f
}

const admitted = (f: FakeJoin): JoinAnswer => ({ ok: true, leave: async () => { f.left++ } })
const refused = (reason: string, missingPartition = false): JoinAnswer => ({ ok: false, reason, missingPartition })

function make(f = fakeJoin(), clock = fakeClock()) {
  const statuses: LiveStatus[] = []
  const notices: unknown[] = []
  const lives: boolean[] = []
  const channel = new PartnerLiveChannel({
    join: f.join, clock, organizationId: ORG,
    onStatus: (s) => statuses.push(s),
    onNotice: (n) => notices.push(n),
    onLive: (reconnected) => lives.push(reconnected),
  })
  return { channel, f, clock, statuses, notices, lives, last: () => statuses[statuses.length - 1] }
}

const notice = { partner_id: PARTNER, partner_version: 8, profile_version: 3, save_id: null, client_id: null, kind: 'partner', changed_columns: ['daily_cap'], direct: false }

describe('PartnerLiveChannel (#2135)', () => {
  it('joins partners:<org>, says connecting with the time it started, then Live, and hands on each notice it can read', async () => {
    const t = make()
    t.channel.start()
    expect(t.f.calls).toEqual([`partners:${ORG}`])
    expect(t.last()).toEqual({ kind: 'connecting', since: 1_000_000 })
    t.f.answer(admitted(t.f))
    await flush()
    expect(t.last()).toEqual({ kind: 'live', since: 1_000_000 })
    expect(t.lives).toEqual([false])
    t.f.send(notice)
    t.f.send({ partner_id: 'not a uuid', kind: 'partner' })
    expect(t.notices).toEqual([expect.objectContaining({ partnerId: PARTNER, partnerVersion: 8, kind: 'partner' })])
    // A payload it cannot read is counted, never guessed at.
    expect(t.channel.unreadableNotices).toBe(1)
  })

  it('retries a join refused as MissingPartition after a short wait, and counts each such refusal', async () => {
    const t = make()
    t.channel.start()
    t.f.answer(refused('MissingPartition: Realtime was unable to find the expected messages partition', true))
    await flush()
    expect(t.channel.missingPartitionRefusals).toBe(1)
    expect(t.last().kind).toBe('connecting')
    await t.clock.advance(MISSING_PARTITION_RETRY_MS - 1)
    expect(t.f.calls).toHaveLength(1)
    await t.clock.advance(1)
    expect(t.f.calls).toHaveLength(2)
    t.f.answer(admitted(t.f))
    await flush()
    expect(t.last().kind).toBe('live')
    expect(t.channel.missingPartitionRefusals).toBe(1)
  })

  it('after an admitted join drops, says paused from the moment it dropped, rejoins, and on rejoining asks for a refetch', async () => {
    const t = make()
    t.channel.start()
    t.f.answer(admitted(t.f))
    await flush()
    await t.clock.advance(5_000)
    t.f.drop('CHANNEL_ERROR')
    expect(t.last()).toEqual({ kind: 'reconnecting', since: 1_005_000, reason: 'CHANNEL_ERROR' })
    // The dropped channel is left, so the client's own rejoin does not race ours.
    await flush()
    expect(t.f.left).toBe(1)
    await t.clock.advance(REJOIN_DELAYS_MS[0])
    expect(t.f.calls).toHaveLength(2)
    t.f.answer(admitted(t.f))
    await flush()
    expect(t.last()).toEqual({ kind: 'live', since: 1_005_000 + REJOIN_DELAYS_MS[0] })
    expect(t.lives).toEqual([false, true])
  })

  it('backs off between refusals, and says failed once it has not been live for FAIL_AFTER_MS, then joins again only on Retry', async () => {
    const t = make()
    t.channel.start()
    let attempts = 0
    while (t.last().kind !== 'failed') {
      t.f.answer(refused('You do not have permissions to read from this Channel topic'))
      attempts++
      await flush()
      if (t.last().kind === 'failed') break
      await t.clock.advance(REJOIN_DELAYS_MS[Math.min(attempts - 1, REJOIN_DELAYS_MS.length - 1)])
    }
    expect(t.last()).toEqual({ kind: 'failed', reason: 'You do not have permissions to read from this Channel topic' })
    expect(t.clock.now() - 1_000_000).toBeGreaterThanOrEqual(FAIL_AFTER_MS)
    const calls = t.f.calls.length
    await t.clock.advance(10 * FAIL_AFTER_MS)
    expect(t.f.calls).toHaveLength(calls)
    t.channel.retry()
    expect(t.f.calls).toHaveLength(calls + 1)
    expect(t.last()).toEqual({ kind: 'connecting', since: t.clock.now() })
    t.f.answer(admitted(t.f))
    await flush()
    expect(t.last().kind).toBe('live')
  })

  it('a failed state names the MissingPartition refusals it counted', async () => {
    const t = make()
    t.channel.start()
    for (;;) {
      t.f.answer(refused('MissingPartition: no partition', true))
      await flush()
      if (t.last().kind === 'failed') break
      await t.clock.advance(MISSING_PARTITION_RETRY_MS)
      if (t.last().kind === 'failed') break
    }
    const last = t.last()
    expect(last.kind === 'failed' && last.reason).toMatch(/^MissingPartition: no partition \(\d+ joins refused for a missing partition\)$/)
  })

  it('suspect() turns a Live channel to paused and rejoins it; it does nothing when not Live', async () => {
    const t = make()
    t.channel.start()
    t.channel.suspect('probe')
    expect(t.last().kind).toBe('connecting')
    t.f.answer(admitted(t.f))
    await flush()
    t.channel.suspect('the versions probe found a change no notice announced')
    expect(t.last()).toEqual({ kind: 'reconnecting', since: t.clock.now(), reason: 'the versions probe found a change no notice announced' })
    await t.clock.advance(REJOIN_DELAYS_MS[0])
    expect(t.f.calls).toHaveLength(2)
  })

  it('stop() leaves the channel, cancels any timer, and ignores an answer that arrives after it', async () => {
    const t = make()
    t.channel.start()
    t.channel.stop()
    t.f.answer(admitted(t.f))
    await flush()
    expect(t.f.left).toBe(1)
    expect(t.statuses.map((s) => s.kind)).toEqual(['connecting'])
    const u = make()
    u.channel.start()
    u.f.answer(refused('nope'))
    await flush()
    // The rejoin and the outage's deadline.
    expect(u.clock.pending()).toBe(2)
    u.channel.stop()
    expect(u.clock.pending()).toBe(0)
  })

  it('a join that never answers still ends in failed at FAIL_AFTER_MS, and its late answer is left, not taken', async () => {
    const t = make()
    t.channel.start()
    await t.clock.advance(FAIL_AFTER_MS - 1)
    expect(t.last().kind).toBe('connecting')
    await t.clock.advance(1)
    expect(t.last()).toEqual({ kind: 'failed', reason: `Realtime gave no answer within ${FAIL_AFTER_MS / 1000} seconds` })
    t.f.answer(admitted(t.f))
    await flush()
    expect(t.last().kind).toBe('failed')
    expect(t.f.left).toBe(1)
  })

  it('start() while a join is held leaves it and cancels any rejoin timer, so two joins never run at once', async () => {
    const t = make()
    t.channel.start()
    t.f.answer(admitted(t.f))
    await flush()
    t.channel.start()
    await flush()
    expect(t.f.left).toBe(1)
    expect(t.f.calls).toHaveLength(2)
    expect(t.clock.pending()).toBe(1) // only the new join's deadline
  })

  it('a notice or drop from a join it has already left is ignored', async () => {
    const t = make()
    t.channel.start()
    t.f.answer(admitted(t.f))
    await flush()
    const first = t.f.joins[0]
    t.f.drop('CLOSED')
    await t.clock.advance(REJOIN_DELAYS_MS[0])
    t.f.answer(admitted(t.f))
    await flush()
    const statuses = t.statuses.length
    first.payload(notice)
    first.drop('late')
    expect(t.notices).toEqual([])
    expect(t.statuses).toHaveLength(statuses)
    expect(t.last().kind).toBe('live')
  })
})
