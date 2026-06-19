import type { ExecutionContext, StepExecutionResult } from '../types'

/** True for any shadow run (dry_run or stand_in): no outbound submission fires.
 *  Use this for the HTTP/KV/DB/Salesforce side-effect short-circuits. */
export function isShadowDryRun(ctx: ExecutionContext): boolean {
  return ctx.shadow_mode === 'dry_run' || ctx.shadow_mode === 'stand_in'
}

/** True only for the stand-in sub-mode: Partner Bid still resolves a deterministic
 *  bid (formula/matrix locally; api from min_bid) without the outbound submission,
 *  so downstream winner selection and routing can be rehearsed. See #232. */
export function isShadowStandIn(ctx: ExecutionContext): boolean {
  return ctx.shadow_mode === 'stand_in'
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
