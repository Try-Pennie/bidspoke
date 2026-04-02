// Daily cap enforcement per partner — PRD Section 2.5.1
// Key: cap-{partner_slug}-{YYYY-MM-DD}
export class DailyCapObject implements DurableObject {
  state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(_request: Request): Promise<Response> {
    // TODO: Phase 2.1
    return new Response('not implemented', { status: 501 })
  }
}
