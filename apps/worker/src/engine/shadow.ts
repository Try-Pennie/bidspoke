import type { StepExecutionResult } from '../types'

// Stub outputs mirror each outbound node's success shape, tagged `_shadow` so a
// stubbed step is distinguishable from a real one in logs and spot-checks.
//
// Not every node uses a builder here: partner-bid returns its canonical
// `skip(slug, 'shadow')`; code passes the shadow mode into the sandbox so scripts
// self-stub; data-store and latency-gate just skip their KV write inline. Whether
// a run is a shadow run is decided only by run-reality.ts (#1708).

export function shadowIntegrationStub(): StepExecutionResult {
  return { output: { status: 200, body: { _shadow: true }, headers: {} } }
}

export function shadowSalesforceStub(): StepExecutionResult {
  return { output: { status: 200, body: { _shadow: true } } }
}

export function shadowAchieveStub(): StepExecutionResult {
  return {
    output: { accepted: false, status: 200, reason: 'shadow', request: {}, offers: [], _shadow: true },
  }
}
