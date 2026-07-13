/**
 * Latency Mark Durable Object (#488)
 *
 * DO identifier: the Latency Gate's correlation key (`latency:{scope}:{id}`).
 * One DO per bid, so the mark written when we bid and the read taken when the
 * partner confirms are the same instance no matter which colo serves each request.
 *
 * This exists because KV could not do the job. Marks used to live in KV, which is
 * eventually consistent (up to ~60s cross-colo). A missing mark routes 'exceeded'
 * (reject), so a confirmation that came back FAST enough to beat propagation was
 * rejected as a latency failure. That is backwards: the gate is there to reject SLOW
 * confirmations, and it was firing hardest on the quickest ones. Inside the
 * propagation window a not-yet-replicated mark and a never-written mark are the same
 * empty read, so no retry or TTL tweak could tell them apart. A DO read is strongly
 * consistent, so "not found" now genuinely means never marked or expired.
 *
 * Expiry: a DO has no TTL, so the mark sets an alarm at marked_at + ttl and deletes
 * itself. Without that, every bid would leave a row behind forever.
 */

interface MarkStorage {
  marked_at: number
}

export interface MarkCheckResult {
  marked_at: number | null
}

export class LatencyMarkObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname

    switch (path) {
      case '/mark':  return this.handleMark(request)
      case '/check': return this.handleCheck()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  /**
   * Body: { marked_at: number, ttl_seconds: number }
   * Stamps the bid time and schedules its own cleanup.
   */
  private async handleMark(request: Request): Promise<Response> {
    const body = await request.json<{ marked_at: number; ttl_seconds: number }>()
    await this.state.storage.put<MarkStorage>('data', { marked_at: body.marked_at })
    // Self-delete once the mark can no longer be legitimately confirmed against.
    await this.state.storage.setAlarm(body.marked_at + body.ttl_seconds * 1000)
    return json({ ok: true })
  }

  /**
   * Returns the stamped bid time, or null when this bid was never marked (or its
   * mark has expired). Strongly consistent, which is the whole point.
   */
  private async handleCheck(): Promise<Response> {
    const stored = await this.state.storage.get<MarkStorage>('data')
    return json<MarkCheckResult>({ marked_at: stored?.marked_at ?? null })
  }

  /**
   * TTL expiry. Drops the mark so a confirmation arriving after the window reads
   * empty and is rejected, which is the correct outcome for a genuinely late one.
   */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
