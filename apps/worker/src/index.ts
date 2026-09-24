import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import webhooks from './routes/webhooks'
import shadow from './routes/shadow'
import api from './routes/api/index'
import { createSupabaseClient } from './lib/supabase'
import { runVolumeAnomalyCheck } from './lib/volume-anomaly'
import { runBidRecordingCoverageCheck } from './lib/bid-recording-coverage'
import { runTripointRevenueFillForEnv } from './lib/tripoint-revenue-fill'
import { runVolumeCliffCheck, readLastGoodSlackConnections } from './lib/volume-cliff'
import { runBuyerSaleDrainForEnv, BUYER_SALE_DRAIN_JOB } from './lib/buyer-sale-drain'
import { runBuyerSalesChecksForEnv, BUYER_SALES_CHECKS_JOB } from './lib/buyer-sales-checks'
import { runBuyerSelectParityRefreshForEnv, BUYER_SELECT_PARITY_JOB } from './lib/buyer-select-parity'
import { runEngineScriptDriftForEnv, ENGINE_SCRIPT_DRIFT_JOB } from './lib/engine-script-drift'
import { getSlackConnection } from './lib/slack'
import { makeAlertClaims } from './lib/alert-claim'
import { runEmailDropRateCheck } from './lib/email-drop-rate'
import { runBigTableGuard } from './lib/big-table-guard'
import { runDrainStallCheck } from './lib/drain-stall'
import { runSecretDriftCheck } from './lib/secret-drift'
import { runRequiredSecretsCheck } from './lib/required-secrets'
import { runRequiredEnvVarsCheck } from './lib/required-env-vars'
import { runSecretDecryptHealthCheck } from './lib/secret-decrypt-health'
import { notifyExportFailure } from './lib/export-alerts'
import { formatErr } from './lib/format-error'
import { writeHeartbeat, writeHeartbeatCompleted, runHeartbeatChecks } from './lib/cron-heartbeat'
import { runPartnerReachabilityCheck, fetchProbe, liveSenders, resolveSlackForEveryOrg } from './lib/partner-reachability'
import { formatScheduleSummary, runWorkflowScheduleWatch } from './lib/workflow-schedule-watch'
import { runPgCronWatch, QUIET_STATUSES as pgCronQuietStatuses } from './lib/pg-cron-watch'
import { runTimeoutAuditCheck } from './lib/timeout-audit'
import { runSlowExecutionCheck } from './lib/slow-execution-rate'
import { runReduceFinalizeStrandedExecutions } from './lib/stranded-executions'
import { runFailureRateCheck } from './lib/failure-rate'
import { runUpstreamOutageCheck } from './lib/upstream-outage'
import { runSightingsExport, runSightingsPurge } from './lib/sightings-export'
import { runAchieveExport } from './lib/achieve-export'
import { prewarmKvCaches } from './lib/cache-prewarm'
import { syncAllSalesforceConfigs } from './lib/bid-matrix-sync'
import { runFieldPresenceDroughtCheck, runFieldPresenceDeadCheck } from './lib/field-presence-anomaly'
import { isCustomEndpointHost, handleCustomEndpoint } from './routes/custom-endpoint'

export { DailyCapObject } from './durable-objects/daily-cap'
export { CircuitBreakerObject } from './durable-objects/circuit-breaker'
export { BulkheadObject } from './durable-objects/bulkhead'
export { LatencyMarkObject } from './durable-objects/latency-mark'
export { AlertClaimObject } from './durable-objects/alert-claim'
export { BuyerLedgerObject } from './durable-objects/buyer-ledger'
export { LeadSaleObject } from './durable-objects/lead-sale'

export interface Env {
  // KV namespaces
  WORKFLOW_CACHE: KVNamespace
  IDEMPOTENCY: KVNamespace
  SUBMISSIONS: KVNamespace

  // Durable Objects
  DAILY_CAP: DurableObjectNamespace
  CIRCUIT_BREAKER: DurableObjectNamespace
  // Inflight-concurrency limiter for Salesforce (ADR 0005 / #312)
  SALESFORCE_BULKHEAD: DurableObjectNamespace
  // Latency Gate bid marks (#488). A DO, not KV: the mark and the confirmation land
  // in different colos, and KV's propagation delay made a fast confirmation look
  // like a missing mark, which the gate rejects.
  LATENCY_MARK: DurableObjectNamespace
  // Alert claims (#1298): exactly one cron tick posts a given alert per cooldown.
  ALERT_CLAIM: DurableObjectNamespace
  // Buyer selection (#1410): one SQLite ledger per buyer, holding reservations
  // and outcomes; caps are counted from it. Sale state, not self healing.
  BUYER_LEDGER: DurableObjectNamespace
  // Buyer selection (#1410): one claim per lead, so a lead is sold at most once.
  LEAD_SALE: DurableObjectNamespace

  // Max simultaneous in-flight Salesforce calls (string env var; default 20,
  // kept below SF's ~25-slot concurrency governor). Optional.
  SALESFORCE_BULKHEAD_LIMIT?: string
  SALESFORCE_BULKHEAD_WAIT_MS?: string

  // Supabase (secrets)
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_JWKS_URL: string  // public var in wrangler.toml

  // Webhook auth — JSON string: { [apiKey: string]: sourceName }
  API_KEY_MAP: string

  // PII redaction — comma-separated field patterns, empty = disabled (PRD 12.4)
  PII_REDACTION_FIELDS: string

  // Field-presence capture (#419/#410). 'true' enables the dark write of the
  // per-execution watched-field presence map; off or unset disables it.
  // Default off so deploying before the migration is applied is safe.
  FIELD_PRESENCE_CAPTURE?: string

  // Frontend URL — used for deep links in Slack alerts
  APP_URL: string

  // Git commit the live worker was deployed from — stamped via `wrangler deploy
  // --var DEPLOYED_SHA:<sha>` in the deploy workflow, surfaced at GET / so a
  // scheduled check can detect a "committed but never deployed" worker (#327).
  DEPLOYED_SHA?: string

  // External hostname the volume-cliff monitor hits to confirm the worker is
  // reachable from outside Cloudflare. Must be a stable bidspoke-owned URL that
  // routes to this worker. Optional — falls back to a built-in default.
  SELF_CHECK_URL?: string

  // Cloudflare API — for syncing secrets (PRD 12.3)
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string
  // Logpush destination check (#1010). Optional: the check reports its own
  // absence rather than failing, so the worker runs without it. Note it carries
  // Logs EDIT, because Cloudflare's Logpush API requires write permission even
  // for a GET; read-only is not available for that API.
  CLOUDFLARE_LOGS_TOKEN?: string

  // Env var secret encryption — AES-GCM key, base64-encoded 32 bytes
  // Generate: openssl rand -base64 32 | wrangler secret put SECRET_ENCRYPTION_KEY
  SECRET_ENCRYPTION_KEY: string

  // SSN hash pepper — used for indexed dedup lookups on persons.ssn_hash
  // Generate: openssl rand -base64 32 | wrangler secret put SSN_HASH_PEPPER
  // CRITICAL: rotating this secret breaks all dedup lookups (old hashes become unmatchable)
  SSN_HASH_PEPPER: string

  // Snowflake REST API: export of lead_sightings + lead_sighting_bids (every 2h).
  // Auth: key-pair JWT. Service user `bidspoke_service` with role `bidspoke_role`.
  SNOWFLAKE_ACCOUNT: string         // URL prefix, e.g. 'jyc55588.us-east-1'
  SNOWFLAKE_USER: string
  SNOWFLAKE_PRIVATE_KEY: string     // RSA PEM (PKCS#1 or PKCS#8)
  SNOWFLAKE_DATABASE: string
  SNOWFLAKE_SCHEMA: string
  SNOWFLAKE_WAREHOUSE: string
  SNOWFLAKE_ROLE: string

  // Execution archive (#870, Phase A2). Three identities in their own Snowflake
  // database, split by what each may DESTROY: the writer and the reader hold no
  // DELETE, and the eraser is the only one that does, so a bug or a leaked
  // credential on the hourly ingest or the read path cannot remove archived rows.
  //
  // The account, database, schema and warehouse are NOT repeated per identity:
  // all three live in BIDSPOKE_ARCHIVE.EXECUTIONS on ARCHIVE_WH, created by
  // docs/snowflake-archive-setup.sql, and a second copy of those values is a
  // second thing to keep in step.
  //
  // Deliberately NOT in REQUIRED_SECRETS yet. That guard alerts every org's Slack
  // daily, so registering six secrets before the Snowflake identities exist would
  // page for nothing every day until they do. They join it in A3 (#871), when the
  // archiver that reads them ships.
  ARCHIVE_WRITER_USER: string
  ARCHIVE_WRITER_PRIVATE_KEY: string    // RSA PEM, the PRIVATE half of the writer key pair
  ARCHIVE_READER_USER: string
  ARCHIVE_READER_PRIVATE_KEY: string
  ARCHIVE_ERASER_USER: string
  ARCHIVE_ERASER_PRIVATE_KEY: string

  // Dynamic Worker dispatch — code node sandboxing (PRD Section 5.4)
  DYNAMIC_WORKER_LOADER: DispatchNamespace

  // GitHub backup — push workflow definitions on save (PRD Section 3.2)
  // Optional: set via `wrangler secret put GITHUB_TOKEN` and wrangler.toml [vars] GITHUB_REPO
  GITHUB_TOKEN?: string
  GITHUB_REPO?: string

  // This repository, for the scheduled-workflow dead-man's-switch (#805). Distinct
  // from GITHUB_REPO above, which points at the separate workflow-BACKUP repo.
  // Set in wrangler.toml [vars].
  GITHUB_CODE_REPO?: string

  // Read-only credential for GITHUB_CODE_REPO's Actions history (#842). Separate
  // from GITHUB_TOKEN because that one is the BACKUP repo's push credential and
  // cannot see this repository, which is what left the check reporting "cannot
  // tell" from the day it shipped. GITHUB_TOKEN stays as a fallback so the check
  // does not go dark before this is set.
  // Set via `wrangler secret put GITHUB_ACTIONS_TOKEN --name bidspoke-worker`.
  GITHUB_ACTIONS_TOKEN?: string

  // Anthropic API — used to draft changelog summaries on workflow save
  // Optional: set via `wrangler secret put ANTHROPIC_API_KEY --name bidspoke-worker`
  ANTHROPIC_API_KEY?: string

  // Set to 'true' ONLY in apps/worker/.dev.vars (gitignored, never in production).
  // Local `wrangler dev` shares the real production Supabase project and Slack
  // connection — there is no separate local backend — so this flags "running
  // locally" for guards that would otherwise fire real production alerts from
  // local testing (e.g. the GitHub-backup-failure Slack alert).
  LOCAL_DEV?: string

  // 'on' lets the partner reachability probe (#1274) post to Slack. Anything else
  // is observe mode: the probe runs every five minutes and logs what it would
  // have posted, so its setup is proven on real traffic before a page can be
  // false. Set in wrangler.toml [vars]; #1396 flips it after the observe day.
  PARTNER_PROBE_ALERTS?: string

  // Set to 'true' ONLY in apps/worker/.dev.vars, alongside LOCAL_DEV, to opt a
  // local session into writing to the remote (production) Supabase project.
  // Without it, local dev is read-only against a remote database: the Worker
  // connects as service_role and bypasses RLS, so an unguarded local write can
  // land anywhere in production (#669). See lib/supabase.ts.
  ALLOW_PROD_WRITES?: string

}

const app = new Hono<{ Bindings: Env }>()

app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = ['https://bidspoke.pages.dev', 'https://bidspoke.trypennie.dev']
      if (allowed.includes(origin)) return origin
      // Accept any localhost port in dev — Next.js bumps to 3001+ when 3000 is busy
      if (/^http:\/\/localhost:\d+$/.test(origin)) return origin
      return null
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true,
    // Cache preflight for 24h so repeat requests from the app skip the OPTIONS round-trip
    maxAge: 86400,
  })
)

// Log the real error server-side, but return a generic message — never echo raw
// err.message to callers, which can leak internal/DB details (#107). Exported
// for unit testing.
export function genericOnError(err: Error, c: Context) {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
}
app.onError(genericOnError)

app.get('/', (c) => c.json({ status: 'ok', service: 'bidspoke-worker', version: c.env.DEPLOYED_SHA ?? 'unknown' }))

// Custom endpoint routing — handles *.trypennie.dev partner subdomains
// Must be registered before /webhooks and /api so it intercepts early
app.use('*', async (c, next) => {
  if (isCustomEndpointHost(c.req.header('host') ?? '')) {
    return handleCustomEndpoint(c)
  }
  return next()
})

// Webhook execution endpoint — authenticated via X-API-Key (PRD 12.2)
app.route('/webhooks', webhooks)

// Shadow mirror endpoint — dry-run shadow of engine traffic (Phase 4.3)
app.route('/shadow', shadow)

// REST API — JWT authenticated
app.route('/api', api)

// Scheduled handler — dispatches on cron string (see wrangler.toml [triggers])
export default {
  fetch: app.fetch.bind(app),
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    const supabase = createSupabaseClient(env)
    // Stamps a watched job "completed" once its work has SETTLED, whichever way
    // it settled (#985). The work's own handler owns logging and alerting; this
    // only records that the run reached its end. It is deliberately not chained
    // after that handler, because a failure alert that itself throws would then
    // skip the stamp and read as a vanished run (L514).
    const completeAfter = (work: Promise<unknown>, jobId: string): Promise<void> =>
      work
        .catch((e) => console.error(`[${jobId}] failed past its own handler:`, e))
        .then(() => writeHeartbeatCompleted(env.IDEMPOTENCY, jobId))
        .catch((e) => console.error(`[cron-heartbeat] ${jobId} completed write failed:`, e))
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(
        runAchieveExport(supabase, env)
          .then((s) => {
            console.log('[achieve-export]', JSON.stringify(s))
            return notifyExportFailure(supabase, 'Achieve export', s.errors, env.IDEMPOTENCY, 'export-job')
          })
          .catch((e) => {
            console.error('[achieve-export] failed:', e)
            return notifyExportFailure(supabase, 'Achieve export', [formatErr(e)], env.IDEMPOTENCY, 'export-job')
          })
      )
    } else if (event.cron === '15 8 * * *') {
      // Timeout audit, on its own off-peak schedule (#251). Its grouped
      // percentile queries are the heaviest thing we run against execution_steps,
      // so they sit in the quietest hour rather than at 9 AM ET. It is a separate
      // cron rather than a move of the whole 13:00 batch, because that batch also
      // carries nine other daily alerts whose arrival time nobody asked to change.
      ctx.waitUntil(
        writeHeartbeat(env.IDEMPOTENCY, 'timeout-audit')
          .catch((e) => console.error('[cron-heartbeat] timeout-audit write failed:', e))
      )
      ctx.waitUntil(completeAfter(
        runTimeoutAuditCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[timeout-audit] check failed:', e)),
        'timeout-audit',
      ))
    } else if (event.cron === '0 13 * * *') {
      // Dead-man's-switch heartbeat: stamp that this batch dispatched (#358).
      ctx.waitUntil(
        writeHeartbeat(env.IDEMPOTENCY, 'daily-1300')
          .catch((e) => console.error('[cron-heartbeat] daily write failed:', e))
      )
      // Every check in this batch is tracked so the batch can stamp "completed"
      // only once all of them have settled (#985). Each keeps its own failure
      // boundary; a check that rejects is still a settled check.
      const dailyWork: Promise<unknown>[] = []
      const track = (p: Promise<unknown>): void => {
        dailyWork.push(p)
        ctx.waitUntil(p)
      }
      track(
        runVolumeAnomalyCheck(supabase)
          .catch((e) => console.error('[volume-anomaly] check failed:', e))
      )
      track(
        runFieldPresenceDeadCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[field-presence-dead] failed:', e))
      )
      // #1157: a bidding workflow whose bid never reaches lead_sighting_bids
      // succeeds on every run, so the gap shows up only as data that is not
      // there. Lead Economy sat that way for weeks. Each workflow is judged
      // against its peers in the same window, because bid rows are purged before
      // their sightings are and "no bid rows" is otherwise ambiguous.
      track(
        runBidRecordingCoverageCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[bid-recording] check failed:', e))
      )
      // #744: leads whose email Salesforce rejected are still created, without the
      // address, and the run succeeds. Nothing counted that, so a source sending
      // damaged addresses in bulk was invisible.
      track(
        runEmailDropRateCheck(supabase, env.IDEMPOTENCY)
          .catch((e) => console.error('[email-drop-rate] check failed:', e))
      )
      track(
        runSecretDriftCheck(supabase, env)
          .then((r) => console.log(`[secret-drift] checked=${r.checked} missing=${r.missing} alerted=${r.alerted}`))
          .catch((e) => console.error('[secret-drift] check failed:', e))
      )
      track(
        runRequiredSecretsCheck(supabase, env)
          .then((r) => { if (r.missing.length) console.error(`[required-secrets] MISSING=${r.missing.join(',')} alerted=${r.alerted}`) })
          .catch((e) => console.error('[required-secrets] check failed:', e))
      )
      track(
        runRequiredEnvVarsCheck(supabase, env)
          .then((r) => { if (r.missing.length) console.error(`[required-env-vars] MISSING=${r.missing.join(',')} alerted=${r.alerted}`) })
          .catch((e) => console.error('[required-env-vars] check failed:', e))
      )
      track(
        runSecretDecryptHealthCheck(supabase, env)
          .then((r) => { if (r.undecryptable) console.error(`[secret-decrypt-health] undecryptable=${r.undecryptable} alerted=${r.alerted}`) })
          .catch((e) => console.error('[secret-decrypt-health] check failed:', e))
      )
      track(
        runBigTableGuard(supabase, env.IDEMPOTENCY)
          .then((r) => { if (r.offenders.length) console.log(`[big-table-guard] offenders=${r.offenders.join(',')} alerted=${r.alerted}`) })
          .catch((e) => console.error('[big-table-guard] check failed:', e))
      )
      track(
        runDrainStallCheck(supabase, env.IDEMPOTENCY)
          .then((r) => { if (r.stranded > 0) console.log(`[drain-stall] stranded=${r.stranded} alerted=${r.alerted}`) })
          .catch((e) => console.error('[drain-stall] check failed:', e))
      )
      // What each archive identity can actually DO, verified by attempting it
      // (#914). The least-privilege split is what keeps a bug or a leaked
      // credential on the ingest path from destroying archived rows, and it
      // rested entirely on the statements in a SQL file. The gap is asymmetric:
      // a missing grant fails loudly on the first run, an excessive one never
      // surfaces because nothing ever attempts what it should not be allowed to
      // do (L503).
      track(
        (async () => {
          const { checkArchiveIdentities } = await import('./lib/archive-identity-check')
          const r = await checkArchiveIdentities(env, supabase)
          if (r.alerted) console.error(`[archive-identities] ${r.findings.length} findings`)
        })().catch((e) => console.error('[archive-identities] failed:', e))
      )
      // The index the archive READS by, read back (#1044). Without it the
      // peak-hour count takes 7.1 seconds warm and times out under load, which
      // is the failure #1040 fixed. An index is a performance property, so
      // nothing reports its absence until a run fails, and by then the archive
      // has already stopped moving. Two ways it goes: a migration drops it, or
      // a partition ATTACHed rather than created does not inherit it and leaves
      // the parent index invalid.
      track(
        (async () => {
          const { checkArchiveIndex } = await import('./lib/archive-index-check')
          const r = await checkArchiveIndex(supabase, env.IDEMPOTENCY)
          if (r.alerted) console.error(`[archive-index] ${r.findings.length} findings`)
        })().catch((e) => console.error('[archive-index] failed:', e))
      )
      // The archive's Snowflake settings, read back (#980). The
      // never-delete-without-a-backup guarantee rests on settings applied BY
      // HAND in Snowflake, and nothing read any of them back: the undo window
      // was recorded as a measured fact, was wrong for days, and was caught only
      // because somebody happened to probe. A setting whose value carries the
      // guarantee is asserted on a schedule, not audited at change time (L502).
      track(
        (async () => {
          const { checkArchiveSettings } = await import('./lib/archive-settings-check')
          const r = await checkArchiveSettings(env, supabase)
          if (r.alerted) console.error(`[archive-settings] ${r.differences.length} differences`)
        })().catch((e) => console.error('[archive-settings] failed:', e))
      )
      // The 13 month retention, actually enforced (#875). Until this existed
      // nothing deleted an archived row on age, so the window in which an
      // applicant's SSN sits in one queryable place had no upper bound and the
      // stated retention was aspirational. Runs as the eraser, which is the only
      // identity in the account holding DELETE on that table.
      // It is watched by the dead-man switch, so it has to stamp. #1324
      // registered it in CRON_JOBS and added no stamp, so it ran and finished
      // for two days while the switch reported it had never run and pointed the
      // reader at cron triggers that were correct (#1332).
      track(
        (async () => {
          const { expireArchivedDays, ARCHIVE_EXPIRY_JOB } = await import('./lib/archive-expiry')
          const { withJobRun } = await import('./lib/job-run-record')
          await writeHeartbeat(env.IDEMPOTENCY, ARCHIVE_EXPIRY_JOB).catch((e) =>
            console.error('[cron-heartbeat] archive-expiry write failed:', e)
          )
          try {
            const r = await withJobRun(
              supabase,
              ARCHIVE_EXPIRY_JOB,
              () => expireArchivedDays(env, supabase),
              (result) => ({
                // A run that deleted nothing gets its own outcome, so "there was
                // nothing old enough" is never filed as the same event as a run
                // that did work (L98).
                outcome: result.failed ? 'failed' : result.daysExpired.length === 0 ? 'nothing-expired' : 'expired',
                detail: result.detail,
                summary: {
                  cutoff: result.cutoff,
                  daysExpired: result.daysExpired,
                  rowsDeleted: result.rowsDeleted,
                },
              }),
            )
            console.log(`[archive-expiry] ${r.detail}`)
          } finally {
            // A handled failure is a finished run; only a killed or hung one
            // leaves no completion, which is the distinction the stamp carries
            // (#985). So it is written on every exit path (L514).
            await writeHeartbeatCompleted(env.IDEMPOTENCY, ARCHIVE_EXPIRY_JOB).catch((e) =>
              console.error('[cron-heartbeat] archive-expiry completed write failed:', e)
            )
          }
        })().catch((e) => console.error('[archive-expiry] failed:', e))
      )
      // Room left before the archive's busiest hour no longer fits one run
      // (#1294). At the limit a run archives nothing while completing cleanly,
      // which reads as a run with nothing to do until the standstill detector
      // speaks hours later about a stall, which is true and is not the finding.
      // Daily, because this moves at the speed the business grows.
      track(
        (async () => {
          const { checkArchiveHeadroom } = await import('./lib/archive-headroom-check')
          const r = await checkArchiveHeadroom(env, supabase)
          console.log(`[archive-headroom] ${r.reading.kind} alerted=${r.alerted}`)
        })().catch((e) => console.error('[archive-headroom] failed:', e))
      )
      // Where do this account's production logs actually go (#1010)? The
      // account is SHARED with other Pennie projects, so a destination can be
      // added by somebody who has never heard of Bidspoke, and one was: an
      // external vendor received applicant SSNs through the `Logs` field for
      // months before anybody could read the configuration (#1007). The field
      // list is checked as well as the destination set, because the destination
      // never changed and the field list is what did the harm. Its own failure
      // boundary (L71).
      track(
        (async () => {
          const { checkLogpush } = await import('./lib/logpush-check')
          const r = await checkLogpush(env, supabase)
          if (r.alerted) console.error(`[logpush-check] ${r.differences.length} differences`)
        })().catch((e) => console.error('[logpush-check] failed:', e))
      )
      // Which code nodes print a whole object into the log stream (#1230)? The
      // platform captures console output before any redaction of ours runs, and
      // that stream is exportable off-platform, so a print is an egress. Scans
      // the live definitions rather than the repo, because definitions live in
      // the database and are edited on the canvas. Its own failure boundary (L71).
      track(
        (async () => {
          const { checkPayloadPrints } = await import('./lib/payload-print-check')
          const r = await checkPayloadPrints(env, supabase)
          if (r.alerted) console.error(`[payload-print-check] ${r.newFindings.length} new findings`)
        })().catch((e) => console.error('[payload-print-check] failed:', e))
      )
      // Is the purge still destroying execution data on the schedule the code
      // believes (#1017)? Its own failure boundary, because a watchdog must not
      // share the abort behaviour of the work it watches (L71): this failing must
      // not stop the gate below it from running.
      track(
        (async () => {
          const { checkExecutionRetention } = await import('./lib/retention-check')
          const r = await checkExecutionRetention(env, supabase)
          if (r.alerted) console.error(`[retention-check] ${r.differences.length} differences`)
        })().catch((e) => console.error('[retention-check] failed:', e)),
      )
      // Does Bidspoke still price a Tripoint lead the way Salesforce books it
      // (#1166)? Two hand-edited settings in two products, and the high band read
      // 0.0013 in one and 0.0012 in the other for three months with nothing
      // comparing them. Its own failure boundary, like the check above (L71).
      track(
        (async () => {
          const { checkTripointPricing } = await import('./lib/tripoint-pricing-check')
          const r = await checkTripointPricing(env, supabase)
          if (r.alerted) console.error(`[tripoint-pricing] ${r.differences.length} differences`)
        })().catch((e) => console.error('[tripoint-pricing] failed:', e)),
      )
      // Does a Tripoint sale's Salesforce Lead carry the Completed its
      // Submission carries (#1524)? The copy stopped on 2026-07-08 and nothing
      // noticed for eleven weeks. Its own failure boundary (L71).
      track(
        (async () => {
          const { checkTripointLeadStatus } = await import('./lib/tripoint-lead-status-check')
          const r = await checkTripointLeadStatus(env, supabase)
          if (r.alerted) console.error(`[tripoint-lead-status] ${r.findings.length} findings`)
        })().catch((e) => console.error('[tripoint-lead-status] failed:', e)),
      )
      // The deletion gate's measurements (#872, Phase A4). SHADOW: it writes
      // numbers to execution_archive_days and nothing reads them to authorise a
      // deletion until A5 (#873). Daily, because it re-measures every day still
      // inside the 7 day retention window and the staleness limit is one cadence
      // plus slack.
      track(
        (async () => {
          const { runArchiveGate } = await import('./lib/archive-gate')
          const r = await runArchiveGate(env, supabase)
          console.log(`[archive-gate] ${r.detail}`)
        })().catch((e) => console.error('[archive-gate] failed:', e))
      )
      ctx.waitUntil(completeAfter(Promise.allSettled(dailyWork), 'daily-1300'))
    } else if (event.cron === '37 */2 * * *') {
      // Lead sightings export runs every 2 hours in its own invocation so it gets a
      // full per-run subrequest budget. One run drains ~50K rows (the platform
      // ceiling, handled by exportTable's clean-stop) and inflow is ~83K/day, so a
      // once-daily run fell permanently behind; 12 runs/day stays well ahead.
      // At :37, NOT :00 -- the top of the hour is the DB's most congested moment
      // (the :00/:30 reduce_finalize_stranded pg_cron job alone runs 30s+ against
      // this same table, plus the 5-minute stats refreshes and the hourly
      // bid-matrix sync), and this job's statements carry PostgREST's 8s budget.
      // Pinned to :00 it lost that race on every run (2026-07-03 incident).
      ctx.waitUntil(
        writeHeartbeat(env.IDEMPOTENCY, 'sightings-export')
          .catch((e) => console.error('[cron-heartbeat] export write failed:', e))
      )
      ctx.waitUntil(completeAfter(
        runSightingsExport(supabase, env)
          .then((s) => {
            console.log('[sightings-export]', JSON.stringify(s))
            return notifyExportFailure(supabase, 'Lead sightings export', s.errors, env.IDEMPOTENCY, 'export-job')
          })
          .catch((e) => {
            console.error('[sightings-export] failed:', e)
            return notifyExportFailure(supabase, 'Lead sightings export', [formatErr(e)], env.IDEMPOTENCY, 'export-job')
          }),
        'sightings-export',
      ))
    } else if (event.cron === '47 1-23/2 * * *') {
      // Its own invocation, so the purge gets its own wall-time budget. Sharing the
      // export's budget let a growing export starve it to zero rows deleted,
      // silently, for days (2026-07-10). Scoped to lead_sightings only: bids purge
      // runs on the even-hour cron below, so a large sightings backlog cannot
      // exhaust one invocation's subrequest budget and leave bids at zero (the
      // first real run's symptom, 2026-07-10). Alerts under its own job name: a
      // purge failure must never read as "Snowflake analytics are stale", because
      // the rows are already in Snowflake and only the Supabase cleanup is behind.
      ctx.waitUntil(
        writeHeartbeat(env.IDEMPOTENCY, 'sightings-purge')
          .catch((e) => console.error('[cron-heartbeat] purge write failed:', e))
      )
      ctx.waitUntil(completeAfter(
        runSightingsPurge(supabase, Date.now, undefined, ['lead_sightings'])
          .then((s) => {
            console.log('[sightings-purge]', JSON.stringify(s))
            return notifyExportFailure(supabase, 'Lead sightings purge', s.errors, env.IDEMPOTENCY, 'export-job')
          })
          .catch((e) => {
            console.error('[sightings-purge] failed:', e)
            return notifyExportFailure(supabase, 'Lead sightings purge', [formatErr(e)], env.IDEMPOTENCY, 'export-job')
          }),
        'sightings-purge',
      ))
    } else if (event.cron === '47 0-22/2 * * *') {
      // Bids purge on the even hours, its own invocation so it never shares a
      // subrequest budget with the sightings purge (see the odd-hour block above).
      ctx.waitUntil(
        writeHeartbeat(env.IDEMPOTENCY, 'sighting-bids-purge')
          .catch((e) => console.error('[cron-heartbeat] bids purge write failed:', e))
      )
      ctx.waitUntil(completeAfter(
        runSightingsPurge(supabase, Date.now, undefined, ['lead_sighting_bids'])
          .then((s) => {
            console.log('[sighting-bids-purge]', JSON.stringify(s))
            return notifyExportFailure(supabase, 'Lead sighting bids purge', s.errors, env.IDEMPOTENCY, 'export-job')
          })
          .catch((e) => {
            console.error('[sighting-bids-purge] failed:', e)
            return notifyExportFailure(supabase, 'Lead sighting bids purge', [formatErr(e)], env.IDEMPOTENCY, 'export-job')
          }),
        'sighting-bids-purge',
      ))
    } else if (event.cron === '23 * * * *') {
      // Execution archive to Snowflake (#871, Phase A3). SHADOW: it writes the
      // archive and its own bookkeeping, and changes nothing about what any job
      // deletes. Both destructive jobs stay untouched until A5 (#873).
      // Started before the work, completed after it settles: a run the platform
      // kills writes the first and never the second, which is what the heartbeat
      // check reads as vanished (#985).
      ctx.waitUntil(completeAfter(
        (async () => {
          await writeHeartbeat(env.IDEMPOTENCY, 'execution-archive')
          const { runExecutionArchive } = await import('./lib/execution-archive')
          const { sendArchiveBatch } = await import('./lib/execution-archive-send')
          return runExecutionArchive(env, supabase, {
            sendBatch: (rows) => sendArchiveBatch(env, rows),
            // The event identity, so a platform retry of this cron can take over
            // the lock its terminated predecessor left (#1181).
            scheduledFor: new Date(event.scheduledTime),
          })
        })().catch((e) => console.error('[execution-archive] failed:', e)),
        'execution-archive',
      ))
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        syncAllSalesforceConfigs(env, supabase)
          .then((r) => console.log(`[bid-matrix-sync] ${r.successes.length} succeeded, ${r.failures.length} failed`))
          .catch((e) => console.error('[bid-matrix-sync] failed:', e))
      )
      // The Stage A parity rows (#1413): every workflow carrying a buyer_select
      // node gets its days inside retention re-summarised, so a day is recorded
      // before the execution_steps purge reaches it (L202). Writes counts only;
      // a sign off whose numbers moved is cleared by the function that writes them.
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, BUYER_SELECT_PARITY_JOB)
            .catch((e) => console.error(`[${BUYER_SELECT_PARITY_JOB}] heartbeat write failed:`, e))
            .then(() => runBuyerSelectParityRefreshForEnv(supabase, env))
            .then((s) => {
              if (s.skipped) return
              console.log(`[${BUYER_SELECT_PARITY_JOB}] days=${s.days.join(',')} rows_written=${s.rows_written} errors=${s.errors.length}`)
              if (s.errors.length) console.error(`[${BUYER_SELECT_PARITY_JOB}] errors=${s.errors.join(' | ')}`)
            })
            .catch((e) => console.error(`[${BUYER_SELECT_PARITY_JOB}] refresh failed:`, e)),
          BUYER_SELECT_PARITY_JOB,
        ),
      )
      // The kept Engine scripts against the canvas mirror (#1472): pages when a
      // code node holds a script the repo has no copy of, records an awaited
      // paste in job_runs without paging, and its first agreeing run after a
      // paste is the confirmation the paste landed.
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, ENGINE_SCRIPT_DRIFT_JOB)
            .catch((e) => console.error(`[${ENGINE_SCRIPT_DRIFT_JOB}] heartbeat write failed:`, e))
            .then(() => runEngineScriptDriftForEnv(supabase, env))
            .then((s) => {
              if (s.skipped) return
              const states = s.verdicts.map((v) => `${v.namespace}=${v.state}`).join(' ')
              console.log(`[${ENGINE_SCRIPT_DRIFT_JOB}] findings=${s.findings.length}${s.unreadable ? ` unreadable=${s.unreadable}` : ''} ${states}`)
            })
            .catch((e) => console.error(`[${ENGINE_SCRIPT_DRIFT_JOB}] check failed:`, e)),
          ENGINE_SCRIPT_DRIFT_JOB,
        ),
      )
      // Watched, because the audit failed every hour for at least four months
      // with nothing but this console line to show for it (#982). The wrapper
      // alerts on a throw and on an empty read, and never throws itself.
      ctx.waitUntil(
        (async () => {
          const { runMatrixAuditWatched } = await import('./lib/matrix-audit-health')
          const w = await runMatrixAuditWatched(env, supabase)
          const r = w.result
          if (w.ok && r) console.log(`[sf-matrix-audit] fetched=${r.rows_fetched} added=${r.rows_added} edited=${r.rows_edited} removed=${r.rows_removed} alerted=${r.alerted}`)
        })().catch((e) => console.error('[sf-matrix-audit] failed:', e))
      )
      ctx.waitUntil(
        runFieldPresenceDroughtCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[field-presence-drought] failed:', e))
      )
      // Archive gaps the forward-only run leaves behind (#1015). The hourly run
      // advances a watermark and never looks back, so a day it did not cover
      // stays uncovered: six such days existed on 2026-08-23 and nothing had
      // reported them, because the hourly run was healthy the whole time.
      //
      // Runs AFTER the archive above, so it works on a settled frontier rather
      // than competing with the run that is moving it, and it takes the same lock,
      // so a conflict simply means the hourly run is busy and this waits a cycle.
      ctx.waitUntil(
        (async () => {
          const { runArchiveBacklog, backlogDeps, hoursOfDay } = await import('./lib/archive-backlog-run')
          const { runExecutionArchive } = await import('./lib/execution-archive')
          const { sendArchiveBatch } = await import('./lib/execution-archive-send')
          const { CRON_RUN_BUDGET } = await import('./archive/deadline')
          const deps = backlogDeps(env, supabase, async (day, alreadyRecorded, wallMs) => {
            const summary = await runExecutionArchive(env, supabase, {
              sendBatch: (rows) => sendArchiveBatch(env, rows),
              hours: hoursOfDay(day),
              alreadyRecorded,
              // What the WALK says is left of this invocation, never more than a
              // normal run would take anyway (#1184). Without this the repair
              // budgets 13 minutes from its own start, the walk's reads are on
              // top, and the pair reached the platform's 900 second kill on
              // 2026-08-25.
              budget: { wallMs: Math.min(wallMs, CRON_RUN_BUDGET.wallMs), maxHours: CRON_RUN_BUDGET.maxHours },
            })
            return { hoursArchived: summary.hoursArchived, failed: summary.failed, detail: summary.detail }
          })
          const r = await runArchiveBacklog(deps)
          console.log(`[archive-backlog] ${r.detail}`)
        })().catch((e) => console.error('[archive-backlog] failed:', e)),
      )

      // The execution archive making no progress (#946). Hourly rather than
      // inside the archive run itself, because a run the platform kills reports
      // nothing, and a watchdog must not share the fate of the work it watches.
      // The cron heartbeat covers the archive not RUNNING; this covers it
      // running and getting nowhere, which is what happened for 19 hours on
      // 2026-08-21 with every other signal reading healthy.
      ctx.waitUntil(
        (async () => {
          const { checkArchiveStandstill } = await import('./lib/archive-standstill')
          const r = await checkArchiveStandstill(supabase, env.IDEMPOTENCY)
          console.log(`[archive-standstill] ${r.verdict.status} alerted=${r.alerted}`)
        })().catch((e) => console.error('[archive-standstill] failed:', e))
      )
      // Watches GitHub's own scheduled workflows (#805). cron-heartbeat covers
      // this worker's crons; nothing covered the ones running in Actions, and a
      // scheduled workflow that stops firing is silent in exactly the same way as
      // one that keeps passing. Hourly rather than on the minute cron because it
      // costs a GitHub API call per watched workflow.
      // Watches the DATABASE's own scheduled jobs (#770). cron-heartbeat covers
      // this worker's crons and workflow-schedule-watch covers GitHub's; nothing
      // read cron.job_run_details, so a pg_cron job could fail every night
      // unseen. It had: 62 failed runs across four jobs over a month (#833).
      ctx.waitUntil(
        runPgCronWatch(supabase, env.IDEMPOTENCY)
          .then((rs) => {
            for (const r of rs) {
              if (r.status === 'healthy') continue
              // Quiet statuses (recovered, awaiting_first_run) are information,
              // not faults: visible in the log, never at error level.
              const log = pgCronQuietStatuses.has(r.status) ? console.log : console.error
              log(`[pg-cron-watch] ${r.jobname} ${r.status} alerted=${r.alerted} ${r.detail}`)
            }
          })
          .catch((e) => console.error('[pg-cron-watch] check failed:', e))
      )
      // The workflow dispatcher that drives these same workflows runs on the
      // 15 minute cron below (#1058, #1368), concurrently with this watch across
      // ticks for the same reason it once did within one: the watchdog must not
      // be hostage to the work it watches (L71).
      ctx.waitUntil(
        runWorkflowScheduleWatch(supabase, env.IDEMPOTENCY, env)
          .then((rs) => {
            // Logged on EVERY run, including a clean one. A working check is
            // silent, and silence is exactly what this check exists to distrust,
            // so a fresh reading with a real age in it is the only way to tell it
            // is working from the outside (#842).
            console.log(`[workflow-schedule] ${formatScheduleSummary(rs)}`)
            for (const r of rs) {
              if (r.status !== 'healthy') {
                console.error(`[workflow-schedule] ${r.file} ${r.status} alerted=${r.alerted} ${r.detail}`)
              }
            }
          })
          .catch((e) => console.error('[workflow-schedule] check failed:', e))
      )
    } else if (event.cron === '*/5 * * * *') {
      // Partner reachability probe (#1274): asks each partner host whether a
      // firewall block page is standing, every five minutes, and owns the
      // all-clear on the same key the lead path reports on. Lives in
      // lib/partner-reachability.ts so every transition is reachable from a test.
      // Both heartbeat stamps on every exit path (L514).
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, 'partner-reachability')
            .catch((e) => console.error('[partner-reachability] heartbeat write failed:', e))
            .then(() => runPartnerReachabilityCheck({
              kv: env.IDEMPOTENCY,
              claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
              env: env as unknown as Record<string, string | undefined>,
              probe: (target) => fetchProbe(target),
              resolveSlack: () => resolveSlackForEveryOrg({
                supabase,
                getConnection: getSlackConnection,
                lastGood: () => readLastGoodSlackConnections(env.IDEMPOTENCY, env.SECRET_ENCRYPTION_KEY),
                log: (line) => console.error(line),
              }),
              senders: liveSenders,
              now: Date.now,
              log: (line) => console.log(line),
            }))
            .then((s) => {
              console.log(`[partner-reachability] mode=${s.mode} probed=${s.probed} reachable=${s.reachable} blocked=${s.blocked} unreachable=${s.unreachable} unmeasured=${s.unmeasured} alerts=${s.alerts.join(',') || '-'} all_clears=${s.allClears.join(',') || '-'}`)
              if (s.errors.length) console.error(`[partner-reachability] errors=${s.errors.join(' | ')}`)
            })
            .catch((e) => console.error('[partner-reachability] check failed:', e)),
          'partner-reachability',
        ),
      )
    } else if (event.cron === '*/15 * * * *') {
      // Drive the scheduled workflows the worker also watches (#1058). GitHub
      // stopped delivering this repository's cron events reliably on 2026-08-26
      // while on-demand triggers kept working, so the worker fires them itself
      // when they fall behind.
      //
      // Every 15 minutes rather than hourly (#1368). The driver reads each
      // workflow's run history first, and a read GitHub refuses (the token
      // owner's request limit used up) leaves that tick doing nothing; hourly,
      // that cost a whole hour of Deploy Drift. It runs nothing more often,
      // because only an overdue workflow is dispatched, and its alert is held to
      // once an hour for the same failures.
      //
      // Independent of the hourly schedule watch, deliberately: a driver that
      // hangs must not take the watchdog down with it (L71). The work lives in
      // workflow-dispatch-run.ts so its failure handling is reachable from a
      // test.
      ctx.waitUntil(
        (async () => {
          const { runAndReportDispatch } = await import('./lib/workflow-dispatch-run')
          await runAndReportDispatch(supabase, env, env.IDEMPOTENCY)
        })().catch((e) => console.error('[workflow-dispatch] driver failed:', e)),
      )
      // #354: Tripoint's response carries no amount, so its wins had no price at
      // all. The figure comes from Salesforce afterwards, and this runs every 15
      // minutes because bid rows reach Snowflake about 57 minutes after the bid
      // and the purge then deletes them: a value written after that never
      // reaches the warehouse. `exported_unpriced` is the residual it could not
      // reach, reported rather than assumed.
      ctx.waitUntil(
        runTripointRevenueFillForEnv(supabase, env)
          .then((r) => {
            console.log(`[tripoint-revenue] scanned=${r.scanned} filled=${r.filled} unmatched=${r.unmatched} unusable=${r.unusable} no_value=${r.no_value} exported_unpriced=${r.exported_unpriced}`)
            if (r.errors.length) console.error(`[tripoint-revenue] errors=${r.errors.join(' | ')}`)
          })
          .catch((e) => console.error('[tripoint-revenue] fill failed:', e))
      )
      // The buyer sales checks (#1413): completeness of the buyer_sales copy,
      // consistency with the bid rows, the independent Salesforce write back,
      // and the page for sales waiting on a person. Under a job run record so a
      // lifetime of zero passes is visible (L557); both heartbeat stamps (L514).
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, BUYER_SALES_CHECKS_JOB)
            .catch((e) => console.error(`[${BUYER_SALES_CHECKS_JOB}] heartbeat write failed:`, e))
            .then(() => runBuyerSalesChecksForEnv(supabase, env))
            .then((s) => {
              if (s.skipped) return
              const verdicts = s.buyers.map((b) => `${b.slug}:${b.completeness.verdict}/${b.consistency.verdict}/${b.independent.verdict}/unresolved=${b.unresolved.count}`).join(' ')
              console.log(`[${BUYER_SALES_CHECKS_JOB}] days=${s.days.join(',')} buyers=${s.buyers.length} paged_mismatches=${s.mismatch_lines.length} paged_unresolved=${s.unresolved_lines.length}${s.unmeasured ? ` unmeasured=${s.unmeasured}` : ''} ${verdicts}`)
            })
            .catch((e) => console.error(`[${BUYER_SALES_CHECKS_JOB}] checks failed:`, e)),
          BUYER_SALES_CHECKS_JOB,
        ),
      )
    } else if (event.cron === '* * * * *') {
      ctx.waitUntil(
        prewarmKvCaches(supabase, env)
          .catch((e) => console.error('[prewarm] failed:', e))
      )
      // The buyer ledger outbox drain (#1413): delivers every ledger entry the
      // inline mirror did not copy to buyer_sales, through the same write. Both
      // heartbeat stamps on every exit path (L514); it pages through the shared
      // export alerter so the same KV keys mute it as every other job.
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, BUYER_SALE_DRAIN_JOB)
            .catch((e) => console.error(`[${BUYER_SALE_DRAIN_JOB}] heartbeat write failed:`, e))
            .then(() => runBuyerSaleDrainForEnv(supabase, env))
            .then((s) => {
              if (s.skipped) return
              const delivered = s.buyers.reduce((n, b) => n + b.delivered, 0)
              const pending = s.buyers.reduce((n, b) => n + b.pending, 0)
              if (pending > 0 || s.errors.length > 0 || s.unmeasured) {
                console.log(`[${BUYER_SALE_DRAIN_JOB}] buyers=${s.buyers.length} pending=${pending} delivered=${delivered} paged=${s.paged.length}${s.unmeasured ? ` unmeasured=${s.unmeasured}` : ''}`)
              }
              if (s.errors.length) console.error(`[${BUYER_SALE_DRAIN_JOB}] errors=${s.errors.join(' | ')}`)
            })
            .catch((e) => console.error(`[${BUYER_SALE_DRAIN_JOB}] drain failed:`, e)),
          BUYER_SALE_DRAIN_JOB,
        ),
      )
      ctx.waitUntil(
        runVolumeCliffCheck(supabase, env.IDEMPOTENCY, env.APP_URL, env.SELF_CHECK_URL, env.SECRET_ENCRYPTION_KEY, makeAlertClaims(env.ALERT_CLAIM))
          .catch((e) => console.error('[volume-cliff] check failed:', e))
      )
      ctx.waitUntil(
        runSlowExecutionCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[slow-spike] check failed:', e))
      )
      ctx.waitUntil(
        runReduceFinalizeStrandedExecutions(supabase)
          .then((r) => { if (r.processed > 0 || r.errors > 0) console.log(`[stranded-executions] processed=${r.processed} errors=${r.errors}`) })
          .catch((e) => console.error('[stranded-executions] check failed:', e))
      )
      ctx.waitUntil(
        runFailureRateCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[failure-spike] check failed:', e))
      )
      ctx.waitUntil(
        runUpstreamOutageCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[upstream-outage] check failed:', e))
      )
      ctx.waitUntil(
        runHeartbeatChecks(supabase, env.IDEMPOTENCY)
          .then((rs) => {
            for (const r of rs) {
              if (r.status === 'stale' || r.status === 'never_ran' || r.status === 'vanished') {
                console.error(`[cron-heartbeat] ${r.jobId} ${r.status} ageMs=${r.ageMs} alerted=${r.alerted}`)
              }
            }
          })
          .catch((e) => console.error('[cron-heartbeat] check failed:', e))
      )
    }
  },
}
