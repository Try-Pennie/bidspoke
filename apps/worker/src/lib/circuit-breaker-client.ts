// Client for interacting with CircuitBreakerObject Durable Objects
// DO identifier: circuit-{partner_slug} or circuit-{service_name}

import type { CheckResult, CircuitState } from '../durable-objects/circuit-breaker'
import type { Env } from '../index'

export type { CheckResult, CircuitState }

export interface CircuitStatus {
  state: CircuitState
  error_count_in_window: number
  error_threshold: number
  window_seconds: number
  cooldown_seconds: number
  opened_at: number | null
  consecutive_cooldowns: number
}

export interface RecordErrorOptions {
  error_threshold?: number
  window_seconds?: number
  cooldown_seconds?: number
}

export class CircuitBreakerClient {
  private stub: DurableObjectStub

  constructor(env: Env, name: string) {
    const id = env.CIRCUIT_BREAKER.idFromName(`circuit-${name}`)
    this.stub = env.CIRCUIT_BREAKER.get(id)
  }

  async check(): Promise<CheckResult> {
    const res = await this.stub.fetch('http://do/check')
    return res.json<CheckResult>()
  }

  async recordSuccess(): Promise<void> {
    await this.stub.fetch('http://do/record-success', { method: 'POST' })
  }

  async recordError(opts: RecordErrorOptions = {}): Promise<{ ok: boolean; state: CircuitState; tripped: boolean }> {
    const res = await this.stub.fetch('http://do/record-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    })
    return res.json()
  }

  // Release a claimed half-open probe without recording success or error —
  // used when the lead never actually called the partner (cap/dedup skip).
  async releaseProbe(): Promise<void> {
    await this.stub.fetch('http://do/release-probe', { method: 'POST' })
  }

  /** Throws when the object does not confirm the reset, so a caller can say it was not reset (#2140). */
  async reset(): Promise<void> {
    const res = await this.stub.fetch('http://do/reset', { method: 'POST' })
    if (!res.ok) throw new Error(`circuit breaker reset answered ${res.status}`)
  }

  async status(): Promise<CircuitStatus> {
    const res = await this.stub.fetch('http://do/status')
    return res.json<CircuitStatus>()
  }
}
