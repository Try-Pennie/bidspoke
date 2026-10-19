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
 * read), the connection list (two paged reads, #2335), a heartbeat stamp of the
 * tick or of an ops job (one KV write, #2340), money's identity for one organization (one KV read, #2335), a
 * rotated login's compare and set (one rpc, #2335), or a resealed login's
 * compare and set during a rotation of the ops key (one rpc, #2333).
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from '../env'
import { createSupabaseClient } from './supabase'
import { readMoneyIdentities } from './money-identity'
import {
  readOpsConnections, readOpsWorkflows, recordOpsJobCompleted, recordOpsJobStarted, recordOpsTickCompleted, recordOpsTickStarted, replaceConnectionEnvelope,
  storeRotatedEnvelope,
} from './ops-gateway'

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
   * An ops job's started stamp (#2340): one KV write under the job's own id,
   * for an id in OPS_GATEWAY_JOBS only, any other refused by name. Called by
   * the ops Worker's sweeps (the sf_limits sweep, #2336) over its OPS_GATEWAY
   * binding, and by nothing else. Who may call it: ops-gateway.ts.
   */
  async opsJobStarted(jobId: unknown) {
    const job = await recordOpsJobStarted(this.env.IDEMPOTENCY, jobId, Date.now())
    return { stamped: 'started', job }
  }

  /** An ops job's completed stamp (#2340), as opsJobStarted, with the job's report, which is only logged. */
  async opsJobCompleted(jobId: unknown, report: unknown) {
    const job = await recordOpsJobCompleted(this.env.IDEMPOTENCY, jobId, report, Date.now())
    return { stamped: 'completed', job }
  }

  /**
   * The ops ConnectionTokenObject's compare and set of a person bound login it
   * rotated (#2335): one rpc, retries off, since the object retries from its
   * own alarm. Who may call it and whose row it writes: ops-gateway.ts.
   */
  storeRotatedEnvelope(request: unknown) {
    return storeRotatedEnvelope(createSupabaseClient(this.env, { retry: false }), request)
  }

  /**
   * The ops Worker's resealConnections' compare and set of one login moved to
   * the current ops kid during a rotation of the ops key (#2333): one rpc,
   * retries off, since the reseal reports a row it could not write and is run
   * again until nothing is left. Who may call it and whose row it writes:
   * ops-gateway.ts.
   */
  replaceConnectionEnvelope(request: unknown) {
    return replaceConnectionEnvelope(createSupabaseClient(this.env, { retry: false }), request)
  }
}
