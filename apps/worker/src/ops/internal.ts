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
 * takes a deploy. Data reached: the spike's keys in PORTING_TEE, nothing else.
 *
 * Each method refuses by name outside the ops lane, the same rule the fetch
 * handler applies, so a deploy that lost its config cannot answer here either.
 *
 * Spike scope: `ping` proves the dispatch arrives; `probe` runs a callee ceiling
 * probe and only for the current arming (OPS_SPIKE_ARM), so holding the binding
 * is not enough to run one. The #1698 run engine (B2/B3) adds its run method
 * here, behind the same lane check, with its HMAC as defence in depth.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { OPS_LANE, type OpsEnv } from './index'
import { parseSpikeArm, realRuntime, runCalleeProbe, type CalleeProbeKind, type CalleeProbeRequest, type ProbeRuntime } from './spike/ceilings'

/** A refusal by OpsInternal, carrying its reason. */
export class OpsInternalRefused extends Error {
  constructor(readonly reason: string) {
    super(`OpsInternal refused: ${reason}`)
    this.name = 'OpsInternalRefused'
  }
}

const CALLEE_KINDS: readonly CalleeProbeKind[] = ['wall', 'cpu', 'subrequests']

function requireOpsLane(env: { LANE?: string }) {
  if (env.LANE !== OPS_LANE) throw new OpsInternalRefused(env.LANE ? `lane_not_ops (${env.LANE})` : 'lane_unset')
}

export function opsInternalIdentity(env: { LANE?: string }): { lane: 'ops'; entrypoint: 'OpsInternal' } {
  requireOpsLane(env)
  return { lane: 'ops', entrypoint: 'OpsInternal' }
}

export async function handleCalleeProbe(
  env: { LANE?: string; OPS_SPIKE_ARM?: string; PORTING_TEE: R2Bucket },
  request: CalleeProbeRequest,
  rt: ProbeRuntime,
): Promise<unknown> {
  requireOpsLane(env)
  const armState = parseSpikeArm(env.OPS_SPIKE_ARM, rt.now())
  if (armState.state !== 'armed') throw new OpsInternalRefused('not_armed')
  if (!armState.arm.probe.startsWith('dispatch_')) throw new OpsInternalRefused('not_a_dispatch_arming')
  if (request?.nonce !== armState.arm.nonce) throw new OpsInternalRefused('nonce_mismatch')
  if (!CALLEE_KINDS.includes(request.kind)) throw new OpsInternalRefused('unknown_kind')
  rt.log({ event: 'spike_1946', stage: 'callee_started', role: 'callee', kind: request.kind, nonce: request.nonce })
  const result = await runCalleeProbe(request.kind, rt, env.PORTING_TEE)
  rt.log({ event: 'spike_1946', stage: 'callee_finished', role: 'callee', kind: request.kind, nonce: request.nonce, result })
  return result
}

export class OpsInternal extends WorkerEntrypoint<OpsEnv> {
  ping() {
    return opsInternalIdentity(this.env)
  }

  /** A refusal comes back as `{ refused }`: an error crossing RPC keeps only its message. */
  async probe(request: CalleeProbeRequest): Promise<unknown> {
    try {
      return await handleCalleeProbe(this.env, request, realRuntime())
    } catch (err) {
      if (err instanceof OpsInternalRefused) return { refused: err.reason }
      throw err
    }
  }
}
