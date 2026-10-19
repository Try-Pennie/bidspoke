/**
 * OpsGateway: the bidding Worker's entrypoint for the ops Worker (#1949, Dan's
 * decision 4). Reached only through the ops Worker's OPS_GATEWAY service binding
 * (wrangler.ops.toml), never the public edge, which reaches only the default
 * export (spike P6). What it serves and why, and who may call it, are in
 * ops-gateway.ts.
 *
 * A named export of this Worker's main module (index.ts), as the Durable Object
 * classes are. Each method is one bounded piece of work its caller awaits, with
 * the library's retries off (a lead client's setting, #1844), since the tick
 * gives up at 15 s and keeps its saved copies: the workflow list (one paged
 * read), the connection list (two paged reads, #2335), a heartbeat stamp (one KV
 * write), money's identity for one organization (one KV read, #2335), or a
 * rotated login's compare and set (one rpc, #2335).
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from '../env'
import { createSupabaseClient } from './supabase'
import { readMoneyIdentities } from './money-identity'
import { readOpsConnections, readOpsWorkflows, recordOpsTickCompleted, recordOpsTickStarted, storeRotatedEnvelope } from './ops-gateway'

export class OpsGateway extends WorkerEntrypoint<Env> {
  opsWorkflows() {
    return readOpsWorkflows(createSupabaseClient(this.env, { retry: false }), Date.now())
  }

  /**
   * Every ops connection's sealed envelope, public config and target, with
   * serve_until 6 hours on, and the removals of the last 7 hours (#2335): two
   * paged reads, retries off, since the tick gives up at its gateway deadline
   * and keeps its copies. Lane wide; never a plaintext login. Who may call it
   * and whose data: readOpsConnections in ops-gateway.ts.
   */
  opsConnections() {
    return readOpsConnections(createSupabaseClient(this.env, { retry: false }), Date.now())
  }

  /**
   * Money's measured Salesforce identity for the one organization named, and
   * no other (#2335): one KV read. Who may call it and whose data:
   * money-identity.ts.
   */
  moneyIdentities(organizationId: unknown) {
    return readMoneyIdentities(this.env.IDEMPOTENCY, organizationId, Date.now())
  }

  async opsTickStarted() {
    await recordOpsTickStarted(this.env.IDEMPOTENCY, Date.now())
    return { stamped: 'started' }
  }

  async opsTickCompleted(report: unknown) {
    await recordOpsTickCompleted(this.env.IDEMPOTENCY, report, Date.now())
    return { stamped: 'completed' }
  }

  /**
   * The ops ConnectionTokenObject's compare and set of a person bound login it
   * rotated (#2335): one rpc, retries off, since the object retries from its
   * own alarm. Who may call it and whose row it writes: ops-gateway.ts.
   */
  storeRotatedEnvelope(request: unknown) {
    return storeRotatedEnvelope(createSupabaseClient(this.env, { retry: false }), request)
  }
}
