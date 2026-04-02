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
  consecutiveCooldowns: number // tracks repeated failures for backoff
}

export interface CheckResult {
  allowed: boolean
  state: CircuitState
  reason?: 'circuit_open' | 'probe_in_flight'
  opens_at?: number
}

const DEFAULTS: Omit<CircuitBreakerStorage, 'errorTimestamps' | 'openedAt'> = {
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
      case '/reset':          return this.handleReset()
      case '/status':         return this.handleStatus()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async load(): Promise<CircuitBreakerStorage> {
    const stored = await this.state.storage.get<CircuitBreakerStorage>('data')
    return stored ?? { ...DEFAULTS, errorTimestamps: [], openedAt: null }
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
        // Cooldown elapsed — transition to half-open
        data.state = 'half_open'
        data.probingInFlight = true
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

    // half_open
    if (data.probingInFlight) {
      await this.save(data)
      return json<CheckResult>({ allowed: false, state: 'half_open', reason: 'probe_in_flight' })
    }

    data.probingInFlight = true
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
      data.consecutiveCooldowns = 0
      await this.save(data)
      // TODO Phase 1.7: send Slack recovery alert
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
      data.consecutiveCooldowns++
      await this.save(data)
      // TODO Phase 1.7: send Slack alert
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
      // TODO Phase 1.7: send Slack alert
      console.log(`[circuit-breaker] Circuit opened (${data.errorTimestamps.length} errors in window)`)
      return json({ ok: true, state: 'open', tripped: true })
    }

    await this.save(data)
    return json({ ok: true, state: data.state, tripped: false })
  }

  private async handleReset(): Promise<Response> {
    const data = await this.load()
    data.state = 'closed'
    data.errorTimestamps = []
    data.openedAt = null
    data.probingInFlight = false
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
