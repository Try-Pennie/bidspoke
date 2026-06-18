import type { ExecutionContext, StepExecutionResult } from '../types'

/** True when the current run is a dry-run shadow: run the workflow logic but
 *  skip every external side effect. See docs/engine-cutover-scope.md section 3.3. */
export function isShadowDryRun(ctx: ExecutionContext): boolean {
  return ctx.shadow_mode === 'dry_run'
}

// Stub outputs mirror each outbound node's success shape, tagged `_shadow` so a
// stubbed step is distinguishable from a real one in logs and spot-checks.
//
// Not every node uses a builder here: partner-bid returns its canonical
// `skip(slug, 'shadow')`; code passes `shadow_mode` into the sandbox so scripts
// self-stub; data-store and latency-gate just skip their KV write inline. Each
// of those calls `isShadowDryRun(ctx)` directly.

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
