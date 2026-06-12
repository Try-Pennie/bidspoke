// Circuit breaker state (closed/open/half-open) — PRD Section 2.5.2
// DO identifier: circuit-{partner_slug} or circuit-{service_name}

export type CircuitState = 'closed' | 'open' | 'half_open'

interface CircuitBreakerStorage {
  state: CircuitState
  errorTimestamps: number[]   // sliding window — unix ms
  openedAt: number | null     // when circuit opened
  cooldownSeconds: number
  windowSeconds: number
  errorThreshold: number
  probingInFlight: boolean    // half-open: only one probe at a time
  probeStartedAt: number | null // half-open: when the in-flight probe was claimed (lease)
  consecutiveCooldowns: number // tracks repeated failures for backoff
}

export interface CheckResult {
  allowed: boolean
  state: CircuitState
  reason?: 'circuit_open' | 'probe_in_flight'
  opens_at?: number
}

// A half-open probe is leased for this long. If the caller never reports back
// (a crash, a lost DO call, or a skip path that forgot to release), the lease
// expires so the next eligible lead can claim a fresh probe — otherwise the
// partner is excluded from all bidding until a manual reset. 60s comfortably
// exceeds one bid attempt including retries.
const PROBE_LEASE_MS = 60_000

const DEFAULTS: Omit<CircuitBreakerStorage, 'errorTimestamps' | 'openedAt' | 'probeStartedAt'> = {
  state: 'closed',
  cooldownSeconds: 300,
  windowSeconds: 60,
  errorThreshold: 5,
  probingInFlight: false,
  consecutiveCooldowns: 0,
}

export class CircuitBreakerObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    switch (path) {
      case '/check':  return this.handleCheck()
      case '/record-success': return this.handleRecordSuccess()
      case '/record-error':   return this.handleRecordError(request)
      case '/release-probe':  return this.handleReleaseProbe()
      case '/reset':          return this.handleReset()
      case '/status':         return this.handleStatus()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async load(): Promise<CircuitBreakerStorage> {
    const stored = await this.state.storage.get<CircuitBreakerStorage>('data')
    if (stored) {
      // Normalize entries persisted before probeStartedAt existed — a stuck
      // probe with no recorded start is then treated as expired (see check).
      if (stored.probeStartedAt === undefined) stored.probeStartedAt = null
      return stored
    }
    return { ...DEFAULTS, errorTimestamps: [], openedAt: null, probeStartedAt: null }
  }

  private async save(data: CircuitBreakerStorage): Promise<void> {
    await this.state.storage.put('data', data)
  }

  private async handleCheck(): Promise<Response> {
    const data = await this.load()
    const now = Date.now()

    // Prune old errors from sliding window
    data.errorTimestamps = data.errorTimestamps.filter(
      (t) => now - t < data.windowSeconds * 1000
    )

    if (data.state === 'closed') {
      await this.save(data)
      return json<CheckResult>({ allowed: true, state: 'closed' })
    }

    if (data.state === 'open') {
      const cooldownMs = data.cooldownSeconds * 1000 * Math.pow(1.5, data.consecutiveCooldowns)
      const opensAt = (data.openedAt ?? now) + cooldownMs

      if (now >= opensAt) {
        // Cooldown elapsed — transition to half-open and claim the probe
        data.state = 'half_open'
        data.probingInFlight = true
        data.probeStartedAt = now
        await this.save(data)
        return json<CheckResult>({ allowed: true, state: 'half_open' })
      }

      await this.save(data)
      return json<CheckResult>({
        allowed: false,
        state: 'open',
        reason: 'circuit_open',
        opens_at: opensAt,
      })
    }

    // half_open: block only while a FRESH probe is in flight. A probe whose
    // lease has expired (caller never reported back) is reclaimed so the
    // partner isn't excluded indefinitely. A null start (legacy entry, or a
    // breaker already stuck at deploy time) counts as expired.
    const probeStale =
      data.probeStartedAt == null || now - data.probeStartedAt >= PROBE_LEASE_MS
    if (data.probingInFlight && !probeStale) {
      await this.save(data)
      return json<CheckResult>({ allowed: false, state: 'half_open', reason: 'probe_in_flight' })
    }

    data.probingInFlight = true
    data.probeStartedAt = now
    await this.save(data)
    return json<CheckResult>({ allowed: true, state: 'half_open' })
  }

  private async handleRecordSuccess(): Promise<Response> {
    const data = await this.load()

    if (data.state === 'half_open') {
      // Probe succeeded — close the circuit
      data.state = 'closed'
      data.errorTimestamps = []
      data.openedAt = null
      data.probingInFlight = false
      data.probeStartedAt = null
      data.consecutiveCooldowns = 0
      await this.save(data)
      // Slack recovery alert is sent by the caller (Phase 2 Partner Bid node) when it sees state transition
      console.log(`[circuit-breaker] Circuit closed (probe succeeded)`)
    }

    return json({ ok: true, state: data.state })
  }

  private async handleRecordError(request: Request): Promise<Response> {
    const body = await request.json<{
      error_threshold?: number
      window_seconds?: number
      cooldown_seconds?: number
    }>()

    const data = await this.load()
    const now = Date.now()

    // Apply config from partner/service settings if provided
    if (body.error_threshold !== undefined) data.errorThreshold = body.error_threshold
    if (body.window_seconds !== undefined) data.windowSeconds = body.window_seconds
    if (body.cooldown_seconds !== undefined) data.cooldownSeconds = body.cooldown_seconds

    if (data.state === 'half_open') {
      // Probe failed — reopen with backoff
      data.state = 'open'
      data.openedAt = now
      data.probingInFlight = false
      data.probeStartedAt = null
      data.consecutiveCooldowns++
      await this.save(data)
      // Slack alert sent by caller when tripped === true (Phase 2 Partner Bid node)
      console.log(`[circuit-breaker] Circuit reopened after failed probe (cooldown #${data.consecutiveCooldowns})`)
      return json({ ok: true, state: 'open', tripped: true })
    }

    // Record error in sliding window
    data.errorTimestamps.push(now)
    data.errorTimestamps = data.errorTimestamps.filter(
      (t) => now - t < data.windowSeconds * 1000
    )

    if (data.state === 'closed' && data.errorTimestamps.length >= data.errorThreshold) {
      data.state = 'open'
      data.openedAt = now
      data.consecutiveCooldowns = 0
      await this.save(data)
      // Slack alert sent by caller when tripped === true (Phase 2 Partner Bid node)
      console.log(`[circuit-breaker] Circuit opened (${data.errorTimestamps.length} errors in window)`)
      return json({ ok: true, state: 'open', tripped: true })
    }

    await this.save(data)
    return json({ ok: true, state: data.state, tripped: false })
  }

  // Release a half-open probe WITHOUT recording success or error. Used by the
  // caller when a lead claimed the probe but never actually called the partner
  // (skipped by daily cap or dedup), so the next eligible lead can probe.
  private async handleReleaseProbe(): Promise<Response> {
    const data = await this.load()
    if (data.state === 'half_open' && data.probingInFlight) {
      data.probingInFlight = false
      data.probeStartedAt = null
      await this.save(data)
    }
    return json({ ok: true, state: data.state })
  }

  private async handleReset(): Promise<Response> {
    const data = await this.load()
    data.state = 'closed'
    data.errorTimestamps = []
    data.openedAt = null
    data.probingInFlight = false
    data.probeStartedAt = null
    data.consecutiveCooldowns = 0
    await this.save(data)
    console.log(`[circuit-breaker] Circuit manually reset`)
    return json({ ok: true, state: 'closed' })
  }

  private async handleStatus(): Promise<Response> {
    const data = await this.load()
    const now = Date.now()
    data.errorTimestamps = data.errorTimestamps.filter(
      (t) => now - t < data.windowSeconds * 1000
    )
    return json({
      state: data.state,
      error_count_in_window: data.errorTimestamps.length,
      error_threshold: data.errorThreshold,
      window_seconds: data.windowSeconds,
      cooldown_seconds: data.cooldownSeconds,
      opened_at: data.openedAt,
      consecutive_cooldowns: data.consecutiveCooldowns,
    })
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
