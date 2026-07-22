// Inflight-concurrency limiter (bulkhead) for a shared non-scaling dependency —
// chiefly Salesforce, while the engine runs on auto-scaling Workers. ADR 0005 / #312.
//
// NOTE on Salesforce's real limit: SF caps concurrent requests at 25, but ONLY
// counts requests running 20 seconds or longer ("there isn't a limit on the
// number of concurrent requests shorter than 20 seconds"). Our calls are
// normally sub-second, so SF imposes no concurrency ceiling on healthy traffic.
// Our limit (default 20) is a deliberate self-imposed cap. Its real value shows
// during a Salesforce slowdown: when calls balloon past 20s they start counting
// against the true 25-long-running limit, so the cap keeps us from flooding a
// struggling SF and tripping that governor. Don't raise it so high that a
// slowdown lets a flood of calls cross the 20s line.
// Ref: developer.salesforce.com Platform API limits cheatsheet.
//
// A single DO instance (e.g. id "salesforce") holds the inflight budget. Callers
// `/acquire` a lease before the dependency call and `/release` it after. Leases
// auto-expire after LEASE_MS so a caller that crashes (or never reports back)
// can't hold a slot forever — the same lease trick the circuit breaker uses for
// half-open probes. The limit is passed per request so it stays configurable via
// env without redeploying the DO.

export interface AcquireResult {
  allowed: boolean
  inflight: number
  limit: number
  token?: string
}

interface Lease {
  token: string
  at: number // unix ms when the lease was granted
}

interface BulkheadStorage {
  leases: Lease[]
}

// A lease is reclaimed if held longer than this. Must comfortably exceed one
// dependency call including its step timeout + retries (SF step timeout is 15s).
const LEASE_MS = 30_000
const DEFAULT_LIMIT = 20

export class BulkheadObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    switch (path) {
      case '/acquire': return this.handleAcquire(request)
      case '/release': return this.handleRelease(request)
      case '/status':  return this.handleStatus()
      default:         return new Response('Not found', { status: 404 })
    }
  }

  private async load(): Promise<BulkheadStorage> {
    return (await this.state.storage.get<BulkheadStorage>('data')) ?? { leases: [] }
  }

  private async save(data: BulkheadStorage): Promise<void> {
    await this.state.storage.put('data', data)
  }

  private prune(leases: Lease[], now: number): Lease[] {
    return leases.filter((l) => now - l.at < LEASE_MS)
  }

  private async handleAcquire(request: Request): Promise<Response> {
    const body = await request.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
    const limit = body.limit ?? DEFAULT_LIMIT
    const now = Date.now()
    const data = await this.load()
    data.leases = this.prune(data.leases, now)

    if (data.leases.length >= limit) {
      await this.save(data)
      return json<AcquireResult>({ allowed: false, inflight: data.leases.length, limit })
    }

    const token = crypto.randomUUID()
    data.leases.push({ token, at: now })
    await this.save(data)
    return json<AcquireResult>({ allowed: true, token, inflight: data.leases.length, limit })
  }

  private async handleRelease(request: Request): Promise<Response> {
    const body = await request.json<{ token?: string }>().catch(() => ({} as { token?: string }))
    const data = await this.load()
    const before = data.leases.length
    data.leases = data.leases.filter((l) => l.token !== body.token)
    await this.save(data)
    return json({ ok: true, released: before !== data.leases.length, inflight: data.leases.length })
  }

  private async handleStatus(): Promise<Response> {
    const now = Date.now()
    const data = await this.load()
    data.leases = this.prune(data.leases, now)
    return json({ inflight: data.leases.length, limit: DEFAULT_LIMIT })
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
