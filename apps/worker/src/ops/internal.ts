/**
 * OpsInternal: the ops Worker's internal entrypoint (#1946), the target of its
 * self-dispatch.
 *
 * Caller: only this Worker, through the SELF service binding in
 * wrangler.ops.toml (`entrypoint = "OpsInternal"`), never a fetch. Cloudflare
 * routes public traffic only to a Worker's DEFAULT export, so no public request
 * can reach a method here; and the default fetch handler (index.ts) has no path
 * that forwards to it, which ops-internal.test.ts pins. A Worker on this account
 * could reach it only by declaring its own binding to this entrypoint, which
 * takes a deploy. Data reached: none, except by resealConnections (#2333),
 * which reads every organization's ops connections from the bidding Worker,
 * ciphertext only, and writes each back only within its own organization.
 *
 * Each method refuses by name outside the ops lane, the same rule the fetch
 * handler applies, so a deploy that lost its config cannot answer here either.
 *
 * `ping` proves the dispatch arrives. `observe` (#1949) is what the minute cron
 * dispatches in observe mode: every fire it would have made, signed
 * (dispatch-auth.ts), verified here and logged, and nothing more, so the path a
 * run will take is exercised every minute short of the run itself (L142). Run
 * invocation (#1950) adds its run method here, behind the same checks.
 * Spike 0 measured what a call here may spend: its own CPU budget (32 s, not the
 * caller's), and it is canceled the moment its caller's invocation ends, so a
 * caller must await it (docs/ops-ceilings-spike.md P4).
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { dispatchKey, verifyDispatch, type SignedDispatch } from './dispatch-auth'
import { OPS_LANE, type OpsEnv } from './index'
import { resealConnections, type ResealRefused, type ResealReport } from './reseal'
import { liveResealDeps, ResealNotConfigured } from './reseal-live'

/** A refusal by OpsInternal, carrying its reason. */
export class OpsInternalRefused extends Error {
  constructor(readonly reason: string) {
    super(`OpsInternal refused: ${reason}`)
    this.name = 'OpsInternalRefused'
  }
}

/** The part of OpsInternal a caller reaches through the SELF binding. */
export interface OpsInternalBinding {
  ping(): Promise<unknown>
  observe(signed: SignedDispatch): Promise<unknown>
  /** A ResealReport or a ResealRefused (#2333). */
  resealConnections(request: { apply: boolean }): Promise<unknown>
}

/** What observe answers. */
export interface ObservedDispatch {
  observed: true
  tick_id: string
  kind: 'would_fire' | 'probe'
}

/**
 * A refusal, answered as a value rather than thrown across the binding: a
 * rejection crossing an RPC call surfaces in workerd as an uncaught error on the
 * callee's side as well as the caller's, which reads as a crash of the receiver.
 */
export interface RefusedDispatch {
  observed: false
  refused: string
}

export function opsInternalIdentity(env: { LANE?: string }): { lane: 'ops'; entrypoint: 'OpsInternal' } {
  if (env.LANE !== OPS_LANE) throw new OpsInternalRefused(env.LANE ? `lane_not_ops (${env.LANE})` : 'lane_unset')
  return { lane: 'ops', entrypoint: 'OpsInternal' }
}

/**
 * Verifies one observe dispatch and logs what would have run. Refuses by name
 * (OpsInternalRefused) outside the ops lane, without the master secret, and on
 * a signature or signing time that does not hold. The clock is a parameter for
 * the tests; the entrypoint passes Date.now.
 */
export async function observeDispatch(env: OpsEnv, signed: unknown, nowMs: number): Promise<ObservedDispatch> {
  opsInternalIdentity(env)
  const envelope = await verifyDispatch(await dispatchKey(env.PORTING_CAPTURE_MASTER), signed, nowMs)
  const item = envelope.item
  console.log(JSON.stringify({
    event: 'ops_observe', tick_id: envelope.tick_id, kind: item.kind,
    ...(item.kind === 'would_fire' ? { workflow_id: item.workflowId, scheduled_for: item.scheduledFor, dispatch_at: item.dispatchAt } : {}),
  }))
  return { observed: true, tick_id: envelope.tick_id, kind: item.kind }
}

export class OpsInternal extends WorkerEntrypoint<OpsEnv> {
  ping() {
    return opsInternalIdentity(this.env)
  }

  async observe(signed: SignedDispatch): Promise<ObservedDispatch | RefusedDispatch> {
    try {
      return await observeDispatch(this.env, signed, Date.now())
    } catch (err) {
      if (err instanceof OpsInternalRefused) return { observed: false, refused: err.reason }
      throw err
    }
  }

  /**
   * The reseal during a rotation of the ops key (#2333, reseal.ts): previews
   * unless the request says apply. Called by the minute cron while OPS_RESEAL
   * is set (reseal-live.ts), through SELF, so it has its own CPU budget. Every
   * answer is a value, a refusal included. The request carries only apply: a
   * caller could at most reseal a login to the committed current kid, which is
   * what every new seal uses anyway.
   */
  async resealConnections(raw?: unknown): Promise<ResealReport | ResealRefused> {
    try {
      opsInternalIdentity(this.env)
    } catch (err) {
      return { ok: false, refused: 'lane_refused', detail: err instanceof OpsInternalRefused ? err.reason : 'the lane could not be read' }
    }
    const request = raw === undefined ? {} : raw
    if (typeof request !== 'object' || request === null || Array.isArray(request)
      || !Object.keys(request).every((k) => k === 'apply')
      || !((request as { apply?: unknown }).apply === undefined || typeof (request as { apply?: unknown }).apply === 'boolean')) {
      return { ok: false, refused: 'request_invalid', detail: 'a reseal request is { apply?: boolean } and nothing else' }
    }
    let deps
    try {
      deps = liveResealDeps(this.env)
    } catch (err) {
      if (err instanceof ResealNotConfigured) return { ok: false, refused: 'not_configured', detail: err.message }
      throw err
    }
    return resealConnections(deps, request as { apply?: boolean })
  }
}
