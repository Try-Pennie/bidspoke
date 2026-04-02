// Circuit breaker state (closed/open/half-open) — PRD Section 2.5.2
export class CircuitBreakerObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(_request: Request): Promise<Response> {
    // TODO: Phase 1.4
    return new Response('not implemented', { status: 501 })
  }
}
