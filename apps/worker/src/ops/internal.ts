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
 * takes a deploy. Data reached: none.
 *
 * Each method refuses by name outside the ops lane, the same rule the fetch
 * handler applies, so a deploy that lost its config cannot answer here either.
 *
 * `ping` proves the dispatch arrives. The #1698 run engine (B3) adds its run
 * method here, behind the same lane check, with its HMAC as defence in depth.
 * Spike 0 measured what a call here may spend: its own CPU budget (32 s, not the
 * caller's), and it is canceled the moment its caller's invocation ends, so a
 * caller must await it (docs/ops-ceilings-spike.md P4).
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { OPS_LANE, type OpsEnv } from './index'

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
}

export function opsInternalIdentity(env: { LANE?: string }): { lane: 'ops'; entrypoint: 'OpsInternal' } {
  if (env.LANE !== OPS_LANE) throw new OpsInternalRefused(env.LANE ? `lane_not_ops (${env.LANE})` : 'lane_unset')
  return { lane: 'ops', entrypoint: 'OpsInternal' }
}

export class OpsInternal extends WorkerEntrypoint<OpsEnv> {
  ping() {
    return opsInternalIdentity(this.env)
  }
}
