/**
 * Alert Claim Durable Object (#1298)
 *
 * DO identifier: the alert's key (`volume-cliff:{workflow_id}`,
 * `db-unreachable:{org_id}`). One instance per alert, so every cron tick that
 * wants to post it asks the same object, whichever colo the tick ran in.
 *
 * This exists because the KV cooldown cannot do the job on its own. The
 * cooldown is a KV get followed by a KV put after the Slack post succeeds, and
 * two ticks that reach the get together both post: on 2026-09-10 the checks that
 * had been hanging on a dead database were all released at the same instant when
 * it came back, and every cliff alert arrived twice. Writing the key earlier
 * only narrows the window, and KV is eventually consistent besides. A DO claim
 * is strongly consistent, so exactly one caller is told it may post.
 *
 * Expiry: a DO has no TTL, so a claim sets an alarm at now + ttl and clears
 * itself. The KV cooldown key stays as the marker the recovery logic reads; the
 * claim only decides who posts.
 *
 * The same object also answers "does this delivery of a cron tick run?" (#1899)
 * under `/tick-claim`, `/tick-renew`, `/tick-done` and `/tick-release`; see TickClaimResult below.
 */

interface ClaimStorage {
  claimed_until: number
}

export interface ClaimResult {
  claimed: boolean
}

/**
 * The cron tick claim (#1899), kept in this object under its own storage key
 * and its own object names (`cron-tick:...`), so it never meets an alert claim.
 *
 * Measured from Workers Logs:
 *   - Since 2026-10-08 13:38:37 UTC every tick is delivered twice, about 36 s
 *     apart (:01 and :37 past the minute), with DIFFERENT scheduled times.
 *   - On 2026-10-05 21:45 to 23:15 UTC each tick was delivered twice with the
 *     SAME scheduled time, the second starting 0.4 to 25.7 s after the first
 *     (the hourly pair at 22:00 started 0.5 s apart; a `* * * * *` pair at
 *     22:01 started 25.7 s apart).
 *   - A genuine platform retry carries the SAME scheduled time as the run it
 *     replaces, and comes only after that run was killed: 2026-10-08 the 14:00:01
 *     hourly run was canceled after 98.6 s and re-run at 14:01:41; the kills
 *     measured since 2026-08 came 43 to 156 s into a run, the retry 1.4 s to
 *     3 min after the kill.
 *   - 2026-10-14 05:23 UTC (#2064): Cloudflare cancelled both running scheduled
 *     runs 1.7 to 1.9 s in and re-delivered each 0.3 to 0.4 s AFTER it ended,
 *     with the same scheduled time. Every field Cloudflare sends is identical
 *     between the two; only requestId and traceId differ, and neither says retry.
 *
 * So the only signal that separates a retry from a doubled delivery is whether
 * the holder is still alive. It renews a lease every TICK_LEASE_RENEW_MS while
 * its jobs run (cron-once.ts); a run that was killed stops renewing.
 *
 * The rule, for one (cron expression, scheduled minute):
 *   - nobody holds it: the caller runs, and holds it as `running`.
 *   - it is `done`: every later delivery is a duplicate. Cloudflare does not
 *     retry a run that finished.
 *   - it is `running` and the caller carries a DIFFERENT scheduled time: a
 *     duplicate. A retry always carries its own run's scheduled time.
 *   - it is `running`, the caller carries the SAME scheduled time, and the
 *     holder's lease was renewed less than TICK_LEASE_STALE_MS ago: a duplicate
 *     for now. The answer says how old the lease is, and cron-once waits until a
 *     dead holder's lease would have gone stale and asks again, because a lease
 *     is still fresh just after a kill (the 2026-10-14 retry came 0.4 s after).
 *   - otherwise the holder has stopped renewing: a retry, and it takes over.
 *
 * The 35 s age floor this replaces dropped the 2026-10-14 retry: a cancel at
 * 1.7 s fell inside it. A holder that cannot reach this object to renew looks
 * dead, and its tick then runs twice, which is the direction to err in.
 */
export const TICK_LEASE_STALE_MS = 3 * 3_000

/** How often a running holder renews its lease: a third of TICK_LEASE_STALE_MS, so a dead run is three missed renewals. */
export const TICK_LEASE_RENEW_MS = TICK_LEASE_STALE_MS / 3

/**
 * How long a tick's record is kept before its alarm deletes it: well past the
 * 15 minute cron wall limit plus the 3 minute retry gap, so a late delivery
 * still meets it, and short enough that one object per tick does not pile up.
 */
export const TICK_CLAIM_KEEP_MS = 60 * 60 * 1000

interface TickStorage {
  holder: string
  scheduled_time: number
  started_at: number
  /** When the holder last renewed its lease; absent on a record from before #2064, which reads started_at. */
  renewed_at?: number
  status: 'running' | 'done'
  duplicates: number
}

export type TickClaimResult =
  | { run: true; reason: 'first' }
  | { run: true; reason: 'retry'; holder: string; holder_age_ms: number }
  | {
      run: false
      reason: 'duplicate'
      holder: string
      holder_scheduled_time: number
      holder_status: 'running' | 'done'
      holder_age_ms: number
      /** Since the holder last renewed; cron-once waits on this before a same-time delivery gives up. */
      holder_lease_age_ms: number
      duplicates: number
    }

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export class AlertClaimObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    switch (path) {
      case '/claim':   return this.handleClaim(request)
      case '/release': return this.handleRelease()
      case '/tick-claim': return this.handleTickClaim(request)
      case '/tick-done': return this.handleTickDone(request)
      case '/tick-release': return this.handleTickRelease(request)
      case '/tick-renew': return this.handleTickRenew(request)
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  /**
   * Body: { now: number, ttl_seconds: number }
   * First caller inside a TTL window gets claimed: true, everyone else false.
   */
  private async handleClaim(request: Request): Promise<Response> {
    const body = await request.json<{ now: number; ttl_seconds: number }>()
    const held = await this.state.storage.get<ClaimStorage>('data')
    if (held && held.claimed_until > body.now) {
      return json<ClaimResult>({ claimed: false })
    }
    const until = body.now + body.ttl_seconds * 1000
    await this.state.storage.put<ClaimStorage>('data', { claimed_until: until })
    await this.state.storage.setAlarm(until)
    return json<ClaimResult>({ claimed: true })
  }

  /** The holder could not post after all; let the next tick try. */
  private async handleRelease(): Promise<Response> {
    await this.state.storage.deleteAll()
    return json({ ok: true })
  }

  /**
   * Body: { now, scheduled_time, holder }. Answers whether this delivery of a
   * cron tick runs; the rule is in the comment on TICK_LEASE_STALE_MS.
   */
  private async handleTickClaim(request: Request): Promise<Response> {
    const body = await request.json<{ now?: unknown; scheduled_time?: unknown; holder?: unknown; after_wait?: unknown }>()
    if (!isFiniteNumber(body.now) || !isFiniteNumber(body.scheduled_time) || typeof body.holder !== 'string' || body.holder === '') {
      return json({ error: 'now, scheduled_time and holder are required' }, 400)
    }
    const { now, scheduled_time: scheduledTime, holder } = body
    const held = await this.state.storage.get<TickStorage>('tick')
    if (!held) {
      await this.state.storage.put<TickStorage>('tick', { holder, scheduled_time: scheduledTime, started_at: now, renewed_at: now, status: 'running', duplicates: 0 })
      await this.state.storage.setAlarm(now + TICK_CLAIM_KEEP_MS)
      return json<TickClaimResult>({ run: true, reason: 'first' })
    }
    const age = now - held.started_at
    const leaseAge = now - (held.renewed_at ?? held.started_at)
    const isRetry = held.status === 'running' && held.scheduled_time === scheduledTime && leaseAge >= TICK_LEASE_STALE_MS
    // The second ask of a same-time wait (#2064) is the same delivery asking again:
    // its first ask already counted a duplicate, which a takeover takes back.
    const afterWait = body.after_wait === true
    if (isRetry) {
      const duplicates = afterWait ? Math.max(0, held.duplicates - 1) : held.duplicates
      await this.state.storage.put<TickStorage>('tick', { ...held, holder, started_at: now, renewed_at: now, duplicates })
      return json<TickClaimResult>({ run: true, reason: 'retry', holder: held.holder, holder_age_ms: age })
    }
    const duplicates = afterWait ? held.duplicates : held.duplicates + 1
    await this.state.storage.put<TickStorage>('tick', { ...held, duplicates })
    return json<TickClaimResult>({
      run: false,
      reason: 'duplicate',
      holder: held.holder,
      holder_scheduled_time: held.scheduled_time,
      holder_status: held.status,
      holder_age_ms: age,
      holder_lease_age_ms: leaseAge,
      duplicates,
    })
  }

  /**
   * Body: { holder }. Marks the tick done, but only for the run that holds it:
   * a run that was taken over and turns out to have been alive does not close
   * the claim its retry now holds.
   */
  private async handleTickDone(request: Request): Promise<Response> {
    const body = await request.json<{ holder?: unknown }>()
    if (typeof body.holder !== 'string' || body.holder === '') return json({ error: 'holder is required' }, 400)
    const held = await this.state.storage.get<TickStorage>('tick')
    if (!held || held.holder !== body.holder) return json({ marked: false })
    await this.state.storage.put<TickStorage>('tick', { ...held, status: 'done' })
    return json({ marked: true })
  }

  /**
   * Body: { holder }. The holder's jobs threw before they could run, so the
   * tick is freed for the platform's retry or any later delivery. Only the
   * holder may free it, for the same reason as tick-done.
   */
  private async handleTickRelease(request: Request): Promise<Response> {
    const body = await request.json<{ holder?: unknown }>()
    if (typeof body.holder !== 'string' || body.holder === '') return json({ error: 'holder is required' }, 400)
    const held = await this.state.storage.get<TickStorage>('tick')
    if (!held || held.holder !== body.holder) return json({ released: false })
    await this.state.storage.delete('tick')
    return json({ released: true })
  }

  /**
   * Body: { now, holder }. Renews the running holder's lease (#2064), so a
   * same-time delivery can tell a live run from one that was killed. Only the
   * holder may renew, and only while it is running.
   */
  private async handleTickRenew(request: Request): Promise<Response> {
    const body = await request.json<{ now?: unknown; holder?: unknown }>()
    if (!isFiniteNumber(body.now) || typeof body.holder !== 'string' || body.holder === '') {
      return json({ error: 'now and holder are required' }, 400)
    }
    const held = await this.state.storage.get<TickStorage>('tick')
    if (!held || held.holder !== body.holder || held.status !== 'running') return json({ renewed: false })
    await this.state.storage.put<TickStorage>('tick', { ...held, renewed_at: body.now })
    return json({ renewed: true })
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
