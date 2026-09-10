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
 */

interface ClaimStorage {
  claimed_until: number
}

export interface ClaimResult {
  claimed: boolean
}

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

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
