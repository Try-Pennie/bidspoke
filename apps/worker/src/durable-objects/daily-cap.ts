/**
 * Daily Cap Durable Object — PRD Section 2.5.1
 *
 * DO identifier: `cap-{partner_slug}-{YYYY-MM-DD}` (UTC date)
 * One DO per partner per day. At midnight UTC a new DO takes over with a fresh counter.
 *
 * All writes are durable (ctx.storage). Requests are processed sequentially — no
 * lock contention at high concurrency.
 */

interface CapStorage {
  count: number
}

export interface CapCheckResult {
  allowed: boolean
  count: number
  cap: number | null
}

export class DailyCapObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    switch (path) {
      case '/check-and-increment': return this.handleCheckAndIncrement(request)
      case '/decrement':           return this.handleDecrement()
      case '/get-count':           return this.handleGetCount()
      case '/reset':               return this.handleReset()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async load(): Promise<CapStorage> {
    const stored = await this.state.storage.get<CapStorage>('data')
    return stored ?? { count: 0 }
  }

  private async save(data: CapStorage): Promise<void> {
    await this.state.storage.put('data', data)
  }

  /**
   * Atomically checks if count < cap and increments if allowed.
   * Body: { cap: number | null }
   * Returns: { allowed: boolean, count: number, cap: number | null }
   */
  private async handleCheckAndIncrement(request: Request): Promise<Response> {
    const body = await request.json<{ cap: number | null }>()
    const cap = body.cap
    const data = await this.load()

    // null cap = unlimited
    if (cap === null || data.count < cap) {
      data.count++
      await this.save(data)
      return json<CapCheckResult>({ allowed: true, count: data.count, cap })
    }

    return json<CapCheckResult>({ allowed: false, count: data.count, cap })
  }

  /**
   * Refund a previously-reserved slot. Used when a lead reserved a slot via
   * check-and-increment but was never really submitted (duplicate / error), so
   * the cap reflects actual partner submissions (#68). Floors at 0 so a stray
   * extra refund can't drive the count negative and silently widen the cap.
   */
  private async handleDecrement(): Promise<Response> {
    const data = await this.load()
    data.count = Math.max(0, data.count - 1)
    await this.save(data)
    return json({ count: data.count })
  }

  private async handleGetCount(): Promise<Response> {
    const data = await this.load()
    return json({ count: data.count })
  }

  private async handleReset(): Promise<Response> {
    await this.save({ count: 0 })
    return json({ ok: true, count: 0 })
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
