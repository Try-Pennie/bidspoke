/**
 * Dead-man's-switch for scheduled crons (#358, generalized in #612).
 *
 * Each watched cron writes a heartbeat timestamp to KV on every run; the
 * every-minute cron evaluates freshness for every registered job and alerts
 * Slack when one goes dark (its trigger failed to register on a deploy, or the
 * scheduled handler errored before dispatch). A per-job "first seen" marker
 * gives a fresh deploy a grace period so it does not false-alarm before the
 * job's first run, while still catching a cron that never fires.
 *
 * Originally this guarded only the 13:00 UTC health-check batch. #611 moved the
 * sightings purge onto its own cron, making that the sole path that drops
 * exported rows from Supabase -- and nothing watched it. The starved-purge
 * incident (2026-07-10, 107,274 purgeable rows sitting for days) is exactly the
 * "a cron silently stopped mattering" failure this switch exists to catch, so
 * the switch is now a registry any cron can join.
 *
 * TWO STAMPS, NOT ONE (#985). The started stamp alone can only catch a cron that
 * never FIRED. On 2026-08-22 the execution archive was killed by the platform
 * (exceededMemory) at 16:23, 17:23 and 18:23 UTC; each run stamped "started"
 * first and died before any summary or alert ran, and this check reported the
 * archive healthy through a three hour outage that a person found on a dashboard.
 * A run now also stamps "completed" once its work has settled, success or handled
 * failure alike, and a started stamp with no completion inside the job's run
 * allowance is its own verdict, `vanished`, with its own remedy: a killed or hung
 * run is a different problem from a trigger that never fired (L11, L98).
 *
 * A started stamp can only be judged against completions the check was LOOKING
 * FOR when the run began (#1207). The check records when it first found a job's
 * completed stamp missing, and a run that started before that marker is not
 * judged: it ran on code that never wrote completions, so their absence says
 * nothing about it. Minutes after the completed stamp first shipped
 * (2026-09-07), every job's last pre-deploy run was reported as killed (L599).
 *
 * THE INCIDENT RECORD (#2103). The paged status record (alertedStatusKey) is the
 * incident's marker: it appears on the first delivered page (opened), every
 * delivered page round is one page however many organizations it reached
 * (paged, as pg-cron-watch and the schedule watch count theirs), and it goes on
 * the stand down (ended: all_clear when an all-clear reached anyone, otherwise
 * stood_down_by_design, which is also how a dark job that came back without an
 * all-clear ends). The registry names that key, so the drain's lapse check reads
 * it. Because it is a marker it carries an expiry, renewed by every page round
 * and every check that still finds the job dark, so it cannot outlive every way
 * of removing it (ALERTED_STATUS_TTL_SECONDS). Every event is written after the Slack send it describes, stamped from the
 * pass's one clock reading, and a recorder fault is counted in the result and
 * never stops a page or an all-clear.
 *
 * ONE PAGE PER CAUSE (#2117). Every job is looked at before any is posted about.
 * When every watched job on one schedule is stale together the schedule did not
 * run, and that is one page listing them (2026-10-14: three pages for one missed
 * `*\/5` schedule); the jobs of one scheduled run that started and never
 * finished are one page and, once they finish, one all-clear (2026-10-21: two of
 * each for the stopped 04:00 UTC `*\/15` run). Each job keeps its own claim,
 * cooldown, reminder schedule, paged record and incident: only the post is
 * shared. Two overlapping ticks whose claim object is unreachable can still both
 * post, since every claim then fails open and the KV cooldown is read before it
 * is written; that is #2117's part B, left for a decision.
 *
 * Limitation (unchanged): this lives in the same worker as the crons it watches,
 * so it catches a watched cron going dark while the minute cron still runs.
 * Total worker death would also silence this check -- that case needs an
 * external uptime monitor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MINUTE_ALERT_CLAIM_TTL_SECONDS, claimMinutePage, minuteAlertClaimKey, orgIdsToTell, postMinutePage, slackOrgIds } from './alert-fanout'
import { logReadFailure } from './scheduled-read'
import { scheduledSlackFor } from './scheduled-slack'
import { sendCronHeartbeatAlert, sendCronHeartbeatGroupAlert, sendCronHeartbeatGroupRecoveryAlert, sendCronHeartbeatRecoveryAlert } from './slack'
import { BACKOFF_STEPS_SECONDS, clearCondition, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf, type Recurrence, type StandingCondition } from './alert-backoff'
import { releaseClaimQuietly, type AlertClaims } from './alert-claim'
import { reportRecordError, writeIncidentEvent, type IncidentContext } from './incident-outbox'
import type { IncidentEndReason } from './incident-signals'
import { formatErr } from './format-error'

/** The incident record's signal for this check (incident-signals.ts). */
export const CRON_HEARTBEAT_SIGNAL = 'cron-heartbeat'

const MIN = 60 * 1000
const H = 60 * MIN

export interface CronJob {
  /** Stable id; forms the KV keys. NEVER rename a live one (resets its state). */
  id: string
  /** Human name in the alert header. */
  label: string
  /** The cron expression, echoed in the fix hint. */
  triggerCron: string
  /** Age past which the job is declared dark. Above the cadence, with slack. */
  staleMs: number
  /**
   * How long one run may take before a started stamp with no completion is
   * declared vanished. Below the cadence, or the next run's start would mask it,
   * and below staleMs, or stale would always be reported first.
   */
  maxRunMs: number
  /**
   * For a job that runs every minute: judge it vanished on a DROUGHT of finished
   * runs, this long with none while new runs keep starting, instead of on one
   * run past maxRunMs (#2057). Every minute job shares one invocation that has
   * taken up to 320 s, and each start overwrites the last, so at the next tick a
   * late finish and a kill look the same and a real kill is masked by the next
   * start. A job killed every time still shows as no completion for this long.
   * Also for a sweep inside the ops minute tick (ops-sf-limits, #2336), whose
   * stamps cross a service binding and so can be lost one at a time.
   */
  completionDroughtMs?: number
  /** What stops working while this job is dark (for the alert body). */
  dependents: string
  /**
   * The Worker whose cron this is, when it is not this one (#1949). Absent means
   * this Worker: its trigger is in wrangler.toml and index.ts stamps it. The ops
   * Worker's tick stamps through the OpsGateway entrypoint instead
   * (lib/ops-gateway.ts), and its trigger is in wrangler.ops.toml.
   */
  worker?: 'bidspoke-worker-ops'
  /** The dark alert's fix, when this Worker's generic one names the wrong place. */
  darkFixHint?: string
}

// The daily job keeps id 'daily-1300' so heartbeatKey()/firstSeenKey() reproduce
// the pre-#612 keys byte-for-byte and a live deploy does not lose its state.
export const CRON_JOBS: CronJob[] = [
  {
    id: 'daily-1300',
    label: 'Daily health-check batch',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack.
    staleMs: 26 * H,
    // A dozen parallel checks, each seconds; the slowest measured is the gate.
    maxRunMs: 30 * MIN,
    dependents:
      'volume-anomaly, field-presence, email-drop-rate, secret-drift, required-secrets, big-table-guard, drain-stall, archive-gate, archive-settings, archive-identities, export-schema-drift',
  },
  {
    id: 'timeout-audit',
    label: 'Daily step-timeout audit',
    triggerCron: '17 8 * * *',
    // 24h cadence, 2h slack, matching the other daily job.
    staleMs: 26 * H,
    maxRunMs: 30 * MIN,
    dependents:
      'nothing is checking whether any step timeout is configured below the duration that step actually takes',
  },
  {
    id: 'sightings-export',
    label: 'Lead sightings Snowflake export',
    triggerCron: '37 */2 * * *',
    // 2h cadence, 1h slack -- one skipped run trips it without flapping.
    staleMs: 3 * H,
    // The export's own wall-time budget is 12 minutes.
    maxRunMs: 30 * MIN,
    dependents: 'finalized lead sightings are no longer being exported to Snowflake',
  },
  {
    id: 'execution-archive',
    label: 'Execution archive to Snowflake',
    triggerCron: '23 * * * *',
    // 1h cadence, 1h slack. Registered in the existing registry rather than
    // given its own heartbeat, so absence-of-run alerting comes from the
    // mechanism that already covers every other cron and there is no second
    // list to drift (#871).
    staleMs: 2 * H,
    // The archive caps itself at one hour of CPU per run and a killed run is
    // exactly the case this exists for (2026-08-22), so the allowance is just
    // under the hourly cadence.
    maxRunMs: 50 * MIN,
    dependents:
      'workflow_executions and execution_steps are no longer being copied to Snowflake. An unarchived day is held back from the 7-day purge by the deletion gate until the archive catches up, so nothing is lost yet, but the retained data keeps growing until it does',
  },
  {
    id: 'execution-archive-expiry',
    label: 'Execution archive 13 month expiry',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack, matching the other daily jobs.
    staleMs: 26 * H,
    // It deletes at most ten days per run and each is one statement, so the
    // work is small; the allowance is for Snowflake being slow rather than for
    // the job being long.
    maxRunMs: 30 * MIN,
    dependents:
      'archived executions are no longer being deleted once they pass 13 months, so unredacted SSNs, dates of birth, addresses and credit reports accumulate in Snowflake with no upper bound',
  },
  {
    // The canary's daily read-back (#2173). Removed with it by the phase 6
    // change (#2175): see docs/main-flow-relay-port.md.
    id: 'invalid-state-canary-watch',
    label: 'Main Flow invalid state write report',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack, matching the other daily jobs.
    staleMs: 26 * H,
    // About 19 runs a day, at most two Salesforce reads each, one at a time and
    // each bounded at 12 s; the first unanswered read stops the rest.
    maxRunMs: 30 * MIN,
    dependents:
      "nobody is told each morning whether Main Flow's direct invalid state writes to Salesforce landed, so a lost write shows only when somebody opens the record (#2173)",
  },
  {
    // Money's Salesforce run as identity, measured for ops verify (#2335).
    id: 'money-identity',
    label: 'Money Salesforce identity measurement',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack, matching the other daily jobs.
    staleMs: 26 * H,
    // One credential read, one token (a cache read, a mint at most), one userinfo
    // call bounded at 10 s and one KV write.
    maxRunMs: 30 * MIN,
    dependents:
      'money\'s Salesforce identity is no longer re-measured, so ops verify keeps comparing ops connections against an older reading of it, and refuses every Salesforce connection when it has none (#2335)',
  },
  {
    // The owners of person bound ops connections (#2340, ops-connection-owner-check.ts).
    id: 'ops-connection-owner',
    label: 'Ops connection owner check',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack, matching the other daily jobs.
    staleMs: 26 * H,
    // One paged read of the person bound connections, one of their owners and
    // one of the Access list, then a workflows scan per orphaned connection.
    maxRunMs: 30 * MIN,
    dependents:
      'nobody is told when the person a person bound ops connection signs in as is removed from Bidspoke, so its workflows go on acting as someone who no longer has access (#2340)',
  },
  {
    // The bulkhead limit the ops Salesforce lane was sized against (#2336,
    // salesforce-bulkhead-check.ts).
    id: 'salesforce-bulkhead-check',
    label: 'Salesforce bulkhead limit check',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack, matching the other daily jobs.
    staleMs: 26 * H,
    // One setting read, one Slack organization list read and a post to each.
    maxRunMs: 30 * MIN,
    dependents:
      'nothing notices the bidding Worker\'s Salesforce bulkhead limit moving off the 20 the ops Salesforce lane\'s cap was sized against, so bidding and ops together can ask Salesforce for more calls at once than its org allows (#2336)',
  },
  {
    id: 'partner-reachability',
    label: 'Partner reachability probe',
    triggerCron: '*/5 * * * *',
    // 5 minute cadence, 10 minutes slack: a dark probe is noticed within a
    // quarter of an hour, which is the same window its own control alert uses.
    staleMs: 15 * MIN,
    // Four GETs with a 10s deadline each, in parallel, plus KV and Slack.
    maxRunMs: 2 * MIN,
    dependents:
      'a partner firewall block appearing or lifting is no longer noticed between leads, and no all-clear is posted for a standing block (#1274)',
  },
  {
    id: 'incident-drain',
    label: 'Incident record drain',
    triggerCron: '*/5 * * * *',
    // 5 minute cadence, 10 minutes slack, like the other jobs on this cron.
    staleMs: 15 * MIN,
    // A KV list, a handful of events and open incidents, one database call each.
    maxRunMs: 2 * MIN,
    dependents:
      'alert incidents stop reaching the incident record: they wait in the KV outbox, and an incident whose end was lost is never closed as lapsed (#2100)',
  },
  {
    id: 'database-memory',
    label: 'Database memory check',
    triggerCron: '*/5 * * * *',
    // 5 minute cadence, 10 minutes slack, matching the partner probe on the same cron.
    staleMs: 15 * MIN,
    // One GET with a 10s deadline, a few KV reads and writes, and at most two Slack posts.
    maxRunMs: 2 * MIN,
    dependents:
      'the database running short of memory goes unreported until it stalls, as it did on 2026-10-08 after a week of swapping nobody saw (#1928)',
  },
  {
    id: 'writeback-backlog',
    label: 'Waiting Salesforce writes check',
    triggerCron: '*/5 * * * *',
    // 5 minute cadence, 10 minutes slack, matching the other jobs on this cron.
    staleMs: 15 * MIN,
    // One bounded read of the pending rows, a few KV reads and writes per
    // organization, and at most one Slack post each.
    maxRunMs: 2 * MIN,
    dependents:
      'a Salesforce write that failed after a lead was answered and is stored to be resent can wait for ever with nobody told, however many pile up (#468)',
  },
  {
    id: 'partner-page-monitor',
    label: 'Partners page delivery check',
    triggerCron: '*/5 * * * *',
    // 5 minute cadence, 10 minutes slack, matching the other checks on this cron.
    staleMs: 15 * MIN,
    // A sign in, up to three joins of at most 10 s with 3 s between them, one ping
    // and a 10 s wait for the notice, then a job_runs row and at most one Slack post.
    maxRunMs: 2 * MIN,
    dependents:
      'partners page live updates stopping goes unreported: a person editing a partner stops seeing another person\'s save appear, and nothing says so (#2135)',
  },
  {
    id: 'buyer-sale-drain',
    label: 'Buyer ledger outbox drain',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack: a dark drain is noticed inside the
    // ten minute window its own backlog page (five ticks) would otherwise be
    // the only sign of.
    staleMs: 10 * MIN,
    // One ledger read per buyer plus one rpc per pending entry; a healthy tick
    // is under a second and a backlog of hundreds is still well inside this.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'ledger entries the inline mirror failed to copy never reach buyer_sales, so the partner page, the unresolved list and the sales checks read an incomplete copy while selling continues (#1413)',
  },
  {
    id: 'unconfirmed-write-sweep',
    label: 'Unconfirmed write read back',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack: noticed before the 15 minutes after
    // which the sweep itself would have said it could not confirm a record.
    staleMs: 10 * MIN,
    // One KV list, then at most 50 entries, each a KV read and one read back
    // bounded at 5 s. The first unreadable answer stops the reads, and so does
    // READ_PHASE_BUDGET_MS (30 s) on a database that is slow but answering. That
    // check runs before every entry, so a tick ends at most one read (5 s) and
    // one dead letter (a claim bounded at 2 s, two KV calls, a Slack post) past
    // it, then the could-not-confirm and summary posts: well inside 50 s.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'a write that timed out after a lead was answered is never read back, so one that never landed is never reported as lost and one that landed is never cleared (#1880)',
  },
  {
    id: 'database-reachability',
    label: 'Database reachability probe',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack, matching the other minute jobs. It is
    // also the writer of the saved Slack copy (#2061), so while it is dark the
    // copy grows old and the database page names that age.
    staleMs: 10 * MIN,
    // One read bounded at 5 s, one KV write of the copy, and at most a page or
    // an all-clear per organization.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'the saved Slack copy every outage alert is posted from stops being refreshed, the database probe stops measuring, and the database unreachable all-clear cannot be sent (#2061)',
  },
  {
    id: 'salesforce-read-back',
    label: 'Salesforce read back',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack, matching the database read back.
    staleMs: 10 * MIN,
    // KV lists of the held writes, paged until 200 waiting ones are found or
    // 1000 keys are seen, each classified 25 at a time, then Salesforce calls only until
    // SF_PHASE_BUDGET_MS (20 s), each bounded at SF_CALL_DEADLINE_MS (12 s), so
    // a tick ends at most one call past it, then its alerts: well inside 50 s.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'a Salesforce update cut off after a lead was answered is never read back, so one that did not land is never resent and nobody is told it is missing (#2023)',
  },
  {
    id: 'writeback-drain',
    label: 'Stored Salesforce writes drain',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack: a dark drain is noticed well before the
    // backlog alert's 30 minutes, which would otherwise be the only sign of it.
    staleMs: 10 * MIN,
    // One bounded read of the pending rows, then Salesforce calls only until
    // DRAIN_PHASE_BUDGET_MS (20 s), each bounded at DRAIN_CALL_DEADLINE_MS (12 s),
    // then its alerts: well inside 50 s.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'a Salesforce write stored after it failed with an answer is never resent, and every one waits for a person to replay it by hand (#468)',
  },
  {
    // The minute job that judges the ops tick's kept report (#2519,
    // ops-gateway.ts runOpsTickReportCheck). Its own entry rather than folded
    // under another minute job, so a dark one names itself and its remedy: the
    // ops-tick entry watches whether the tick runs, this whether its problems
    // are delivered, and either can stop while the other goes on (L71).
    id: 'ops-tick-report',
    label: 'Ops minute cron report check',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack, matching the other minute jobs of this
    // Worker. No first fire allowance: it rides this Worker's existing minute
    // trigger, which a deploy does not re-add.
    staleMs: 10 * MIN,
    // One KV read of the kept report, then at most one page or one stand down
    // through the export alerter: seconds.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'a problem the ops minute cron reports, or an ops Worker that is not configured, is never paged, though the tick itself goes on running and stamping its own heartbeat (#2519)',
  },
  {
    // The minute job that pages the ops connection logins the tick's report
    // carries (#2519, ops-connection-logins.ts). Its own entry for the same
    // reason as ops-tick-report: it reads the same report but pages a different
    // signal, to each connection's own organization.
    id: 'ops-connection-logins',
    label: 'Ops connection login pages',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack, matching the other minute jobs.
    staleMs: 10 * MIN,
    // One KV read of the report and one of its open incidents, then per due
    // login a name read bounded at 10 s and one Slack post. Judged by the
    // drought below, never by one run.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'an ops connection whose login needs a person (needs_reauth, or refresh_failing past its bound) is never paged, and an open one never gets its all clear, though the ops tick still judges the logins every minute (#2519)',
  },
  {
    // The third report job (#2340, phase 10 item 4), watched for the same
    // reason as ops-connection-logins: it reads the write backs the tick
    // reports and pages each to the connection's own organization.
    id: 'ops-connection-write-backs',
    label: 'Ops connection write back pages',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack, matching the other minute jobs.
    staleMs: 10 * MIN,
    // One KV read of the judgement and one of its open incidents, then per due
    // write back a name read and one Slack post. Judged by the drought below.
    maxRunMs: 50 * 1000,
    completionDroughtMs: 10 * MIN,
    dependents:
      'a new ops login the ops Worker holds and Bidspoke has not saved is never paged, and an open one never gets its all clear, though the ops tick still finds it with the connection check (#2340)',
  },
  {
    id: 'buyer-sales-checks',
    label: 'Buyer sales checks',
    triggerCron: '*/15 * * * *',
    // 15 minute cadence, half an hour slack: two missed runs before it is dark.
    staleMs: 45 * MIN,
    // A handful of ledger reads and table reads per buyer plus one Salesforce
    // query; minutes at most even with several buyers.
    maxRunMs: 10 * MIN,
    dependents:
      'nothing is comparing the buyer ledgers against buyer_sales, the bid rows and the Salesforce write back, nobody is paged for sales waiting on a person, and a buyer failing or declining every lead goes unnoticed (#1413)',
  },
  {
    // BRIDGE (#2392): removed with tripoint-ping-outcome-rate.ts in the #1414 change.
    id: 'tripoint-ping-outcome-rate',
    label: 'Tripoint outcome rate on tripoint_ping',
    triggerCron: '*/15 * * * *',
    // 15 minute cadence, half an hour slack: two missed runs before it is dark.
    staleMs: 45 * MIN,
    // At most 16 head counts of an hour of steps and a few hundred KV reads;
    // seconds when the rows are warm.
    maxRunMs: 10 * MIN,
    dependents:
      "nothing notices Tripoint failing or declining an unusual share of the Engine leads the tripoint_ping step sends it, which is what went unseen on 2026-10-14 (#2392)",
  },
  {
    id: 'click-path-checks',
    label: 'Click buyer path checks',
    triggerCron: '*/15 * * * *',
    // 15 minute cadence, half an hour slack: two missed runs before it is dark.
    staleMs: 45 * MIN,
    // A few step reads per click buyer, one counter read of three days and, once
    // a day, one bounded Salesforce query; minutes at most.
    maxRunMs: 10 * MIN,
    dependents:
      'nothing notices a click buyer check that cannot answer, a click buyer path gone quiet in its selling hours, a burst of refused clicks, or a day whose click count disagrees with Salesforce (#1546)',
  },
  {
    id: 'buyer-select-parity',
    label: 'Buyer select parity refresh',
    triggerCron: '0 * * * *',
    // 1h cadence, 1h slack, matching the other hourly jobs.
    staleMs: 2 * H,
    // Reads two days of steps in three hour windows per workflow; minutes.
    maxRunMs: 20 * MIN,
    dependents:
      'the buyer_select_parity_days rows the Stage A exit criteria are read from stop being refreshed, so a day can pass out of the execution_steps retention window without being summarised (#1413)',
  },
  {
    id: 'live-share-refusals',
    label: 'Live share refusal check',
    triggerCron: '0 * * * *',
    // 1h cadence, 1h slack, matching the other hourly jobs.
    staleMs: 2 * H,
    // One six hour step read per live buyer_select step on a normal hour, up
    // to eight during a refusing run; seconds.
    maxRunMs: 10 * MIN,
    dependents:
      'a buyer_select live share that refuses every lead (a buyer profile rule its step cannot read, say) sells nothing and pages nobody, as for 45 hours from 2026-10-13 (#2149)',
  },
  {
    // The ops Worker's minute cron (#1949), watched from here because the
    // watchdog must not depend on the Worker it watches (L71). Its stamps arrive
    // through the OpsGateway entrypoint (lib/ops-gateway.ts); a tick that cannot
    // reach the gateway stamps nothing and reads as dark, which it is to anyone
    // relying on it.
    id: 'ops-tick',
    label: 'Ops minute cron',
    triggerCron: '* * * * *',
    worker: 'bidspoke-worker-ops',
    // Not the 10 minutes of the other minute jobs: a newly added cron first fires
    // about 16 minutes after the deploy that adds it (spike #1946, measured
    // 2026-10-16), so 10 would page "never ran" on every deploy that adds it.
    staleMs: 25 * MIN,
    // One tick in observe mode is seconds. Judged by the drought below, as every
    // minute job is (#2057), never by one run.
    maxRunMs: 50 * 1000,
    // Past the 15 minute wall a tick can legitimately run for (spike P1), so a
    // long tick is never read as a killed one.
    completionDroughtMs: 20 * MIN,
    dependents:
      'ported ops workflows are not scheduled: nothing works out which of their slots are due, records them or reports a missed one, and the run engine\'s lease and expiry sweeps stop (#1949)',
    // Workers Logs lose about 8% of the tick's lines (measured 2026-10-20,
    // #2347), so the hint says a gap in them is not a missed tick. How to count
    // ticks exactly: docs/ops-ceilings-spike.md, "Counting ticks".
    darkFixHint:
      'confirm bidspoke-worker-ops deployed with its minute trigger (wrangler.ops.toml `[triggers]`, and the Deploy Ops Worker job checks the deploy listed it), that its logs show `ops_tick` lines, and that its OPS_GATEWAY binding reaches this Worker, since the tick stamps its heartbeat through it. When reading those logs, remember that a few percent of its log lines are always missing, so a gap in the logs is not a missed tick: look for the lines stopping altogether.',
  },
  {
    // The sf_limits sweep inside the ops minute tick (#2336, ops/sf-limits.ts),
    // watched here as the tick is (L71). It stamps through the OpsGateway's
    // opsJobStarted and opsJobCompleted (lib/ops-gateway.ts, #2340) each time it
    // owns its claim, every 4 to 5 minutes. Its trigger is the tick's: a sweep
    // rides the one ops minute cron and has none of its own.
    id: 'ops-sf-limits',
    label: 'Ops Salesforce limits reading',
    triggerCron: '* * * * *',
    worker: 'bidspoke-worker-ops',
    // The tick's own 25 minutes plus one sweep interval with a missed tick (5),
    // so a tick that is dark pages as ops-tick first, with the tick's remedy,
    // and a sweep that stopped while the tick runs pages as itself. The tick's
    // logs once read as a seventh to a third fewer runs than a minute cron
    // should make (308 distinct ticks in 360 minutes on 2026-10-19), but #2347
    // measured the tick running in every minute of a day: Workers Logs lose
    // lines, not ticks (docs/ops-ceilings-spike.md, "Counting ticks"). A tick
    // that does skip a minute moves one sweep by a minute or two, far inside
    // this. Past it the org's reading is long stale (15 minutes), and every ops
    // Salesforce call to it is refused sf_budget_unmeasured, which the sweep's
    // own problems report before this does.
    staleMs: 30 * MIN,
    // One sweep is one read of the measured orgs and one /limits read each,
    // each bounded at 45 s (SF_LIMITS_ORG_DEADLINE_MS), all at once. Below the
    // minute trigger it rides, as every minute job's must be; judged by the
    // drought below, never by one run.
    maxRunMs: 50 * 1000,
    // Three sweeps in a row with no completion while starts go on, so one
    // completion stamp the gateway missed is never read as a killed sweep.
    completionDroughtMs: 15 * MIN,
    dependents:
      'the ops Salesforce pool\'s budget readings are renewed only while ops happens to be calling each org, so an org ops has not called for 15 minutes refuses its next ops Salesforce call as sf_budget_unmeasured (#2336)',
    darkFixHint:
      'confirm the ops-tick heartbeat is healthy first (this sweep runs inside it), then search the bidspoke-worker-ops logs for ops_tick lines with sf_limits counts or problems, and check claim_ops_sweep\'s ops_lane_sweeps row for sf_limits in the ops database: a sweep that claims but never stamps reaches this Worker through the same OPS_GATEWAY binding as the tick.',
  },
  {
    // The connection_check sweep inside the ops minute tick (#2340,
    // ops/connection-check.ts), watched here as the tick is (L71). It stamps
    // through the OpsGateway's opsJobStarted and opsJobCompleted each time it
    // owns its claim, every 14 to 15 minutes (16 with a missed tick). Its trigger
    // is the tick's: a sweep rides the one ops minute cron and has none of its own.
    id: 'ops-connection-check',
    label: 'Ops connection check',
    triggerCron: '* * * * *',
    worker: 'bidspoke-worker-ops',
    // The tick's own 25 minutes plus one sweep interval with a missed tick (16)
    // is 41, so a tick that is dark pages as ops-tick first, with the tick's
    // remedy. Rounded up to 50 so it also outlasts the completion drought below:
    // a sweep that starts and never finishes pages as vanished, with its own
    // remedy, before it can read as stale.
    staleMs: 50 * MIN,
    // One sweep is its started stamp, one read of the connections, one check
    // each (bounded at 30 s, CONNECTION_CHECK_DEADLINE_MS, the connections of
    // one Salesforce org one after another and the rest at once), and its
    // completed stamp (15 s at most). No check starts once 10 s have passed
    // since the sweep began (CONNECTION_CHECK_START_BUDGET_MS), so the whole
    // sweep, stamps and read included, takes at most 55 s, below the minute
    // trigger it rides, as every minute job's must be. Judged by the drought
    // below, never by one run.
    maxRunMs: 55 * 1000,
    // Three sweeps in a row at their usual 15 minute spacing with no completion
    // while starts go on, so a completion stamp or two the gateway missed is
    // never read as a killed sweep.
    completionDroughtMs: 45 * MIN,
    dependents:
      'no ops connection\'s login is proved between workflow runs, so a credential that was revoked or expired is found only when an ops workflow step fails on it (#2340); the login states of the connections are still read and paged every minute by the tick',
    darkFixHint:
      'confirm the ops-tick heartbeat is healthy first (this sweep runs inside it), then search the bidspoke-worker-ops logs for ops_tick lines with connection_check counts or problems, and check claim_ops_sweep\'s ops_lane_sweeps row for connection_check in the ops database: a sweep that claims but never stamps reaches this Worker through the same OPS_GATEWAY binding as the tick.',
  },
  {
    id: 'engine-script-drift',
    label: 'Engine script drift check',
    triggerCron: '0 * * * *',
    // 1h cadence, 1h slack, matching the other hourly jobs.
    staleMs: 2 * H,
    // One GitHub read of the mirror file and three string comparisons.
    maxRunMs: 2 * MIN,
    dependents:
      'a code node on the Engine Bidding Workflow can be edited without the kept copy in apps/worker/src/engine/scripts/engine-bidding noticing, so the script tests prove a script that no longer runs, and a paste is confirmed by nothing (#1472)',
  },
]

export function cronJob(id: string): CronJob {
  const job = CRON_JOBS.find((j) => j.id === id)
  if (!job) throw new Error(`unknown cron job: ${id}`)
  return job
}

export const heartbeatKey = (id: string) => `cron-heartbeat:${id}`
export const completedKey = (id: string) => `cron-heartbeat:${id}:completed`
/** When the check first looked for this job's completed stamp and found none. */
export const completedWatchKey = (id: string) => `cron-heartbeat:${id}:completed-watch`
export const firstSeenKey = (id: string) => `cron-heartbeat:${id}:first-seen`
/** The status a standing incident was first paged with, and when (#2057). */
export const alertedStatusKey = (id: string) => `cron-heartbeat:${id}:alerted-status`

/**
 * How long the paged status record lives unrenewed (#2103 review). It is the
 * incident record's marker, and it is deleted only on the healthy side, which
 * reads it only while the backoff condition is readable: a condition that
 * expired or is corrupt, or a job removed from CRON_JOBS, would otherwise leave
 * it, and an "ongoing" incident, for ever. Every page round and every check that
 * still finds the job dark renews it, so a job dark for weeks keeps its
 * incident; only a record nothing renews expires, and the drain then closes its
 * incident as lapsed. Twice the longest reminder gap, so even with every quiet
 * renewal lost (the minute cron itself down) a whole reminder gap of margin
 * remains before a still-dark job's incident could lapse.
 */
export const ALERTED_STATUS_TTL_SECONDS = 2 * Math.max(...BACKOFF_STEPS_SECONDS)
/** A quiet check renews the record at most this often: one write an hour per dark job, not one a minute. */
const ALERTED_STATUS_RENEW_MS = 60 * MIN

/**
 * Tries an all-clear gets before it stands down without some org (#2057 review).
 * A Slack connection that keeps refusing (a revoked token, a missing channel)
 * must not hold the incident open for ever, posting again to everyone else.
 */
export const ALL_CLEAR_MAX_ATTEMPTS = 10

interface AlertedStatus {
  status: HeartbeatStatus
  /** When it was paged. */
  at: string
  /** The start stamp the page was about, so an all-clear can tell that run from a later one. */
  startedAt: string | null
  /** A completion after this is what shows the job finished again. */
  since: string | null
  /** Orgs that already have the all-clear, so a retry reaches only the rest. */
  deliveredTo: string[]
  /** All-clear rounds tried so far. */
  attempts: number
  /**
   * When the incident was first paged (#2103), kept across a page with a new
   * status, which rewrites `at`. The incident record's start, and what the
   * drain reads to tell this incident's marker from a later one's. A record
   * written before it existed has none, and its `at` stands in.
   */
  incidentStartedAt?: string
  /** When the record's expiry was last renewed, so a quiet check renews it at most hourly. */
  renewedAt?: string
  /**
   * The grouped page this job was paged in (#2117), DarkGroup.key, so the
   * all-clears of one stopped run go out as one too. Absent for a job paged on
   * its own.
   */
  group?: string
  /** Every job that grouped page named, this one included. */
  groupJobs?: string[]
}

function parseAlertedStatus(raw: string | null): AlertedStatus | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof AlertedStatus, unknown>>
    if (typeof v.status !== 'string' || typeof v.at !== 'string') return null
    return {
      status: v.status as HeartbeatStatus,
      at: v.at,
      startedAt: typeof v.startedAt === 'string' ? v.startedAt : null,
      since: typeof v.since === 'string' ? v.since : null,
      deliveredTo: Array.isArray(v.deliveredTo) ? v.deliveredTo.filter((x): x is string => typeof x === 'string') : [],
      attempts: typeof v.attempts === 'number' && Number.isFinite(v.attempts) ? v.attempts : 0,
      ...(typeof v.incidentStartedAt === 'string' ? { incidentStartedAt: v.incidentStartedAt } : {}),
      ...(typeof v.renewedAt === 'string' ? { renewedAt: v.renewedAt } : {}),
      ...(typeof v.group === 'string' ? { group: v.group } : {}),
      ...(Array.isArray(v.groupJobs) ? { groupJobs: v.groupJobs.filter((x): x is string => typeof x === 'string') } : {}),
    }
  } catch {
    return null
  }
}
/**
 * The key the backoff records this job's standing condition under. The condition
 * and cooldown keys hang off it, so one job's reminder schedule is one subtree.
 */
export const backoffKey = (id: string) => `cron-heartbeat:${id}`

export type HeartbeatStatus = 'healthy' | 'stale' | 'never_ran' | 'pending' | 'vanished' | 'unstamped'

export interface HeartbeatVerdict {
  status: HeartbeatStatus
  ageMs: number | null
}

/**
 * Pure freshness decision.
 * - started present and strictly older than staleMs: stale (the trigger stopped
 *   firing; that remedy takes precedence over anything about the last run).
 * - for a minute job (completionDroughtMs set, #2057): vanished when no run has
 *   completed for the whole drought, measured from the last completion or from
 *   when completions began being watched, and that watch is itself older than
 *   the drought. Its age is then how long nothing has finished.
 * - otherwise, started present, no completion at or after it, the run is past
 *   its allowance, and it started at or after completions were being watched
 *   for: vanished (the run was killed or is hung).
 * - started present otherwise: healthy (completed, still inside its allowance,
 *   or begun before anything could have recorded its completion).
 * - started absent: never_ran if it was first seen longer ago than staleMs,
 *   otherwise pending (fresh deploy grace, or nothing recorded yet).
 * The completion, allowance, watch and drought arguments are optional so the
 * four-argument form keeps its meaning for callers that have no completed stamp.
 */
export function evaluateHeartbeat(
  lastRan: string | null,
  firstSeen: string | null,
  nowMs: number,
  staleMs: number,
  lastCompleted: string | null = null,
  maxRunMs: number | null = null,
  watchingSince: string | null = null,
  completionDroughtMs: number | null = null,
): HeartbeatVerdict {
  if (lastRan) {
    const startedMs = Date.parse(lastRan)
    const ageMs = nowMs - startedMs
    if (ageMs > staleMs) return { status: 'stale', ageMs }
    if (completionDroughtMs !== null) {
      // A minute job (#2057): vanished only when nothing has finished for the
      // whole drought, measured from the last completion, or from when the check
      // began watching if there has never been one.
      const watchingMs = watchingSince ? Date.parse(watchingSince) : NaN
      if (!Number.isFinite(watchingMs) || nowMs - watchingMs <= completionDroughtMs) return { status: 'healthy', ageMs }
      const completedMs = lastCompleted ? Date.parse(lastCompleted) : NaN
      const quietSince = Number.isFinite(completedMs) ? completedMs : watchingMs
      const quietMs = nowMs - quietSince
      return quietMs > completionDroughtMs ? { status: 'vanished', ageMs: quietMs } : { status: 'healthy', ageMs }
    }
    if (maxRunMs !== null && ageMs > maxRunMs) {
      const completedMs = lastCompleted ? Date.parse(lastCompleted) : NaN
      const finished = Number.isFinite(completedMs) && completedMs >= startedMs
      const watchingMs = watchingSince ? Date.parse(watchingSince) : NaN
      const judged = Number.isFinite(watchingMs) && startedMs >= watchingMs
      if (!finished && judged) return { status: 'vanished', ageMs }
    }
    return { status: 'healthy', ageMs }
  }
  if (firstSeen) {
    const ageMs = nowMs - Date.parse(firstSeen)
    return { status: ageMs > staleMs ? 'never_ran' : 'pending', ageMs }
  }
  return { status: 'pending', ageMs: null }
}

/** Called by a watched cron when it dispatches, to stamp "started". */
export async function writeHeartbeat(
  kv: KVNamespace,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await kv.put(heartbeatKey(jobId), new Date(nowMs).toISOString())
}

/**
 * Called by a watched cron once its work has SETTLED, success or handled failure
 * alike, to stamp "completed". A failure the job caught and alerted is a finished
 * run; only a run the platform killed or that hung never writes this (#985).
 */
export async function writeHeartbeatCompleted(
  kv: KVNamespace,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await kv.put(completedKey(jobId), new Date(nowMs).toISOString())
}

export interface HeartbeatCheckResult {
  jobId: string
  status: HeartbeatStatus
  alerted: boolean
  ageMs: number | null
  /** Incident record writes that failed this pass (#2103). The alert went ahead regardless. */
  recordErrors: string[]
}

/** The incident record's start for a paged status record. */
const incidentStartOf = (r: AlertedStatus): string => r.incidentStartedAt ?? r.at

/** Write the paged status record with a fresh expiry. */
async function writeAlertedStatus(kv: KVNamespace, id: string, record: AlertedStatus, nowMs: number): Promise<void> {
  const renewed: AlertedStatus = { ...record, renewedAt: new Date(nowMs).toISOString() }
  await kv.put(alertedStatusKey(id), JSON.stringify(renewed), { expirationTtl: ALERTED_STATUS_TTL_SECONDS })
}

/** Renew the record's expiry when it was last renewed an hour or more ago (or never). */
async function renewAlertedStatusIfDue(kv: KVNamespace, id: string, record: AlertedStatus, nowMs: number): Promise<void> {
  const renewedMs = record.renewedAt ? Date.parse(record.renewedAt) : NaN
  // An unreadable stamp renews, the side that keeps a dark job's incident open (L50).
  if (Number.isFinite(renewedMs) && nowMs - renewedMs < ALERTED_STATUS_RENEW_MS) return
  await writeAlertedStatus(kv, id, record, nowMs)
}

/**
 * When this job last FINISHED a run according to `job_runs`, or null when there
 * is no evidence either way (#1332).
 *
 * This is the second, independent record that a scheduled job ran: `withJobRun`
 * writes a row with a start, a finish and an outcome, and unlike the KV stamp it
 * is written by the job's own work rather than by a line at the dispatch site.
 * So the two can disagree, and when they do the database is the one that saw the
 * work. On 2026-09-11 they disagreed for two days and nothing looked.
 *
 * NULL MEANS NO EVIDENCE, NEVER "IT DID NOT RUN". Most watched jobs do not use
 * `withJobRun` at all, and a failed read answers the same way, so an empty
 * result may only ever leave the original verdict standing (L98, L345). It is
 * therefore consulted ONLY to WITHDRAW an accusation, never to make one.
 */
export async function lastFinishedRun(supabase: SupabaseClient, jobId: string): Promise<string | null> {
  try {
    const query = supabase
      .from('job_runs')
      .select('finished_at')
      .eq('job', jobId)
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
    // On the scheduled client (#2061): one read under the tick's bounded deadline,
    // and none once the tick has seen the database fail. Unbounded, a stalled
    // database held this read past the 50 s minute deadline (45 s and the
    // library's retries), so the heartbeat page, which needs only KV, was cut
    // off with its job. Found by the outage simulation.
    const scheduled = scheduledSlackFor(supabase)
    let data: unknown
    if (scheduled) {
      // Aside: a fault in job_runs alone is not a database outage (lessons review of #2250).
      const read = await scheduled.readAside(query)
      if (read.kind === 'failed') {
        // A read skipped because the tick already saw the database fail was
        // logged once, at that failure, by scheduled-slack.ts.
        if (read.how !== 'skipped') console.error(`[cron-heartbeat] job_runs for ${jobId} not read (${read.how}: ${read.detail}), so the verdict stands without it`)
        return null
      }
      data = read.data
    } else {
      const res = await query
      if (res.error) {
        logReadFailure('cron-heartbeat', `job_runs for ${jobId}`, res.error)
        return null
      }
      data = res.data
    }
    const finished = (data as { finished_at?: unknown }[] | null | undefined)?.[0]?.finished_at
    return typeof finished === 'string' ? finished : null
  } catch (e) {
    console.error(`[cron-heartbeat] job_runs read for ${jobId} threw:`, e)
    return null
  }
}

/** What one look at a job's stamps found, before anything is posted (#2117). */
interface JobLook {
  job: CronJob
  lastRan: string | null
  firstSeen: string | null
  lastCompleted: string | null
  watchingSince: string
  verdict: HeartbeatVerdict
  /** The status acted on: the verdict, or unstamped for a dark job `job_runs` shows finishing runs (#1332). */
  status: HeartbeatStatus
}

/**
 * Read one job's stamps and judge them. Every job is looked at before any is
 * posted about, so jobs dark for one reason can be told apart from a job dark
 * on its own (#2117).
 */
async function lookAt(supabase: SupabaseClient, kv: KVNamespace, job: CronJob, nowMs: number): Promise<JobLook> {
  const lastRan = await kv.get(heartbeatKey(job.id))
  const firstSeen = await kv.get(firstSeenKey(job.id))
  const lastCompleted = await kv.get(completedKey(job.id))
  let watchingSince = await kv.get(completedWatchKey(job.id))
  if (!watchingSince) {
    // First look for this job's completions: runs already under way are not
    // judged against a stamp nothing was writing when they began (#1207).
    watchingSince = new Date(nowMs).toISOString()
    await kv.put(completedWatchKey(job.id), watchingSince)
  }
  const verdict = evaluateHeartbeat(
    lastRan, firstSeen, nowMs, job.staleMs, lastCompleted, job.maxRunMs, watchingSince, job.completionDroughtMs ?? null,
  )
  // Before accusing a job of being dark, ask the one source that would know
  // otherwise (#1332). A job that is demonstrably finishing runs while its stamp
  // is absent has a different problem, with a different remedy, and saying "it
  // has never run" about it is simply false (L11).
  let status = verdict.status
  if (status === 'stale' || status === 'never_ran') {
    const finished = await lastFinishedRun(supabase, job.id)
    const finishedMs = finished ? Date.parse(finished) : NaN
    if (Number.isFinite(finishedMs) && nowMs - finishedMs <= job.staleMs) status = 'unstamped'
  }
  return { job, lastRan, firstSeen, lastCompleted, watchingSince, verdict, status }
}

/**
 * The scheduled time a run that started at `atMs` belongs to: the latest minute
 * at or before it on which the cron expression fires (#2117). Cloudflare starts
 * a run late (the 04:00 UTC `*\/15` run of 2026-10-21 started at 04:00:51), so
 * the start alone does not name the run, while every job one invocation starts
 * floors to the same minute. Reads only the shapes CRON_JOBS uses: `*`, a number
 * or `*\/N` in the minute and hour fields and `*` in the rest. Anything else, or
 * an unreadable time, is null, and the caller then judges the job on its own
 * rather than guess which run it was.
 */
export function scheduledSlot(cron: string, atMs: number): number | null {
  if (!Number.isFinite(atMs)) return null
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, ...rest] = parts
  if (rest.some((f) => f !== '*')) return null
  const field = (f: string, max: number): ((v: number) => boolean) | null => {
    if (f === '*') return () => true
    if (/^\d+$/.test(f)) {
      const n = Number(f)
      return n <= max ? (v) => v === n : null
    }
    const step = /^\*\/(\d+)$/.exec(f)
    if (!step) return null
    const n = Number(step[1])
    return n >= 1 && n <= max ? (v) => v % n === 0 : null
  }
  const minuteFires = field(minute, 59)
  const hourFires = field(hour, 23)
  if (!minuteFires || !hourFires) return null
  // These shapes fire at least once a day, so the run is at most a day back.
  const first = Math.floor(atMs / MIN) * MIN
  for (let t = first; t > first - 24 * H; t -= MIN) {
    const at = new Date(t)
    if (minuteFires(at.getUTCMinutes()) && hourFires(at.getUTCHours())) return t
  }
  return null
}

/** A schedule: one cron expression on one Worker. */
const scheduleOf = (job: CronJob): string => `${job.worker ?? 'bidspoke-worker'} ${job.triggerCron}`

/**
 * Watched jobs that went dark for one reason, paged as one (#2117).
 *
 * stale: every watched job on one schedule is stale together, so the schedule
 * did not run, and saying so once per job sent three pages for one missed tick
 * on 2026-10-14. A job not yet watched (pending, a fresh deploy) says nothing
 * either way and does not keep the rest apart.
 *
 * vanished: the jobs of one scheduled run that started and never finished, as
 * the 04:00 UTC `*\/15` run of 2026-10-21 left two. A minute job is judged on a
 * drought of finished runs rather than on one run (#2057), so it has no run to
 * share and is paged on its own.
 */
export interface DarkGroup {
  status: 'stale' | 'vanished'
  /** The schedule, and for an unfinished run the run, recorded on each member's paged record. */
  key: string
  triggerCron: string
  worker?: 'bidspoke-worker-ops'
  /** stale: the latest start of any member. vanished: the run's scheduled time. */
  runAt: string | null
  jobIds: string[]
}

export function darkGroupsOf(looks: readonly Pick<JobLook, 'job' | 'status' | 'lastRan'>[]): DarkGroup[] {
  const bySchedule = new Map<string, Pick<JobLook, 'job' | 'status' | 'lastRan'>[]>()
  for (const look of looks) bySchedule.set(scheduleOf(look.job), [...(bySchedule.get(scheduleOf(look.job)) ?? []), look])
  const groups: DarkGroup[] = []
  for (const [schedule, members] of bySchedule) {
    const { triggerCron, worker } = members[0].job
    const where = { triggerCron, ...(worker ? { worker } : {}) }
    const watched = members.filter((m) => m.status !== 'pending')
    if (watched.length >= 2 && watched.every((m) => m.status === 'stale')) {
      const starts = watched.map((m) => (m.lastRan ? Date.parse(m.lastRan) : NaN)).filter((ms) => Number.isFinite(ms))
      const runAt = starts.length ? new Date(Math.max(...starts)).toISOString() : null
      groups.push({ status: 'stale', key: `stale ${schedule}`, ...where, runAt, jobIds: watched.map((m) => m.job.id) })
      continue
    }
    const byRun = new Map<number, string[]>()
    for (const m of members) {
      if (m.status !== 'vanished' || m.job.completionDroughtMs || !m.lastRan) continue
      const slot = scheduledSlot(triggerCron, Date.parse(m.lastRan))
      if (slot !== null) byRun.set(slot, [...(byRun.get(slot) ?? []), m.job.id])
    }
    for (const [slot, jobIds] of byRun) {
      if (jobIds.length < 2) continue
      const runAt = new Date(slot).toISOString()
      groups.push({ status: 'vanished', key: `vanished ${schedule} ${runAt}`, ...where, runAt, jobIds })
    }
  }
  return groups
}

/** One job's part of a pass: what was found, its incident context, and the result it reports. */
interface JobCheck {
  look: JobLook
  /** The pass's one clock reading. */
  nowMs: number
  incident: IncidentContext
  recordErrors: string[]
  result(status: HeartbeatStatus, alerted: boolean): HeartbeatCheckResult
  /** The incident is still open: keep its marker from expiring. Never in the way of the check. */
  keepOpen(known?: AlertedStatus | null): Promise<void>
}

function jobCheck(kv: KVNamespace, look: JobLook, nowMs: number): JobCheck {
  const { job } = look
  const recordErrors: string[] = []
  const incident: IncidentContext = {
    scope: { kind: 'platform' },
    subjectLabel: job.label,
    onRecordError: (message) => recordErrors.push(message),
  }
  return {
    look,
    nowMs,
    incident,
    recordErrors,
    result: (status, alerted) => ({ jobId: job.id, status, alerted, ageMs: look.verdict.ageMs, recordErrors }),
    keepOpen: async (known) => {
      try {
        const record = known !== undefined ? known : parseAlertedStatus(await kv.get(alertedStatusKey(job.id)))
        if (record) await renewAlertedStatusIfDue(kv, job.id, record, nowMs)
      } catch (e) {
        reportRecordError(incident, `${CRON_HEARTBEAT_SIGNAL} ${job.id}: the paged status record could not be renewed: ${formatErr(e)}`)
      }
    },
  }
}

/** The page half of a dark job's check, apart from the post so several jobs can share one (#2117). */
interface DarkPage {
  check: JobCheck
  claimKey: string
  /** Reads the standing condition and the cooldown; the last reading is the one acted on (L157). */
  inCooldown: () => Promise<boolean>
  /** The standing condition when this page is a reminder, and whether it is word for word the last. */
  reminder: () => { standing: StandingCondition; unchanged: boolean } | null
  /** After the post: on a delivery arm the next interval and record the incident, otherwise keep it open. */
  settle: (alerted: boolean, group: DarkGroup | null) => Promise<void>
}

async function darkPageOf(kv: KVNamespace, check: JobCheck, nowMs: number): Promise<DarkPage> {
  const { job, status, lastRan, lastCompleted, watchingSince } = check.look
  const { incident } = check
  const key = backoffKey(job.id)
  // Alert once per interval, and the interval GROWS while the condition stands.
  // The record is keyed on the job, while the header and the fix depend on the
  // status, so the status is what the alert is about (#1768): one not posted
  // while the condition stood is a new condition, posted at once, never "still".
  // Each status can do that once per stretch, so a status that flaps between two
  // values cannot post every minute.
  const print = await fingerprintAlert({ title: job.id, findings: [status] })
  let judged: { standing: StandingCondition | null; recurrence: Recurrence } = { standing: null, recurrence: recurrenceOf(null, print) }
  const reminder = () => (judged.recurrence.kind === 'reminder' ? judged.recurrence : null)
  return {
    check,
    claimKey: minuteAlertClaimKey('page', CRON_HEARTBEAT_SIGNAL, job.id),
    inCooldown: async () => {
      const standing = await readCondition(kv, key)
      judged = { standing, recurrence: recurrenceOf(standing, print) }
      const different = judged.recurrence.kind === 'new' && standing !== null
      return !different && (await inCooldown(kv, key))
    },
    reminder: () => {
      const r = reminder()
      return r ? { standing: r.standing, unchanged: r.unchanged } : null
    },
    settle: async (alerted, group) => {
      // Only arm the next interval once something actually delivered, so a Slack
      // outage does not silence the condition for a day.
      if (!alerted) {
        // A page nobody received: the job is still dark, so its incident stays open.
        await check.keepOpen()
        return
      }
      const { standing } = judged
      const reminderOf = reminder()?.standing ?? null
      await recordAlert(kv, key, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
      // The incident this page belongs to, if one is open: read only on a delivered
      // page, which is rare. A failed read loses the record's continuity, never the page.
      let open: AlertedStatus | null = null
      try {
        open = parseAlertedStatus(await kv.get(alertedStatusKey(job.id)))
      } catch (e) {
        reportRecordError(incident, `paged ${CRON_HEARTBEAT_SIGNAL} ${job.id} not recorded: the paged status record could not be read: ${formatErr(e)}`)
      }
      let startedAt = open ? incidentStartOf(open) : null
      // Which status was paged, and when, so the healthy side knows an all-clear is owed (#2057).
      if (reminderOf === null) {
        const since = job.completionDroughtMs ? (lastCompleted ?? watchingSince) : lastRan
        const at = new Date(nowMs).toISOString()
        // A new status while the condition stands is the same incident paged again: the start is kept.
        startedAt = startedAt ?? at
        const record: AlertedStatus = {
          status, at, startedAt: lastRan, since, deliveredTo: [], attempts: 0, incidentStartedAt: startedAt,
          // Paged with others (#2117): its all-clear goes out with theirs.
          ...(group ? { group: group.key, groupJobs: group.jobIds } : {}),
        }
        await writeAlertedStatus(kv, job.id, record, nowMs)
        if (open === null) {
          await writeIncidentEvent(kv, { type: 'opened', signal: CRON_HEARTBEAT_SIGNAL, subject: job.id, startedAt }, incident, nowMs)
        }
      }
      // A reminder page round renews the open incident's marker, whenever it was last renewed.
      if (reminderOf !== null && open !== null) {
        try {
          await writeAlertedStatus(kv, job.id, open, nowMs)
        } catch (e) {
          reportRecordError(incident, `${CRON_HEARTBEAT_SIGNAL} ${job.id}: the paged status record could not be renewed: ${formatErr(e)}`)
        }
      }
      // One page per delivered round, about the open incident. A reminder with no
      // paged status record (a condition standing from before #2057) has no
      // incident to count it against.
      if (startedAt !== null) {
        await writeIncidentEvent(kv, { type: 'paged', signal: CRON_HEARTBEAT_SIGNAL, subject: job.id, startedAt }, incident, nowMs)
      } else {
        reportRecordError(incident, `paged ${CRON_HEARTBEAT_SIGNAL} ${job.id} not recorded: no open incident to page about`)
      }
    },
  }
}

/** Page one dark job on its own: claim, then read the cooldown, then post (#2062, L157). */
async function pageOne(
  supabase: SupabaseClient,
  kv: KVNamespace,
  check: JobCheck,
  nowMs: number,
  orgIds: string[],
  claims: AlertClaims | undefined,
): Promise<HeartbeatCheckResult> {
  const { job, status, verdict } = check.look
  const page = await darkPageOf(kv, check, nowMs)
  let alerted = false
  const outcome = await postMinutePage({
    claims,
    key: page.claimKey,
    inCooldown: page.inCooldown,
    send: async () => {
      const r = page.reminder()
      for (const orgId of orgIds) {
        if (await sendCronHeartbeatAlert(supabase, orgId, job, status as 'stale' | 'never_ran' | 'vanished' | 'unstamped', verdict.ageMs, r?.standing ?? null, nowMs, r?.unchanged ?? false)) alerted = true
      }
      return alerted
    },
  })
  if (outcome === 'in_cooldown' || outcome === 'claimed_elsewhere') {
    await check.keepOpen()
    return check.result(status, false)
  }
  await page.settle(alerted, null)
  return check.result(status, alerted)
}

/**
 * Page several dark jobs that went dark for one reason as one post (#2117).
 *
 * Each job keeps its own claim, cooldown, reminder schedule, paged record and
 * incident, exactly as on its own: only the post is shared. A job inside its
 * cooldown or claimed by another tick is left out; the rest are the page. When
 * one is left it gets its own page, since a group of one is just that job.
 * The claims are kept after a delivered post or one that threw (it may have
 * reached Slack), and freed when Slack definitely took nothing.
 */
async function pageGroup(
  supabase: SupabaseClient,
  kv: KVNamespace,
  group: DarkGroup,
  checks: JobCheck[],
  nowMs: number,
  orgIds: string[],
  claims: AlertClaims | undefined,
): Promise<HeartbeatCheckResult[]> {
  const results: HeartbeatCheckResult[] = []
  const pages: DarkPage[] = []
  for (const check of checks) pages.push(await darkPageOf(kv, check, nowMs))
  const due: DarkPage[] = []
  const notDue = async (page: DarkPage) => {
    await page.check.keepOpen()
    results.push(page.check.result(page.check.look.status, false))
  }
  // Inside every job's cooldown nothing is posted, so no claim is asked for.
  const cooling: boolean[] = []
  for (const page of pages) cooling.push(await page.inCooldown())
  if (cooling.every(Boolean)) {
    for (const page of pages) await notDue(page)
    return results
  }
  // One tick at a time takes the jobs' claims (#2062): two overlapping ticks
  // claiming job by job could split one group between them and post it as two
  // partial pages. Held only while the claims are taken.
  const takingKey = minuteAlertClaimKey('page', CRON_HEARTBEAT_SIGNAL, group.key)
  if (claims && !(await claims.claim(takingKey, MINUTE_ALERT_CLAIM_TTL_SECONDS))) {
    console.log(`[cron-heartbeat] the page for ${group.key} is claimed by another tick`)
    for (const page of pages) await notDue(page)
    return results
  }
  try {
    for (const page of pages) {
      if ((await claimMinutePage({ claims, key: page.claimKey, inCooldown: page.inCooldown })) === 'claimed') due.push(page)
      else await notDue(page)
    }
  } finally {
    await releaseClaimQuietly(claims, takingKey)
  }
  if (due.length === 0) return results
  const reminders = due.map((p) => p.reminder())
  // A reminder only when every job in it is one; its age is the first's, since they were paged together.
  const [first] = reminders
  const standing = first && reminders.every((r) => r !== null) ? first.standing : null
  const unchanged = standing !== null && reminders.every((r) => r?.unchanged === true)
  let alerted = false
  for (const orgId of orgIds) {
    const sent = due.length === 1
      ? await sendCronHeartbeatAlert(
        supabase, orgId, due[0].check.look.job, group.status, due[0].check.look.verdict.ageMs,
        reminders[0]?.standing ?? null, nowMs, reminders[0]?.unchanged ?? false,
      )
      : await sendCronHeartbeatGroupAlert(
        supabase,
        orgId,
        {
          status: group.status,
          triggerCron: group.triggerCron,
          ...(group.worker ? { worker: group.worker } : {}),
          runAt: group.runAt,
          jobs: due.map((p) => ({ label: p.check.look.job.label, dependents: p.check.look.job.dependents, ageMs: p.check.look.verdict.ageMs })),
        },
        standing,
        nowMs,
        unchanged,
      )
    if (sent) alerted = true
  }
  // Nothing reached Slack, so the next tick may retry every one of them.
  if (!alerted) for (const p of due) await releaseClaimQuietly(claims, p.claimKey)
  const paged = due.length > 1 ? { ...group, jobIds: due.map((p) => p.check.look.job.id) } : null
  for (const p of due) {
    await p.settle(alerted, paged)
    results.push(p.check.result(p.check.look.status, alerted))
  }
  return results
}

/** What the healthy side found for a job with a standing condition. */
type Standing =
  | { kind: 'clear' }
  /** Paged as never finished, and no completion since: the all-clear waits. */
  | { kind: 'waiting'; reported: AlertedStatus }
  /** Paged as never finished, and a completion since shows it finished: the all-clear is owed. */
  | { kind: 'owed'; reported: AlertedStatus }

/**
 * The healthy side of one job's check. Recovery resets the reminder schedule, so
 * the next occurrence of this condition is reported at once rather than
 * throttled by its history. Only when there is something to clear: this runs
 * every minute for every job, and an unconditional delete would be two KV
 * WRITES a minute per job for the healthy case, which is almost all of them
 * almost all of the time.
 */
async function judgeHealthy(kv: KVNamespace, check: JobCheck): Promise<Standing> {
  const { job, lastCompleted } = check.look
  if (!(await readCondition(kv, backoffKey(job.id)))) return { kind: 'clear' }
  // A "never finished" page whose job has now finished gets one all-clear
  // (#2057): on 2026-10-14 the run had only finished late, and the channel was
  // left holding an accusation. Stood down only once it is delivered.
  const reported = parseAlertedStatus(await kv.get(alertedStatusKey(job.id)))
  if (reported?.status === 'vanished') {
    // Only a completion shows the job finished: for a slower job the next
    // run's start alone also reads healthy, and says nothing about a finish.
    const completedMs = lastCompleted ? Date.parse(lastCompleted) : NaN
    const sinceMs = reported.since ? Date.parse(reported.since) : NaN
    if (!Number.isFinite(completedMs) || !Number.isFinite(sinceMs) || completedMs < sinceMs) {
      // Still owed its all-clear: the incident is open until the job finishes.
      await check.keepOpen(reported)
      return { kind: 'waiting', reported }
    }
    return { kind: 'owed', reported }
  }
  // A dark job that came back gets no all-clear, by design (#2057 closes only a
  // never finished page), and its record has no end time, since nothing
  // reported one (L11).
  await standDown(kv, check, reported, { reason: 'stood_down_by_design', endedAt: null })
  return { kind: 'clear' }
}

/** End the incident and clear the condition and the paged record. */
async function standDown(
  kv: KVNamespace,
  check: JobCheck,
  reported: AlertedStatus | null,
  end: { reason: IncidentEndReason; endedAt: string | null },
): Promise<void> {
  const { job } = check.look
  // Written before the record is deleted, from the record already read, and
  // never throwing: the all-clear has gone out whatever happens here.
  if (reported) {
    await writeIncidentEvent(kv, {
      type: 'ended',
      signal: CRON_HEARTBEAT_SIGNAL,
      subject: job.id,
      startedAt: incidentStartOf(reported),
      endedAt: end.endedAt,
      reason: end.reason,
    }, check.incident, check.nowMs)
  }
  await clearCondition(kv, backoffKey(job.id))
  await kv.delete(alertedStatusKey(job.id))
}

/** A job owed its never finished all-clear, with the paged record that says so. */
interface Owed {
  check: JobCheck
  reported: AlertedStatus
}

const earliestOf = (isos: string[]): string => isos.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))

/** The latest readable time, or null when there is none. */
function latestOf(isos: (string | null)[]): string | null {
  const readable = isos.filter((s): s is string => s !== null && Number.isFinite(Date.parse(s)))
  return readable.length ? readable.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null
}

/**
 * Batches the owed all-clears so the jobs of one run paged together share one
 * (#2117), and holds a batch while another job of that run is still running a
 * later run inside its allowance and has not finished it. On 2026-10-21 both
 * jobs recovered from the 04:15 run; an all-clear sent the minute the first of
 * them finished would be the second message for one run. The hold is bounded by
 * that run's allowance: past it the job is unfinished again, not running, and
 * the rest go without it.
 */
function allClearBatches(owed: Owed[], waiting: Map<string, Owed>): { send: Owed[][]; hold: Owed[] } {
  const send: Owed[][] = []
  const byGroup = new Map<string, Owed[]>()
  for (const o of owed) {
    const g = o.reported.group
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), o])
    else send.push([o])
  }
  const hold: Owed[] = []
  for (const [group, batch] of byGroup) {
    const stillRunning = (batch[0].reported.groupJobs ?? []).some((id) => {
      const w = waiting.get(id)
      if (!w || w.reported.group !== group || w.check.look.job.completionDroughtMs) return false
      const startedMs = w.check.look.lastRan ? Date.parse(w.check.look.lastRan) : NaN
      const pagedMs = w.reported.startedAt ? Date.parse(w.reported.startedAt) : NaN
      return Number.isFinite(startedMs) && Number.isFinite(pagedMs) && startedMs > pagedMs && w.check.nowMs - startedMs <= w.check.look.job.maxRunMs
    })
    if (stillRunning) hold.push(...batch)
    else send.push(batch)
  }
  return { send, hold }
}

/**
 * Send the never finished all-clear for one job, or one for the jobs of one run
 * paged together (#2117), and stand each down once it is delivered. Each job
 * keeps its own claim (#2062) and its own list of the organizations that have
 * it, so a retry reaches only the ones that missed it.
 */
async function sendAllClears(
  supabase: SupabaseClient,
  kv: KVNamespace,
  owed: Owed[],
  nowMs: number,
  orgIds: string[],
  claims: AlertClaims | undefined,
): Promise<void> {
  // Owed and shown: claim each (#2062), then read its record again, so a tick
  // that judged it owed before another tick's claim lapsed cannot send an
  // all-clear that tick already stood down (L157).
  const claimed: (Owed & { clearKey: string })[] = []
  // As for a grouped page: one tick at a time takes a run's claims, so two
  // overlapping ticks cannot split its all-clear into two. Held only while they are taken.
  const group = owed.length > 1 ? owed[0].reported.group : undefined
  const takingKey = group ? minuteAlertClaimKey('all-clear', CRON_HEARTBEAT_SIGNAL, group) : null
  if (claims && takingKey && !(await claims.claim(takingKey, MINUTE_ALERT_CLAIM_TTL_SECONDS))) {
    console.log(`[cron-heartbeat] the all-clear for ${group} is claimed by another tick`)
    return
  }
  try {
    for (const o of owed) {
      const { job } = o.check.look
      const clearKey = minuteAlertClaimKey('all-clear', CRON_HEARTBEAT_SIGNAL, job.id)
      if (!claims) {
        claimed.push({ ...o, clearKey })
        continue
      }
      if (!(await claims.claim(clearKey, MINUTE_ALERT_CLAIM_TTL_SECONDS))) {
        console.log(`[cron-heartbeat] ${job.id}: the never finished all-clear is claimed by another tick`)
        continue
      }
      const fresh = parseAlertedStatus(await kv.get(alertedStatusKey(job.id)))
      if (fresh?.status !== 'vanished') {
        await releaseClaimQuietly(claims, clearKey)
        continue
      }
      claimed.push({ ...o, reported: fresh, clearKey })
    }
  } finally {
    if (takingKey) await releaseClaimQuietly(claims, takingKey)
  }
  // The reported run finished only if no later run has started since.
  const sameRun = (o: Owed) =>
    o.reported.startedAt !== null && o.check.look.lastRan === o.reported.startedAt && !o.check.look.job.completionDroughtMs
  for (const orgId of orgIds) {
    const pending = claimed.filter((o) => !o.reported.deliveredTo.includes(orgId))
    if (pending.length === 0) continue
    const [only] = pending
    const sent = pending.length === 1
      ? await sendCronHeartbeatRecoveryAlert(
        supabase,
        orgId,
        { label: only.check.look.job.label, status: 'vanished', alertedAt: only.reported.at, endedAt: only.check.look.lastCompleted, sameRun: sameRun(only) },
        nowMs,
      )
      : await sendCronHeartbeatGroupRecoveryAlert(
        supabase,
        orgId,
        {
          alertedAt: earliestOf(pending.map((o) => o.reported.at)),
          endedAt: latestOf(pending.map((o) => o.check.look.lastCompleted)),
          jobs: pending.map((o) => ({ label: o.check.look.job.label, sameRun: sameRun(o) })),
        },
        nowMs,
      )
    if (sent) for (const o of pending) o.reported.deliveredTo.push(orgId)
  }
  for (const o of claimed) {
    const { job, lastCompleted } = o.check.look
    const record = o.reported
    record.attempts += 1
    const missed = orgIds.filter((org) => !record.deliveredTo.includes(org))
    if (missed.length > 0) {
      if (record.attempts < ALL_CLEAR_MAX_ATTEMPTS) {
        await writeAlertedStatus(kv, job.id, record, nowMs)
        // Freed so the next tick can retry the organizations it missed.
        await releaseClaimQuietly(claims, o.clearKey)
        continue
      }
      console.error(
        `[cron-heartbeat] ${job.id}: standing down without the all-clear for ${missed.join(', ')} after ${record.attempts} tries; Slack refused it each time`,
      )
    }
    // An all-clear that reached any organization is a delivered all-clear, as
    // alert-recovery counts one; only a stand down that reached nobody is not.
    // The end is the completion the all-clear reported.
    await standDown(kv, o.check, record, { reason: record.deliveredTo.length > 0 ? 'all_clear' : 'stood_down_by_design', endedAt: lastCompleted })
  }
}

/**
 * Called by the every-minute cron. Looks at every registered job, then pages
 * each one that is dark and sends each owed never finished all-clear, once per
 * per-job cooldown. Jobs dark for one reason share one page, and the jobs of
 * one run paged together share one all-clear (#2117). The org lookup is shared
 * across jobs so a multi-job outage costs one query, not one per job.
 *
 * `claims` makes a stalled tick overlapping the next minute's post each page
 * and each never finished all-clear once (#2062, alert-fanout.ts); the
 * scheduled handler always passes it.
 */
export async function runHeartbeatChecks(
  supabase: SupabaseClient,
  kv: KVNamespace,
  nowMs: number = Date.now(),
  claims?: AlertClaims,
): Promise<HeartbeatCheckResult[]> {
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, 'cron-heartbeat', 'tell-only'))

  const checks: JobCheck[] = []
  for (const job of CRON_JOBS) checks.push(jobCheck(kv, await lookAt(supabase, kv, job, nowMs), nowMs))
  const byId = new Map(checks.map((c) => [c.look.job.id, c]))

  const results = new Map<string, HeartbeatCheckResult>()
  for (const group of darkGroupsOf(checks.map((c) => c.look))) {
    const members = group.jobIds.map((id) => byId.get(id)!)
    for (const r of await pageGroup(supabase, kv, group, members, nowMs, orgIds, claims)) results.set(r.jobId, r)
  }

  const owed: Owed[] = []
  const waiting = new Map<string, Owed>()
  for (const check of checks) {
    const { job, status, lastRan, firstSeen } = check.look
    if (results.has(job.id)) continue
    if (status === 'pending') {
      if (!lastRan && !firstSeen) await kv.put(firstSeenKey(job.id), new Date(nowMs).toISOString())
      results.set(job.id, check.result('pending', false))
    } else if (status === 'healthy') {
      const standing = await judgeHealthy(kv, check)
      if (standing.kind === 'owed') owed.push({ check, reported: standing.reported })
      if (standing.kind === 'waiting') waiting.set(job.id, { check, reported: standing.reported })
      results.set(job.id, check.result('healthy', false))
    } else {
      results.set(job.id, await pageOne(supabase, kv, check, nowMs, orgIds, claims))
    }
  }

  const { send, hold } = allClearBatches(owed, waiting)
  // Held for the rest of its run: still owed, so the incident stays open.
  for (const o of hold) await o.check.keepOpen(o.reported)
  for (const batch of send) await sendAllClears(supabase, kv, batch, nowMs, orgIds, claims)
  return CRON_JOBS.map((j) => results.get(j.id)!)
}

