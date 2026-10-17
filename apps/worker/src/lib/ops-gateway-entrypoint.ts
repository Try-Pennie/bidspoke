/**
 * OpsGateway: the bidding Worker's entrypoint for the ops Worker (#1949, Dan's
 * decision 4). Reached only through the ops Worker's OPS_GATEWAY service binding
 * (wrangler.ops.toml), never the public edge, which reaches only the default
 * export (spike P6). What it serves and why, and who may call it, are in
 * ops-gateway.ts.
 *
 * A named export of this Worker's main module (index.ts), as the Durable Object
 * classes are. Each method is one bounded piece of work the tick awaits: one
 * paged read with the library's retries off (a lead client's setting, #1844),
 * since the tick gives up on it at 15 s and plans from its saved copy, or one KV
 * write of a heartbeat stamp.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from '../env'
import { createSupabaseClient } from './supabase'
import { readOpsWorkflows, recordOpsTickCompleted, recordOpsTickStarted } from './ops-gateway'

export class OpsGateway extends WorkerEntrypoint<Env> {
  opsWorkflows() {
    return readOpsWorkflows(createSupabaseClient(this.env, { retry: false }), Date.now())
  }

  async opsTickStarted() {
    await recordOpsTickStarted(this.env.IDEMPOTENCY, Date.now())
    return { stamped: 'started' }
  }

  async opsTickCompleted(report: unknown) {
    await recordOpsTickCompleted(this.env.IDEMPOTENCY, report, Date.now())
    return { stamped: 'completed' }
  }
}
