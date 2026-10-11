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
import { runClickPathChecksForEnv, CLICK_PATH_CHECKS_JOB } from './lib/click-path-checks'
import { runBuyerSelectParityRefreshForEnv, BUYER_SELECT_PARITY_JOB, EVERY_ORGANIZATION } from './lib/buyer-select-parity'
import { runEngineScriptDriftForEnv, ENGINE_SCRIPT_DRIFT_JOB } from './lib/engine-script-drift'
import { getSlackConnection } from './lib/slack'
import { makeAlertClaims } from './lib/alert-claim'
import { runCronTickOnce } from './lib/cron-once'
import { runEmailDropRateCheck } from './lib/email-drop-rate'
import { runBigTableGuard } from './lib/big-table-guard'
import { runDrainStallCheck } from './lib/drain-stall'
import { runSightingsBufferCheck } from './lib/sightings-buffer-lag'
import { runSecretDriftCheck } from './lib/secret-drift'
import { runRequiredSecretsCheck } from './lib/required-secrets'
import { runRequiredEnvVarsCheck } from './lib/required-env-vars'
import { runSecretDecryptHealthCheck } from './lib/secret-decrypt-health'
import { notifyExportFailure } from './lib/export-alerts'
import { formatErr } from './lib/format-error'
import { writeHeartbeat, writeHeartbeatCompleted, runHeartbeatChecks } from './lib/cron-heartbeat'
import { runPartnerReachabilityCheck, fetchProbe, liveSenders } from './lib/partner-reachability'
import { resolveSlackForEveryOrg } from './lib/standing-alert'
import { runDatabaseMemoryCheck, fetchMemoryReading, metricsUrl, liveDatabaseMemorySenders, DATABASE_MEMORY_JOB } from './lib/database-memory'
import { formatScheduleSummary, runWorkflowScheduleWatch } from './lib/workflow-schedule-watch'
import { runPgCronWatch, QUIET_STATUSES as pgCronQuietStatuses } from './lib/pg-cron-watch'
import { runTimeoutAuditCheck } from './lib/timeout-audit'
import { runSlowExecutionCheck } from './lib/slow-execution-rate'
import { runReduceFinalizeStrandedExecutions } from './lib/stranded-executions'
import { recordAndCheckBranchSkew } from './lib/strand-branch-skew'
import { runUnconfirmedWriteSweepForEnv, UNCONFIRMED_WRITE_SWEEP_JOB } from './lib/unconfirmed-write-sweep'
import { readAnswerJournal } from './engine/unconfirmed-writes'
import { runFailureRateCheck } from './lib/failure-rate'
import { runUpstreamOutageCheck } from './lib/upstream-outage'
import { runSightingsExport, notifySetAsideRows } from './lib/sightings-export'
import { runDeadLetterBuildTriggerCheck } from './lib/deadletter-volume'
import { runKillRateDriftCheck } from './archive/kill-rate-drift'
import { runAchieveExport, notifyEnrollmentViewSkipped } from './lib/achieve-export'
import { recordExportRun, EXPORT_JOBS } from './lib/export-run-record'
import { prewarmKvCaches } from './lib/cache-prewarm'
import { sweepSources, sweepStoredCopies, type SweepResult } from './lib/stored-copy-sweep'
import { flushStoredCopyLedger } from './lib/stored-copy-ledger'
import { runStoredCopyChecks } from './lib/stored-copy-signals'
import { syncAllSalesforceConfigs } from './lib/bid-matrix-sync'
import { runFieldPresenceDroughtCheck, runFieldPresenceDeadCheck } from './lib/field-presence-anomaly'
import { isCustomEndpointHost, handleCustomEndpoint } from './routes/custom-endpoint'
import { secretKeys } from './lib/secret-crypto'

export { DailyCapObject } from './durable-objects/daily-cap'
export { CircuitBreakerObject } from './durable-objects/circuit-breaker'
export { BulkheadObject } from './durable-objects/bulkhead'
export { LatencyMarkObject } from './durable-objects/latency-mark'
export { AlertClaimObject } from './durable-objects/alert-claim'
export { BuyerLedgerObject } from './durable-objects/buyer-ledger'
export { LeadSaleObject } from './durable-objects/lead-sale'

export type { Env } from './env'
import type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()

// The count of stored copies a request served or refused (#1848) is written
// after the response, never on it, and not at all when nothing was noted.
// Registered first so it wraps every route, the custom endpoint one included.
app.use('*', async (c, next) => {
  await next()
  const kv = c.env?.IDEMPOTENCY
  if (!kv) return
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined
  try {
    ctx = c.executionCtx
  } catch {
    // A request with no execution context (a unit test) has nowhere to put it.
    ctx = undefined
  }
  ctx?.waitUntil(flushStoredCopyLedger(kv))
})

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

// The scheduled jobs, dispatched on the cron string (see wrangler.toml [triggers]).
// Reached only through `scheduled` below, once the tick has been claimed (#1899).
const scheduledJobs = {
  /** Starts every job the cron names and returns their work, to be awaited. */
  start(event: ScheduledEvent, env: Env, platformCtx: ExecutionContext): Promise<unknown>[] {
    const supabase = createSupabaseClient(env)
    // Every job's work is tracked, so once it has all settled the stored copies
    // any of them served or refused (#1848) are counted, in one write.
    const work: Promise<unknown>[] = []
    // Only waitUntil is used below, and the type holds every job to that.
    const ctx: Pick<ExecutionContext, 'waitUntil'> = {
      waitUntil: (p: Promise<unknown>) => {
        work.push(p)
        platformCtx.waitUntil(p)
      },
    }
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
        recordExportRun(supabase, EXPORT_JOBS.achieveExport, () => runAchieveExport(supabase, env))
          .then(async (s) => {
            console.log('[achieve-export]', JSON.stringify(s))
            // Rows the enrollment view ran out of time for are exported and purged without
            // it, so they are their own alert, not an export failure (#1363). Reported on
            // every measured run, because the empty report is what clears the condition.
            await notifyEnrollmentViewSkipped(supabase, s.enrollment_view_skipped, env.IDEMPOTENCY)
              .catch((e) => console.error('[achieve-export] enrollment view shortfall alert failed:', e))
            return notifyExportFailure(supabase, 'Achieve export', s.errors, env.IDEMPOTENCY, 'export-job')
          })
          .catch((e) => {
            console.error('[achieve-export] failed:', e)
            return notifyExportFailure(supabase, 'Achieve export', [formatErr(e)], env.IDEMPOTENCY, 'export-job')
          })
      )
    } else if (event.cron === '17 8 * * *') {
      // Timeout audit, on its own off-peak schedule (#251). Its grouped
      // percentile queries are the heaviest thing we run against execution_steps,
      // so they sit in the quietest hour rather than at 9 AM ET. It is a separate
      // cron rather than a move of the whole 13:00 batch, because that batch also
      // carries nine other daily alerts whose arrival time nobody asked to change.
      // At :17 because no database job starts then (#1884): at :15 it shared the
      // minute with both rollup refreshes and slowed lead requests to 8.5 s.
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
      // #355: announce when ADR 0002's build-now condition for the durable outcome
      // store is met (an unrecoverable row loss, or sustained dead-letter volume).
      track(
        runDeadLetterBuildTriggerCheck(env.IDEMPOTENCY, supabase, env.APP_URL)
          .catch((e) => console.error('[deadletter-build-trigger] check failed:', e))
      )
      // #1355: re-measure the live archive kill distribution and warn when the
      // kill-rate thresholds no longer sit where they were calibrated. Monthly
      // cooldown, so running it in the daily batch is effectively a slow recheck.
      track(
        runKillRateDriftCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[killrate-drift] check failed:', e))
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
      // #463: the sightings buffer drifting behind while every export and purge
      // run reports success. On 2026-07-01 the purge had been behind for a month.
      track(
        runSightingsBufferCheck(supabase, env.IDEMPOTENCY)
          .then((r) => { if (r.findings.length || r.unmeasured.length) console.log(`[sightings-buffer] ${[...r.findings, ...r.unmeasured].join(' | ')}`) })
          .catch((e) => console.error('[sightings-buffer] check failed:', e))
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
      // Does the Tripoint partner record still class the same result codes as
      // Duplicate as the code list does (#1647)? buyer_select reads the record,
      // which anyone can edit on the partner page, while the sightings and the
      // Salesforce scripts read the code. Beside the pricing check, under its own
      // failure boundary and alert state (L71).
      track(
        (async () => {
          const { checkTripointDuplicateCodes } = await import('./lib/tripoint-duplicate-codes-check')
          const r = await checkTripointDuplicateCodes(env, supabase)
          if (r.alerted) console.error(`[tripoint-duplicate-codes] ${r.outcome}: ${r.findings.length} findings`)
        })().catch((e) => console.error('[tripoint-duplicate-codes] failed:', e)),
      )
      // Do the Snowflake tables the nightly exports write to still accept what
      // those exports send (#428)? The export column lists and the Snowflake DDL
      // are maintained by hand in two places, and on 2026-06-27 a NOT NULL the
      // source never promised failed the export with nothing warning first. Here,
      // not inside the export, so it takes nothing from the export's time budget.
      track(
        (async () => {
          const { checkExportSchema } = await import('./lib/export-schema-check')
          const r = await checkExportSchema(env, supabase)
          if (r.alerted) console.error(`[export-schema] ${r.findings.length} findings, ${r.unreadable.length} unreadable`)
        })().catch((e) => console.error('[export-schema] failed:', e)),
      )
      // Does each sale's Salesforce Lead carry the Completed its Submission
      // carries, per partner (#1524, #1525)? The copy stopped on 2026-07-08 for
      // every partner and nothing noticed for eleven weeks. Its own failure
      // boundary (L71).
      track(
        (async () => {
          const { checkLeadStatus } = await import('./lib/lead-status-check')
          const r = await checkLeadStatus(env, supabase)
          if (r.alerted) console.error(`[lead-status] ${r.findings.length} findings`)
        })().catch((e) => console.error('[lead-status] failed:', e)),
      )
      // The Phase 3 buyer objects drill, once a day (#1643). It ran only by hand and
      // kept nothing, so the Stage A record could not show it ran on days 3 to 7. Under
      // a job_runs row with every scenario, the latency and its own claim expiries and
      // heals; a failed scenario pages. Rehearsal kind, throwaway drill- buyer only.
      track(
        (async () => {
          const { runScheduledBuyerObjectsDrillForEnv } = await import('./lib/buyer-objects-health')
          await runScheduledBuyerObjectsDrillForEnv(supabase, env)
        })().catch((e) => console.error('[buyer-objects-drill] failed:', e)),
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
      // (the reduce_finalize_stranded pg_cron job, at :00 and :30 when this was
      // set and at :27 and :57 since #1884, alone runs 30s+ against
      // this same table, plus the 5-minute stats refreshes and the hourly
      // bid-matrix sync), and this job's statements carry PostgREST's 8s budget.
      // Pinned to :00 it lost that race on every run (2026-07-03 incident).
      ctx.waitUntil(
        writeHeartbeat(env.IDEMPOTENCY, 'sightings-export')
          .catch((e) => console.error('[cron-heartbeat] export write failed:', e))
      )
      ctx.waitUntil(completeAfter(
        recordExportRun(supabase, EXPORT_JOBS.sightingsExport, () => runSightingsExport(supabase, env))
          .then(async (s) => {
            console.log('[sightings-export]', JSON.stringify(s))
            // Rows Snowflake refused are their own alert, not an export failure:
            // everything else exported (#427). Reported on every run, even an empty
            // one, because the empty report is what clears the condition.
            await notifySetAsideRows(supabase, s.set_aside, env.IDEMPOTENCY)
              .catch((e) => console.error('[sightings-export] set aside alert failed:', e))
            return notifyExportFailure(supabase, 'Lead sightings export', s.errors, env.IDEMPOTENCY, 'export-job')
          })
          .catch((e) => {
            console.error('[sightings-export] failed:', e)
            return notifyExportFailure(supabase, 'Lead sightings export', [formatErr(e)], env.IDEMPOTENCY, 'export-job')
          }),
        'sightings-export',
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
          const { archiveSender } = await import('./lib/execution-archive-send')
          return runExecutionArchive(env, supabase, {
            sendBatch: archiveSender(env),
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
            .then(() => runBuyerSelectParityRefreshForEnv(supabase, env, EVERY_ORGANIZATION))
            .then((s) => {
              if (s.skipped) return
              console.log(`[${BUYER_SELECT_PARITY_JOB}] days=${s.days.join(',')} rows_written=${s.rows_written} kept_final=${s.kept_final.length} errors=${s.errors.length}`)
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
              const states = [...s.verdicts, ...s.configVerdicts].map((v) => `${v.workflow}/${v.namespace}=${v.state}`).join(' ')
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
          const { archiveSender } = await import('./lib/execution-archive-send')
          const { CRON_RUN_BUDGET } = await import('./archive/deadline')
          const deps = backlogDeps(env, supabase, async (day, alreadyRecorded, wallMs) => {
            const summary = await runExecutionArchive(env, supabase, {
              sendBatch: archiveSender(env),
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
                lastGood: () => readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env)),
                log: (line) => console.error(line),
                logPrefix: '[partner-reachability]',
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
      // Database memory (#1928): reads Supabase's metrics feed and alerts once memory has
      // been thin for 15 minutes, the condition that stalled the database on 2026-10-08
      // after a week unseen. Its own heartbeat, beside the probe rather than after it, so
      // a slow partner cannot hold it up. The Slack fallback matters most here: this alert
      // is needed exactly when the database holding the connection is struggling.
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, DATABASE_MEMORY_JOB)
            .catch((e) => console.error('[database-memory] heartbeat write failed:', e))
            .then(() => {
              const url = metricsUrl(env.SUPABASE_URL)
              return runDatabaseMemoryCheck({
                kv: env.IDEMPOTENCY,
                claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
                env: env as unknown as Record<string, string | undefined>,
                read: () => url
                  ? fetchMemoryReading({ url, secretKey: env.SUPABASE_SECRET_KEY })
                  : Promise.resolve({ kind: 'failed' as const, reason: 'SUPABASE_URL is not a URL the metrics feed can be built from' }),
                resolveSlack: () => resolveSlackForEveryOrg({
                  supabase,
                  getConnection: getSlackConnection,
                  lastGood: () => readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env)),
                  log: (line) => console.error(line),
                  logPrefix: '[database-memory]',
                }),
                senders: liveDatabaseMemorySenders,
                now: Date.now,
                log: (line) => console.log(line),
              })
            })
            .then((s) => {
              console.log(`[database-memory] mode=${s.mode} state=${s.state} alerts=${s.alerts.join(',') || '-'} all_clears=${s.allClears.join(',') || '-'}`)
              if (s.errors.length) console.error(`[database-memory] errors=${s.errors.join(' | ')}`)
            })
            .catch((e) => console.error('[database-memory] check failed:', e)),
          DATABASE_MEMORY_JOB,
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
      // The click buyer path checks (#1546): the share of buyer_click_check runs
      // that could not answer, the path gone quiet in the buyer's selling hours,
      // a burst of refused clicks, and once a Pacific day the counted clicks
      // against Salesforce. Under a job run record (L557); both heartbeat stamps (L514).
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, CLICK_PATH_CHECKS_JOB)
            .catch((e) => console.error(`[${CLICK_PATH_CHECKS_JOB}] heartbeat write failed:`, e))
            .then(() => runClickPathChecksForEnv(supabase, env))
            .then((s) => {
              if (s.skipped) return
              const verdicts = s.subjects.map((b) => `${b.slug ?? b.partner_id}:${b.check_errors.verdict}/${b.quiet.verdict}/${b.refusals.verdict}/${b.reconcile.verdict}`).join(' ')
              console.log(`[${CLICK_PATH_CHECKS_JOB}] subjects=${s.subjects.length} paged=${JSON.stringify(s.paged)}${s.unmeasured ? ` unmeasured=${s.unmeasured}` : ''} ${verdicts}`)
            })
            .catch((e) => console.error(`[${CLICK_PATH_CHECKS_JOB}] checks failed:`, e)),
          CLICK_PATH_CHECKS_JOB,
        ),
      )
    } else if (event.cron === '* * * * *') {
      ctx.waitUntil(
        prewarmKvCaches(supabase, env)
          .catch((e) => console.error('[prewarm] failed:', e))
      )
      // Repairs any stored outage copy an edit route could not refresh or clear
      // (#1846), so the copy never serves an old version for longer than this.
      // Then the stored copy alerts (#1848), after the sweep so they judge what it
      // just did, and whatever the sweep did: one that threw counts as failing.
      ctx.waitUntil(
        sweepStoredCopies(env.WORKFLOW_CACHE, sweepSources(supabase, env.WORKFLOW_CACHE))
          .then((r): SweepResult => {
            if (r.repaired.length > 0) console.log(`[stored-copy-sweep] checked=${r.checked} repaired=${r.repaired.length} ${r.repaired.join(' ')}`)
            // Copies no lead reached, stamped as confirmed so they do not age out (#1847).
            if (r.reconfirmed.length > 0) console.log(`[stored-copy-sweep] checked=${r.checked} reconfirmed=${r.reconfirmed.length}`)
            if (r.failed.length > 0) console.error(`[stored-copy-sweep] could not sweep: ${r.failed.join(' | ')}`)
            return r
          }, (e: unknown): SweepResult => {
            console.error('[stored-copy-sweep] failed:', e)
            return { checked: 0, repaired: [], reconfirmed: [], failed: [`every copy: ${formatErr(e)}`] }
          })
          .then((sweep) => runStoredCopyChecks({
            kv: env.IDEMPOTENCY,
            copies: env.WORKFLOW_CACHE,
            supabase,
            secretKeys: secretKeys(env),
            claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
            appUrl: env.APP_URL,
            sweep,
          }))
          .then((c) => {
            if (c.serving !== 'quiet' || c.stale > 0 || c.sweepFailingSince !== null) {
              console.log(`[stored-copy-checks] serving=${c.serving} active_minutes=${c.activeMinutes ?? 'unmeasured'} stale=${c.stale} sweep_failing_since=${c.sweepFailingSince ?? '-'}${c.suppressed ? ' suppressed=true' : ''}`)
            }
          })
          .catch((e) => console.error('[stored-copy-checks] failed:', e))
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
      // Reads back the post-response writes that only timed out (#1880): drops
      // the ones that landed, reports the ones that did not as lost, and says
      // so when the database will not answer for 15 minutes.
      ctx.waitUntil(
        completeAfter(
          writeHeartbeat(env.IDEMPOTENCY, UNCONFIRMED_WRITE_SWEEP_JOB)
            .catch((e) => console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] heartbeat write failed:`, e))
            .then(() => runUnconfirmedWriteSweepForEnv(supabase, env))
            .then((s) => {
              if (s.listed > s.young) {
                console.log(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] listed=${s.listed} landed=${s.landed} lost=${s.lost} unreadable=${s.unreadable} young=${s.young} could_not_confirm=${s.could_not_confirm}`)
              }
            })
            .catch((e) => console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] sweep failed:`, e)),
          UNCONFIRMED_WRITE_SWEEP_JOB,
        ),
      )
      ctx.waitUntil(
        runVolumeCliffCheck(supabase, env.IDEMPOTENCY, env.APP_URL, env.SELF_CHECK_URL, secretKeys(env), makeAlertClaims(env.ALERT_CLAIM))
          .catch((e) => console.error('[volume-cliff] check failed:', e))
      )
      ctx.waitUntil(
        runSlowExecutionCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[slow-spike] check failed:', e))
      )
      ctx.waitUntil(
        // A stranded run is restored from its answer journal when it has one (#1883).
        runReduceFinalizeStrandedExecutions(supabase, { readJournal: (id) => readAnswerJournal(env.IDEMPOTENCY, id) })
          .then(async (r) => {
            if (r.processed > 0 || r.errors > 0) console.log(`[stranded-executions] processed=${r.processed} errors=${r.errors}`)
            // Watch the mix of resolution branches over a window: the conservative
            // unresolved fallback resolving every row while no precise branch ever
            // fires is the shape of a precise path that cannot match (#1133).
            await recordAndCheckBranchSkew(env.IDEMPOTENCY, r.byBranch, { supabase, appUrl: env.APP_URL })
              .catch((e) => console.error('[strand-branch-skew] check failed:', e))
          })
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
    return work
  },
}

export default {
  fetch: app.fetch.bind(app),
  // Claims (cron expression, scheduled minute) before any job starts, and skips
  // the whole invocation when another delivery of the same tick holds it (#1899):
  // Cloudflare has delivered every tick twice since 2026-10-08 13:38 UTC. A retry
  // of a killed run still runs, and a claim that cannot be asked fails open.
  // The rule is in lib/cron-once.ts and on TICK_RETRY_AFTER_MS.
  //
  // The run is RETURNED as well as handed to waitUntil: if the jobs cannot even
  // start (a throw building the database client), the invocation fails as it
  // did before the claim, so Cloudflare can retry it, and the claim is released
  // rather than marked done. The waitUntil copy is caught only so the failure
  // is not reported twice.
  scheduled(event: ScheduledEvent, env: Env, platformCtx: ExecutionContext): Promise<void> {
    const run = runCronTickOnce(env.ALERT_CLAIM, event, async () => {
      const work = scheduledJobs.start(event, env, platformCtx)
      await Promise.allSettled(work)
      // A cron that started nothing (a retired one) leaves nothing to count.
      // The count is bookkeeping, never a reason to run the jobs again.
      if (work.length > 0) {
        await flushStoredCopyLedger(env.IDEMPOTENCY)
          .catch((e) => console.error('[stored-copy-ledger] flush after the scheduled run failed:', e))
      }
    }).then(() => undefined)
    platformCtx.waitUntil(run.catch(() => undefined))
    return run
  },
}
