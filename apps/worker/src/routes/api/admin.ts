// Admin-only endpoints for one-shot maintenance operations.
// All endpoints are scoped to the caller's org — no cross-org access.

import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { deployCodeNodes } from '../../lib/code-node-deployer'
import type { WorkflowDefinition } from '../../types'
import {
  extractSightingFields,
  extractPersonFields,
  extractEnrichment,
  extractBidGroupSummary,
  deriveRejectReason,
  terminalHandleFor,
} from '../../engine/lead-sightings'
import { formatSsn } from '../../engine/persons-crypto'
import { runSightingsExport } from '../../lib/sightings-export'
import { runAchieveExport } from '../../lib/achieve-export'
import { formatErr } from '../../lib/format-error'
import { runExecutionArchive } from '../../lib/execution-archive'
import { checkArchiveSettings } from '../../lib/archive-settings-check'
import { runArchiveGate } from '../../lib/archive-gate'
import { checkTripointPricing } from '../../lib/tripoint-pricing-check'
import { checkLeadStatus } from '../../lib/lead-status-check'
import { archiveSender } from '../../lib/execution-archive-send'
import { parseReArchiveRequest } from '../../archive/rearchive-request'
import { archiveHealth, hoursBehindWatermark } from '../../lib/archive-health'
import { readMemoryReadings } from '../../lib/database-memory-readings'
import { mayRepairRun } from '../../archive/repair-priority'
import { REQUEST_RUN_BUDGET } from '../../archive/deadline'
import { canonicalHourStart } from '../../archive/clock'
import { eraseSubject } from '../../lib/archive-erasure'
import { hashSsn } from '../../engine/persons-crypto'
import { secretKeys } from '../../lib/secret-crypto'
import { reencryptSecrets } from '../../lib/secret-reencrypt'
import {
  supabaseHeldWriteStore,
  salesforcePortFor,
  previewReplay,
  replayHeldWrite,
  abandonHeldWrite,
  HELD_WRITE_STATUSES,
  type ReplayResult,
} from '../../lib/writeback-replay'
import { readBackHoldsStep } from '../../lib/salesforce-read-back'
import { recordAuditLog, writeAuditLog } from '../../lib/audit'
import { SCHEDULED_DRILL_DEADLINE_MS, buyerObjectsHealth, runBuyerObjectsDrill } from '../../lib/buyer-objects-health'
import { withDeadline } from '@bidspoke/buyer-profile'
import { BETTER_STACK_ALERT_NAME, drillNobodyToldPage, type NobodyToldDrillOutcome } from '../../lib/nobody-told-page'

const admin = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/**
 * Force-redeploys every active workflow's code nodes under the current
 * deployer layout (bundled worker per workflow). Used once after rolling out
 * 4B to migrate all workflows off per-node workers.
 */
admin.post('/migrate-code-workers', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data: workflows, error } = await supabase
    .from('workflows')
    .select('id, name, definition')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .is('deleted_at', null)

  if (error) return dbError(c, error)
  if (!workflows) return c.json({ migrated: 0, results: [] })

  const results = await Promise.all(
    workflows.map(async (w) => {
      const definition = w.definition as WorkflowDefinition | null
      if (!definition) return { id: w.id, name: w.name, status: 'skipped', reason: 'no definition' }
      try {
        const deployResults = await deployCodeNodes(
          w.id,
          definition,
          c.env.CLOUDFLARE_ACCOUNT_ID,
          c.env.CLOUDFLARE_API_TOKEN
        )
        const errors = deployResults.filter((r) => r.error)
        if (errors.length > 0) {
          return { id: w.id, name: w.name, status: 'error', error: errors[0].error, node_count: deployResults.length }
        }
        return { id: w.id, name: w.name, status: 'migrated', node_count: deployResults.length }
      } catch (e) {
        return { id: w.id, name: w.name, status: 'error', error: formatErr(e) }
      }
    })
  )

  const migrated = results.filter((r) => r.status === 'migrated').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const errored = results.filter((r) => r.status === 'error').length

  return c.json({ migrated, skipped, errored, results })
})

/**
 * One-shot backfill of lead_sightings + lead_sighting_bids from historical
 * workflow_executions and execution_steps. Writes through Supabase
 * with outcome_state='finalized' and exported_at=null so the next nightly cron
 * picks them up.
 *
 * Idempotent: skips executions that already have a sighting row.
 *
 * Body: { workflow_id: string, since_iso: string }
 */
admin.post('/backfill-sightings', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ workflow_id?: string; since_iso?: string }>()

  if (!body.workflow_id || !body.since_iso) {
    return c.json({ error: 'workflow_id and since_iso required' }, 400)
  }

  // Verify the workflow belongs to the caller's org
  const { data: wfRow, error: wfErr } = await supabase
    .from('workflows')
    .select('id, organization_id, definition')
    .eq('id', body.workflow_id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (wfErr || !wfRow) {
    return c.json({ error: 'Workflow not found in this organization' }, 404)
  }
  const definition = wfRow.definition as unknown as WorkflowDefinition

  // Bounded per-call processing — single Worker invocation has limited CPU
  // wall time. 1000 executions × ~250ms each = ~4 minutes. Re-run to continue.
  const MAX_PER_CALL = 1000
  const PAGE_SIZE = 500

  let inserted = 0
  let skipped = 0
  let errors = 0
  let scanned = 0
  let cursor = body.since_iso

  while (scanned < MAX_PER_CALL) {
    const remaining = MAX_PER_CALL - scanned
    const pageLimit = Math.min(PAGE_SIZE, remaining)

    const { data: executions, error: execErr } = await supabase
      .from('workflow_executions')
      .select('id, started_at, completed_at, duration_ms, response_body, response_status, trigger_payload, source, trace_id, workflow_version_id, is_test, status')
      .eq('workflow_id', body.workflow_id)
      .gte('started_at', cursor)
      .eq('is_test', false)
      .order('started_at', { ascending: true })
      .limit(pageLimit)
    if (execErr) return dbError(c, execErr)
    if (!executions || executions.length === 0) break

    // Skip executions that already have a sighting backfilled
    const execIds = executions.map((e) => e.id)
    // paginate-ok: bounded to one backfill page of execution ids (one sighting each)
    const { data: existingSightings, error: existingErr } = await supabase
      .from('lead_sightings')
      .select('execution_id')
      .in('execution_id', execIds)
    // A dropped error here would empty the dedup set and re-insert sightings that
    // were already backfilled. Abort the page (cursor hasn't advanced — a re-run
    // resumes here) rather than duplicate.
    if (existingErr) return dbError(c, existingErr)
    const alreadyHave = new Set((existingSightings ?? []).map((r) => r.execution_id))

    for (const exec of executions) {
      scanned++
      if (alreadyHave.has(exec.id)) {
        skipped++
        continue
      }

    try {
      const payload = exec.trigger_payload as unknown
      const sightingFields = extractSightingFields(payload)
      const personFields = extractPersonFields(payload)

      // No persons write since #765: the table had no reader, and the raw ssn the
      // Snowflake export and repeat-lead grouping actually use is written onto the
      // lead_sightings row below.

      // Pull execution_steps for this run to extract terminal info + enrichment + bids.
      // Order by step_order (monotonic, unique per execution); started_at is too coarse
      // when many steps share the same second, producing non-deterministic "last step".
      // paginate-ok: one execution's steps (tens of rows, well under the cap)
      const { data: steps, error: stepsErr } = await supabase
        .from('execution_steps')
        .select('step_namespace, step_type, status, output, started_at, step_order')
        .eq('execution_id', exec.id)
        .eq('execution_started_at', exec.started_at)
        .order('step_order', { ascending: true })
      // A dropped error would write a sighting with empty steps (no terminal node,
      // enrichment, or bids). Throw so the per-exec catch skips this one instead of
      // persisting a context-less row; a later run retries it.
      if (stepsErr) throw new Error(`steps fetch failed for ${exec.id}: ${stepsErr.message}`)

      // Build a synthetic ctx.steps map for the extract helpers
      const stepsMap: Record<string, { output: unknown; status: string }> = {}
      for (const s of steps ?? []) {
        stepsMap[s.step_namespace] = {
          output: s.output,
          status: s.status,
        }
      }

      const enrichment = extractEnrichment(stepsMap as Parameters<typeof extractEnrichment>[0])
      const bidSummary = extractBidGroupSummary(stepsMap as Parameters<typeof extractBidGroupSummary>[0])

      // Terminal node: last step that completed successfully
      const completedSteps = (steps ?? []).filter((s) => s.status === 'completed')
      const lastStep = completedSteps[completedSteps.length - 1]
      const terminalNs = (lastStep?.step_namespace as string | undefined) ?? null
      const terminalNode = terminalNs ? definition.nodes.find((n) => n.namespace === terminalNs) ?? null : null
      // The same derivation the live finalize uses, so the backfill and the engine
      // read a node's exit handle identically (#1411, L613).
      const terminalHandle = terminalHandleFor(terminalNode?.type, lastStep?.output)

      // response_body only ever stores the BODY; the status lives in the
      // response_status column written at finalize. Rows from before that
      // column existed stay null and deriveRejectReason treats them as
      // unclassifiable, same as today.
      const responseStatusCode = (exec.response_status) ?? null

      const rejectReason = deriveRejectReason({
        winning_partner_slug: bidSummary.winner_slug,
        response_status_code: responseStatusCode,
        terminal_node_type: terminalNode?.type ?? null,
        terminal_node_label: terminalNode?.namespace ?? terminalNs,
        terminal_node_handle: terminalHandle,
        terminal_step_output: lastStep?.output,
      })

      const startedAt = new Date(exec.started_at)
      const completedAt = exec.completed_at ? new Date(exec.completed_at) : startedAt

      const sightingRow = {
        id: crypto.randomUUID(),
        ssn: personFields?.ssn ? formatSsn(personFields.ssn) : null,
        person_id: null,
        trace_id: (exec.trace_id) ?? exec.id,
        execution_id: exec.id,
        workflow_id: body.workflow_id,
        workflow_version_id: exec.workflow_version_id,
        workflow_version_sha: null,
        execution_started_at_et: startedAt.toISOString(),
        execution_finished_at_et: completedAt.toISOString(),
        execution_started_at_utc: startedAt.toISOString(),
        execution_ended_at_utc: completedAt.toISOString(),
        duration_ms: (exec.duration_ms) ?? null,
        source_name: (exec.source) ?? null,
        terminal_node_id: terminalNode?.id ?? null,
        terminal_node_label: terminalNode?.namespace ?? terminalNs,
        response_status_code: responseStatusCode,
        reject_reason: rejectReason,
        prospect_id: enrichment.prospect_id,
        equifax_status: enrichment.equifax_status,
        equifax_error_type: enrichment.equifax_error_type,
        equifax_score: enrichment.equifax_score,
        winning_partner_slug: bidSummary.winner_slug,
        winning_bid_cents: bidSummary.winner_bid_cents,
        partners_attempted: bidSummary.attempted,
        partners_responded: bidSummary.responded,
        outcome_state: 'finalized',
        is_test: false,
        ...sightingFields,
      }

      const { error: insErr } = await supabase.from('lead_sightings').insert(sightingRow)
      if (insErr) {
        errors++
        continue
      }

      // Backfill bid rows from any partner_bid steps
      const partnerBidSteps = (steps ?? []).filter((s) => s.step_type === 'partner_bid')
      for (const bidStep of partnerBidSteps) {
        const out = bidStep.output as {
          partner?: string
          bid?: number
          accepted?: boolean
          skipped?: boolean
          skip_reason?: string
        } | null
        if (!out?.partner) continue
        const attemptedAt = new Date(bidStep.started_at)
        await supabase.from('lead_sighting_bids').insert({
          id: crypto.randomUUID(),
          sighting_id: sightingRow.id,
          ssn: sightingRow.ssn,
          trace_id: sightingRow.trace_id,
          execution_id: sightingRow.execution_id,
          partner_slug: out.partner,
          is_winner: bidSummary.winner_slug === out.partner,
          attempted_at_utc: attemptedAt.toISOString(),
          attempted_at_et: attemptedAt.toISOString(),
          bid_cents: typeof out.bid === 'number' ? Math.round(out.bid * 100) : null,
          classification: out.accepted ? 'accept' : (out.skipped ? 'decline' : null),
          skip_reason: out.skip_reason ?? null,
          is_test: false,
        })
      }

      inserted++
    } catch (e) {
      errors++
      console.error(`[backfill] execution ${exec.id} failed:`, e)
    }
    }

    // Advance cursor — next page starts strictly after the last started_at we saw.
    // Bump by 1ms so the >= filter doesn't re-fetch the boundary row.
    const lastStarted = new Date(executions[executions.length - 1].started_at)
    cursor = new Date(lastStarted.getTime() + 1).toISOString()

    if (executions.length < pageLimit) break
  }

  return c.json({
    scanned,
    inserted,
    skipped,
    errors,
    next_cursor: cursor,
    has_more: scanned >= MAX_PER_CALL,
  })
})

const EXPORT_TARGETS = ['all', 'achieve', 'sightings'] as const
type ExportTarget = (typeof EXPORT_TARGETS)[number]

/**
 * Manually trigger a nightly Snowflake export. Same code paths as the scheduled
 * crons (sightings every 2h at :37, Achieve at 09:00 UTC), but callable on demand.
 * Use cases: backfill verification, demos, or recovery from a failed cron run.
 *
 * Optional body `{ target: 'all' | 'achieve' | 'sightings' }`, default 'all'.
 * Achieve runs first: it is small (one row per evaluation) while the sightings
 * drain is capped at ~50K rows against a time budget, so running it second risks
 * leaving no budget for it at all.
 */
admin.post('/run-export-now', async (c) => {
  const body = await c.req.json<{ target?: string }>().catch(() => ({}) as { target?: string })
  const target = (body.target ?? 'all') as ExportTarget
  if (!EXPORT_TARGETS.includes(target)) {
    return c.json({ error: `target must be one of: ${EXPORT_TARGETS.join(', ')}` }, 400)
  }

  const supabase = createSupabaseClient(c.env)
  const result: {
    achieve?: Awaited<ReturnType<typeof runAchieveExport>>
    sightings?: Awaited<ReturnType<typeof runSightingsExport>>
    errors: string[]
  } = { errors: [] }

  // Each export is independent, so one blowing up must not cancel the other. But a
  // thrown export is a real failure: record it and fail the response, never return
  // an empty summary that reads as "ran fine, nothing to export".
  if (target === 'all' || target === 'achieve') {
    try {
      result.achieve = await runAchieveExport(supabase, c.env)
    } catch (e) {
      result.errors.push(`achieve export: ${formatErr(e)}`)
    }
  }

  if (target === 'all' || target === 'sightings') {
    try {
      result.sightings = await runSightingsExport(supabase, c.env)
    } catch (e) {
      result.errors.push(`sightings export: ${formatErr(e)}`)
    }
  }

  return c.json(result, result.errors.length > 0 ? 500 : 200)
})

/**
 * Runs stranded lead recovery now (#380), rather than waiting for the
 * `reduce-finalize-stranded` pg_cron job at :27 and :57. It calls the SAME
 * function the cron calls, so a run is evidence about the cron's code, and is
 * safe beside a cron run: the function only finalises rows still in flight, so a
 * second concurrent run waits on the first's row locks and then finds nothing,
 * and its bid inserts skip duplicates.
 *
 * Optional body `{ lookbackDays }`, a whole number from 1 (the 30 minute job,
 * the default) to 8 (the daily deep job). Measured 2026-10-13 over 7 days: the
 * 30 minute job averaged 2.3 s and peaked at 22.9 s, inside the worker's 30 s
 * database budget, which the cron's own 120 s does not share. A run that outruns
 * it is cancelled whole, one statement, so the answer says nothing was kept.
 */
const STRAND_RECOVERY_MAX_LOOKBACK_DAYS = 8
/**
 * The function takes no organization: like the scheduled job, it recovers every
 * organization's stranded leads. This router is otherwise org scoped, so the
 * answer and the audit row both say so rather than reading as the caller's org.
 */
const STRAND_RECOVERY_SCOPE = 'every organization'

admin.post('/run-strand-recovery', async (c) => {
  // A body of JSON null parses fine and is not an object, so it is read as no body.
  const parsed: unknown = await c.req.json().catch(() => ({}))
  const body = parsed !== null && typeof parsed === 'object' ? (parsed as { lookbackDays?: unknown }) : {}
  const lookbackDays = body.lookbackDays === undefined ? 1 : body.lookbackDays
  if (typeof lookbackDays !== 'number' || !Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > STRAND_RECOVERY_MAX_LOOKBACK_DAYS) {
    return c.json({ error: `lookbackDays must be a whole number of days from 1 to ${STRAND_RECOVERY_MAX_LOOKBACK_DAYS}` }, 400)
  }

  const { orgId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase.rpc('reduce_finalize_stranded', { p_lookback_days: lookbackDays })
  if (error) {
    if (error.code === '57014') {
      return c.json(
        {
          ok: false,
          error:
            'Recovery ran past the 30 seconds the app may hold the database and was cancelled, so nothing it changed was kept. ' +
            'The scheduled run at :27 and :57 past each hour has 2 minutes and will carry on.',
        },
        504,
      )
    }
    return c.json({ ok: false, error: `Recovery failed: ${formatErr(error)}` }, 500)
  }
  if (typeof data !== 'number' || !Number.isInteger(data)) {
    return c.json({ ok: false, error: `Recovery ran but did not say how many leads it recovered: ${JSON.stringify(data)}` }, 500)
  }

  await writeAuditLog(supabase, orgId, 'strand_recovery', 'reduce_finalize_stranded', 'strand_recovery_run', email ?? 'unknown', {
    lookback_days: lookbackDays,
    recovered: data,
    scope: STRAND_RECOVERY_SCOPE,
  })
  return c.json({ ok: true, recovered: data, lookbackDays, scope: STRAND_RECOVERY_SCOPE })
})

/**
 * Re-archives a named hour or day, leaving the watermark alone (#976).
 *
 * The archive advances strictly forward, so an hour that was skipped or only
 * partly archived had no recovery path. That matters because the deletion gate
 * (#872) clears a day only when its counts reconcile: ONE missed hour makes that
 * day permanently unverifiable, and after A5 (#873) the only escape would be a
 * recorded human release authorising the deletion of data that has no backup.
 *
 * It runs the hourly job's own pipeline through `hours`, not a separate tool, so
 * a successful repair is evidence about the archiver. Duplicates are harmless:
 * the gate counts DISTINCT execution ids and every write here is a keyed upsert.
 */
/**
 * Which of these hours the archive already holds.
 *
 * `hour_start` comes back in Postgres' own rendering, so every value is
 * normalised to the same ISO form the caller asked with. Comparing them raw finds
 * no match, which does not fail: it silently redoes work that was already done,
 * which is the exact defect this lookup exists to prevent (#1019).
 *
 * A failed read THROWS rather than answering an empty set, because an empty set
 * means "skip nothing", so a broken lookup would reinstate the treadmill with no
 * symptom (L215).
 */
async function recordedHoursAmong(
  supabase: ReturnType<typeof createSupabaseClient>,
  hours: string[],
): Promise<Set<string>> {
  // paginate-ok: bounded to the hours asked about, which is one day's 24 (#1191).
  const { data, error } = await supabase
    .from('execution_archive_hours')
    .select('hour_start')
    .in('hour_start', hours)
  if (error) throw new Error(`reading which hours are already archived failed: ${formatErr(error)}`)
  const found = new Set<string>()
  for (const row of (data ?? []) as Array<{ hour_start?: unknown }>) {
    const raw = row.hour_start
    if (typeof raw !== 'string') continue
    const canonical = canonicalHourStart(raw)
    if (canonical !== null) found.add(canonical)
  }
  return found
}

admin.post('/re-archive', async (c) => {
  const body = await c.req
    .json<{ hour?: unknown; day?: unknown; force?: unknown }>()
    .catch(() => ({}) as { hour?: unknown; day?: unknown; force?: unknown })
  const request = parseReArchiveRequest(body, new Date())
  if (!request.ok) return c.json({ error: request.reason }, 400)

  const supabase = createSupabaseClient(c.env)

  // THE REPAIR YIELDS TO THE LIVE ARCHIVE (#1027, #1032).
  //
  // This route takes the same run lock the hourly archive takes and holds it
  // for 80 to 320 seconds. On 2026-08-23 a script drove it every three minutes
  // for three hours; every hourly run answered `skipped-locked`, the live
  // watermark sat at 15:00 UTC, and the standstill alert fired blaming
  // Snowflake, which was fine. The archive was starving itself with its own
  // repair.
  //
  // Refused BEFORE the lock is taken, not after: a refusal that happens once
  // the work is under way has already displaced the hours it was meant to
  // protect (L667).
  const watermarkHoursBehind = await hoursBehindWatermark(supabase, new Date())
  const verdict = mayRepairRun({
    hoursBehind: watermarkHoursBehind,
    force: body.force === true,
  })
  if (!verdict.allowed) {
    return c.json(
      { error: verdict.reason, hoursBehind: watermarkHoursBehind, hours: request.hours },
      409,
    )
  }

  // A day is a repair of what is missing, so what is already there is left alone.
  // A named hour is a deliberate redo, so nothing is skipped.
  const alreadyRecorded =
    request.form === 'day' ? await recordedHoursAmong(supabase, request.hours) : undefined

  const summary = await runExecutionArchive(c.env, supabase, {
    sendBatch: archiveSender(c.env),
    hours: request.hours,
    alreadyRecorded,
    // THIS IS A FETCH HANDLER, not the cron (#1048). The run's default budget
    // is sized inside the platform's CRON limit, and inheriting it here meant
    // committing to work this context cannot finish: measured 2026-08-24, the
    // request was killed at 218 seconds with Cloudflare 1102 partway through
    // its second hour, while the scheduled run did two comparable hours in 390
    // seconds the same night. A run killed by the platform writes no record and
    // sends no alert, so it always ended in the least informative way available.
    budget: REQUEST_RUN_BUDGET,
  })

  // A run that could not take the lock did NO work, and answering 200 with a
  // summary of zeros would read as an hour that turned out to be empty. The
  // caller has to be able to tell "there is nothing there" from "we did not
  // look" (L98).
  if (summary.skipped === 'locked') {
    return c.json({ error: `the archive is already running: ${summary.detail}`, hours: request.hours }, 409)
  }

  // COMPLETION IS READ BACK, not inferred from what the run says it did. One
  // invocation archives only what fits its budget, so a clean finish is not a
  // finished day, and a caller that reads only the status code must not be able
  // to mistake the one for the other (#1018). 202 says accepted and incomplete.
  const recorded = await recordedHoursAmong(supabase, request.hours)
  const complete = recorded.size >= request.hours.length

  return c.json(
    {
      hours: request.hours,
      hoursRequested: request.hours.length,
      hoursRecorded: recorded.size,
      hoursRemaining: request.hours.length - recorded.size,
      complete,
      summary,
    },
    summary.failed ? 500 : complete ? 200 : 202,
  )
})

/**
 * Runs the daily archive settings read-back on demand (#1050).
 *
 * The scheduled version answers once a day, so a change to WHAT it asks
 * Snowflake could only be confirmed a day later. That is not hypothetical: the
 * first version of the retention read used a statement the reader identity may
 * not run, and it reported its own refusal every morning for six days before
 * anyone was in a position to see it.
 *
 * It calls the scheduled check itself rather than reimplementing the reads. A
 * separate probe would be evidence about the probe, and would drift from the
 * real check exactly when nobody is watching.
 *
 * NOT 200 when something drifted. The whole value of this route is being able to
 * trust a green, so a caller that reads only the status code must not be able to
 * mistake a reported difference for a verified setting (L98).
 */
/**
 * GET, not POST, and that is the whole contract (#959).
 *
 * Every other archive route here runs something. This one only looks, so it is
 * a GET: a reader who tries it to find out what is going on cannot start a job
 * by accident, and the method says so before anybody reads the handler (L206).
 *
 * It answers 200 whatever it finds. A degraded archive is a successful reading
 * of a degraded archive, and returning 500 for it would make "the archive is
 * unwell" and "the health check itself is broken" the same response to whoever
 * is trying to tell them apart.
 */
admin.get('/archive-health', async (c) => {
  const supabase = createSupabaseClient(c.env)
  return c.json(await archiveHealth(c.env, supabase))
})

/**
 * The recorded database-memory readings (#2010), oldest first, for calibrating the 600/500 MB
 * swap thresholds against real data. A GET that only looks (L206): it reads the worker's own
 * KV ring buffer, never the database the memory check watches. A storage outage is a 503
 * carrying the error, so a dashboard or query sees red rather than an empty list that reads as
 * "nothing recorded yet" (L11).
 */
admin.get('/database-memory-readings', async (c) => {
  const { readings, error, droppedCount } = await readMemoryReadings(c.env.IDEMPOTENCY)
  if (error) return c.json({ ok: false, error, count: 0, dropped: droppedCount, oldestAt: null, newestAt: null, readings: [] }, 503)
  const count = readings.length
  return c.json({
    ok: true,
    count,
    // Entries that were in the buffer but no longer match the reading shape, so the caller can
    // see that part of the history is missing rather than reading `count` as the whole truth.
    dropped: droppedCount,
    oldestAt: count ? readings[0].at : null,
    newestAt: count ? readings[count - 1].at : null,
    readings,
  })
})

/**
 * Buyer selection objects (#1410). Health is a GET that only looks: a peek on
 * one throwaway ledger and a read on one throwaway claim. A failed probe is a
 * 503 carrying the report, so a dashboard sees red rather than a shape (L11).
 */
admin.get('/buyer-objects/health', async (c) => {
  const report = await buyerObjectsHealth(c.env)
  return c.json(report, report.ok ? 200 : 503)
})

/**
 * The drill WRITES, so it is a POST and is named a drill (L206): under the
 * rehearsal kind against a throwaway buyer it runs the two lead race, the
 * in_doubt race, a kill after reserve and a kill after commit that the next
 * attempt heals from the ledger (#1643), and records the p50 and p99 of every
 * object call. The p99 sets OBJECT_CALL_DEADLINE_MS. It calls no buyer and
 * writes no Postgres row. Bounded as a whole (L110); a failed scenario is a 500
 * carrying the report. The same drill also runs once a day from the 13:00 UTC
 * batch under a job_runs row (#1643); this route is for running it on demand.
 */
admin.post('/buyer-objects/drill', async (c) => {
  const report = await withDeadline(runBuyerObjectsDrill(c.env), SCHEDULED_DRILL_DEADLINE_MS, 'buyer objects drill')
  return c.json(report, report.ok ? 200 : 500)
})

/**
 * The drill for the Better Stack page "nobody can be told in Slack" (#2063,
 * #1303). Nothing else sends that page on demand, so without this nobody can
 * prove the stored URL and token are right or that the alert fires until an
 * outage needs them. It sends ONE page through the real page's own request
 * (drillNobodyToldPage in lib/nobody-told-page.ts), with the worker's own
 * secrets, carrying the line the alert matches on and `reason: 'drill'`. It
 * PAGES whoever the alert is routed to, so it is a POST named a drill (L206).
 *
 * Caller: any signed in user on the access allowlist, as for every /api/admin
 * route (jwtAuth). Scoping: it reads no tenant data, and the page names no
 * organization; the caller's organization is used only for the audit row. It
 * never reads or writes the IDEMPOTENCY record a real page dedupes on, so it
 * cannot hold back a real outage's page. Every outcome is its own answer, never
 * a blanket ok, and every attempt is audited, one that sent nothing included;
 * `audited` in the answer says whether that row actually landed.
 */
const DRILL_STATUS: Record<NobodyToldDrillOutcome['outcome'], 200 | 502 | 503 | 504> = {
  sent: 200,
  refused: 502,
  threw: 502,
  no_answer: 504,
  not_configured: 503,
}

admin.post('/nobody-told-page/drill', async (c) => {
  const { orgId, email } = c.get('user')
  const result = await drillNobodyToldPage({ token: c.env.BETTERSTACK_OUTAGE_TOKEN, url: c.env.BETTERSTACK_OUTAGE_URL })
  // recordAuditLog, not writeAuditLog: the answer says whether the row landed
  // rather than claiming every attempt is audited when the write failed (L11).
  const audited = await recordAuditLog(createSupabaseClient(c.env), orgId, 'outage_page', BETTER_STACK_ALERT_NAME, 'outage_page_drilled', email ?? 'unknown', { ...result })
  return c.json({ ok: result.outcome === 'sent', ...result, alert: BETTER_STACK_ALERT_NAME, audited }, DRILL_STATUS[result.outcome])
})

admin.post('/archive-settings-check', async (c) => {
  const supabase = createSupabaseClient(c.env)
  const result = await checkArchiveSettings(c.env, supabase)

  return c.json(
    {
      ok: result.differences.length === 0,
      observed: result.observed,
      differences: result.differences,
    },
    result.differences.length === 0 ? 200 : 500,
  )
})

/**
 * Runs the deletion gate's measurements now, rather than at 13:00 UTC (#986).
 *
 * The same reason `/archive-settings-check` exists: a change to what the gate can
 * actually see could otherwise only be confirmed by waiting a day. The gate's
 * payload probe spent its first 16 days reporting every day as missing bundles
 * because the Snowflake client read only the first partition of a result, and a
 * daily feedback loop is how a second wrong reading would survive just as long.
 *
 * It calls the SAME function the cron calls. A separate probe here would be
 * evidence about this route.
 *
 * ZERO DAYS IS NOT A PASS. The gate considers no days until the archiver has
 * finished one, and answering 200 for a run that measured nothing is exactly the
 * shape that makes "everything is verified" and "nothing was looked at" the same
 * response (L98).
 */
/**
 * A DAY, or nothing. Refuses anything it cannot use rather than dropping it and
 * running the default six minute pass (L320).
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function parseRestrictDays(
  body: Record<string, unknown>,
): { ok: true; value: { from?: string; to?: string; limit?: number } | undefined } | { ok: false; error: string } {
  const restrict: { from?: string; to?: string; limit?: number } = {}
  for (const key of ['from', 'to'] as const) {
    const raw = body[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string' || !DAY_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`))) {
      return { ok: false, error: `${key} must be a YYYY-MM-DD date, got ${JSON.stringify(raw)}` }
    }
    restrict[key] = raw
  }
  if (body.limit !== undefined && body.limit !== null) {
    const limit = body.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return { ok: false, error: `limit must be a whole number of days, at least 1, got ${JSON.stringify(limit)}` }
    }
    restrict.limit = limit
  }
  if (restrict.from !== undefined && restrict.to !== undefined && restrict.from > restrict.to) {
    return { ok: false, error: `from (${restrict.from}) is after to (${restrict.to})` }
  }
  return { ok: true, value: Object.keys(restrict).length === 0 ? undefined : restrict }
}

admin.post('/archive-gate', async (c) => {
  // A full pass is about six minutes, 18 seconds per populated day, and this
  // route does its work inside the request. A caller whose client gives up first
  // kills the run partway, so it accepts a range and can be driven in chunks
  // that fit inside that client's timeout (#1129). The run record the pass opens
  // is returned either way, so a caller that DOES die can still look up what
  // happened rather than being left with nothing.
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await c.req.json()
    if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    // No body at all is the ordinary full pass, unchanged.
  }
  const restrict = parseRestrictDays(body)
  if (!restrict.ok) return c.json({ error: restrict.error }, 400)

  const supabase = createSupabaseClient(c.env)
  let summary: Awaited<ReturnType<typeof runArchiveGate>>
  try {
    summary = await runArchiveGate(c.env, supabase, { restrictDays: restrict.value })
  } catch (err) {
    // A range naming no candidate day is the caller asking for something this
    // pass cannot do, which is a 400 about their request rather than a 500 about
    // the server (L11).
    // formatErr, never String(err): a plain Supabase or PostgREST error renders
    // as "[object Object]" and blanks the message it is being matched on.
    const message = formatErr(err)
    if (/no candidate day/i.test(message)) return c.json({ error: message }, 400)
    throw err
  }

  const days = summary.results.map((r) => ({
    archiveDay: r.archiveDay,
    daysLeft: r.daysLeft,
    verified: r.error === null && r.refusals.length === 0,
    refusals: r.refusals,
    error: r.error,
    probeOk: r.measurement?.probeOk ?? null,
    probeSampled: r.measurement?.probeSampled ?? null,
  }))
  const ok = summary.daysConsidered > 0 && days.every((d) => d.verified)

  return c.json(
    {
      ok,
      runId: summary.runId,
      daysConsidered: summary.daysConsidered,
      daysAvailable: summary.daysAvailable,
      daysMeasured: summary.daysMeasured,
      daysVerified: days.filter((d) => d.verified).length,
      detail: summary.detail,
      days,
    },
    ok ? 200 : 500,
  )
})

/**
 * Compares Bidspoke's Tripoint price with the Salesforce revenue formula now
 * (#1166), rather than waiting for the 13:00 UTC cron.
 *
 * The first thing anyone needs to know after this check ships is whether the
 * Worker's connected app can read the Tooling API at all, and a day is too long
 * to wait for that answer. It calls the SAME function the cron calls.
 *
 * A DISAGREEMENT OR AN UNREAD FORMULA IS NOT 200. Both mean Bidspoke is bidding a
 * price nobody has confirmed Salesforce will book, and a caller reading only the
 * status must not be able to take that for agreement (L98).
 */
admin.post('/tripoint-pricing-check', async (c) => {
  const supabase = createSupabaseClient(c.env)
  const result = await checkTripointPricing(c.env, supabase)
  const ok = result.salesforce !== null && result.differences.length === 0
  return c.json(
    {
      ok,
      salesforce: result.salesforce,
      engine_tiers: result.engine_tiers,
      formulas_read: result.formulas_read,
      differences: result.differences,
      notes: result.notes,
    },
    ok ? 200 : 500,
  )
})

/**
 * Runs the Lead status check now (#1524, #1525), rather than at the 13:00 UTC
 * cron: after a Salesforce fix ships, whether new sales reach the Lead is the
 * question, and a day is too long to wait. The SAME function the cron calls.
 * Any finding, a count that could not be read included, is a 500, so a caller
 * reading only the status cannot take it for agreement (L98).
 */
admin.post('/lead-status-check', async (c) => {
  const supabase = createSupabaseClient(c.env)
  const r = await checkLeadStatus(c.env, supabase)
  const ok = r.findings.length === 0
  return c.json({ ok, day: r.day, partners: r.partners, findings: r.findings }, ok ? 200 : 500)
})

/**
 * Erases one subject from every place their identity landed (#875, Phase A7).
 *
 * Moving from a 7 day truncate to a 13 month archive multiplies the SSN exposure
 * window by roughly 56x, and the truncate was the only control. This is the
 * control that replaces it.
 *
 * The response NEVER says "erased" unless every enumerated target succeeded and
 * none is unverified. A partial erasure answers 500: the subject's identity
 * survives somewhere, and reporting success would close the matter, which ADR
 * 0009 calls out as worse than not trying.
 *
 * THE SSN IS NEVER WRITTEN ANYWHERE BY THIS ROUTE. The audit row is keyed on the
 * peppered hash, which identifies the request without storing the value it is
 * about (L19).
 */
admin.post('/erase-subject', async (c) => {
  const { orgId, email } = c.get('user')
  const body = await c.req
    .json<{ ssn?: unknown; reason?: unknown; dryRun?: unknown }>()
    .catch(() => ({}) as { ssn?: unknown; reason?: unknown; dryRun?: unknown })

  if (typeof body.ssn !== 'string' || body.ssn.replace(/\D/g, '').length !== 9) {
    return c.json({ error: 'ssn must be a nine digit social security number' }, 400)
  }
  // Required, not defaulted. An erasure with no stated reason leaves a ledger
  // row nobody can account for later, and the ledger is what the deletion gate
  // subtracts against.
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    return c.json({ error: 'reason is required, and is recorded against the erasure' }, 400)
  }
  // DEFAULTS TO A PREVIEW. Erasure deletes production consumer data with no
  // undo, so forgetting this flag must remove nothing: a gate's default has to
  // be its off value (L72). Deleting requires saying so.
  //
  // Refused rather than coerced when it is present and not a boolean, because
  // `dryRun: "false"` is truthy and would preview when the caller plainly meant
  // to delete, and `dryRun: 0` would delete when they meant to preview. Either
  // way a guess here is the wrong one.
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return c.json({ error: 'dryRun must be true or false' }, 400)
  }
  const dryRun = body.dryRun !== false

  const pepper = c.env.SSN_HASH_PEPPER
  if (typeof pepper !== 'string' || pepper.length === 0) {
    // Refused rather than run. Without the pepper the secondary resolver is
    // absent, so the erasure would silently cover less than it claims.
    return c.json({ error: 'SSN_HASH_PEPPER is not set, so an erasure cannot resolve the subject in full' }, 503)
  }

  const supabase = createSupabaseClient(c.env)
  const result = await eraseSubject(c.env, supabase, {
    ssn: body.ssn,
    reason: body.reason,
    organizationId: orgId,
    requestedBy: email ?? 'unknown',
    dryRun,
  })

  await writeAuditLog(
    supabase,
    orgId,
    'archive_erasure',
    await hashSsn(body.ssn, pepper),
    // A preview is not an erasure. Auditing one as `subject_erased` would tell
    // a later reader the person's data was removed when nothing was touched,
    // which is worse than no row at all.
    dryRun ? 'subject_erasure_previewed' : 'subject_erased',
    email ?? 'unknown',
    {
      reason: body.reason,
      dry_run: dryRun,
      status: result.verdict.status,
      executions: result.executionIds.length,
      per_target: Object.fromEntries(result.outcomes.map((o) => [o.target, o.error ?? o.rowsDeleted])),
    },
  )

  return c.json(
    { status: result.verdict.status, dryRun, summary: result.summary, outcomes: result.outcomes },
    result.verdict.status === 'partial' ? 500 : 200,
  )
})

/**
 * Re-locks every stored secret with the key new writes use (#384): the middle
 * step of a SECRET_ENCRYPTION_KEY rotation (see lib/secret-crypto.ts). Without
 * SECRET_ENCRYPTION_KEY_NEXT set it is a check that every stored value opens
 * with the primary key alone.
 *
 * DEFAULTS TO A PREVIEW, because it rewrites every credential the engine reads
 * (L72). A non-boolean dryRun is refused rather than read as truthy.
 */
admin.post('/reencrypt-secrets', async (c) => {
  const { orgId, email } = c.get('user')
  const body = await c.req.json<{ dryRun?: unknown }>().catch(() => ({}) as { dryRun?: unknown })
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return c.json({ error: 'dryRun must be true or false' }, 400)
  }
  const dryRun = body.dryRun !== false
  const keys = secretKeys(c.env)
  const supabase = createSupabaseClient(c.env)
  try {
    const result = await reencryptSecrets(supabase, keys, { dryRun })
    if (!dryRun) {
      await writeAuditLog(supabase, orgId, 'recovery_secret', 'SECRET_ENCRYPTION_KEY', 'secrets_reencrypted', email ?? 'unknown', {
        ok: result.ok,
        tables: result.tables,
      })
    }
    return c.json({ ...result, rotating: keys.decryptWith.length > 1 })
  } catch (err) {
    return c.json({ error: formatErr(err) }, 500)
  }
})

// ------------------------------------------------------------------
// Held Salesforce writes (#471)
// ------------------------------------------------------------------
// A post-answer Salesforce write that failed is kept in
// outcome_writeback_deadletters (#1993). These are the manual actions on it:
// list, replay (a preview unless dryRun is false), and abandon. Every call is
// scoped to the caller's organization, and every action is audited with no lead
// value in the audit row.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REPLAY_STATUS: Record<ReplayResult['kind'], 200 | 404 | 409 | 500 | 502 | 503> = {
  not_found: 404,
  not_replayable: 409,
  conflict: 409,
  unreadable: 500,
  no_salesforce: 502,
  replayed: 200,
  refused: 200,
  still_pending: 200,
  // The Salesforce bulkhead was full, so nothing was sent and no attempt spent: try again shortly.
  held: 503,
}

admin.get('/held-writes', async (c) => {
  const { orgId } = c.get('user')
  const status = c.req.query('status')
  if (status !== undefined && !(HELD_WRITE_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: `status must be one of ${HELD_WRITE_STATUSES.join(', ')}` }, 400)
  }
  try {
    return c.json({ writes: await supabaseHeldWriteStore(createSupabaseClient(c.env)).list(orgId, status) })
  } catch (err) {
    return c.json({ error: formatErr(err) }, 500)
  }
})

admin.post('/held-writes/:id/replay', async (c) => {
  const { orgId, email } = c.get('user')
  const id = c.req.param('id')
  if (!UUID.test(id)) return c.json({ error: 'id must be the held write\'s uuid' }, 400)
  const parsed: unknown = await c.req.json().catch(() => ({}))
  const body = parsed !== null && typeof parsed === 'object' ? (parsed as { dryRun?: unknown }) : {}
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return c.json({ error: 'dryRun must be true or false' }, 400)
  const dryRun = body.dryRun !== false

  const supabase = createSupabaseClient(c.env)
  const keys = secretKeys(c.env)
  const store = supabaseHeldWriteStore(supabase)
  const deps = {
    store,
    keys,
    salesforce: async () => {
      const row = await store.get(orgId, id)
      if (!row) throw new Error('the held write is gone')
      return salesforcePortFor(c.env, supabase, keys, orgId, row.workflow_id)
    },
    // A write the Salesforce read-back holds is its own to resend (#468).
    readBackHolds: (executionId: string, stepNamespace: string) => readBackHoldsStep(c.env.IDEMPOTENCY, keys, executionId, stepNamespace),
  }
  try {
    if (dryRun) {
      const preview = await previewReplay(deps, orgId, id)
      if (preview.kind === 'preview') {
        await writeAuditLog(supabase, orgId, 'held_salesforce_write', id, 'held_write_replay_previewed', email ?? 'unknown', {
          execution_id: preview.execution_id,
          sf_object: preview.sf_object,
          sf_record_id: preview.sf_record_id,
          fields: preview.fields.map((f) => f.field),
          fields_changed_since: preview.fields.filter((f) => f.differs === true).map((f) => f.field),
        })
        return c.json({ dryRun: true, ...preview })
      }
      return c.json({ dryRun: true, ...preview }, preview.kind === 'not_found' ? 404 : preview.kind === 'not_replayable' ? 409 : 500)
    }
    const result = await replayHeldWrite(deps, orgId, id)
    if (result.kind === 'replayed' || result.kind === 'refused' || result.kind === 'still_pending') {
      await writeAuditLog(supabase, orgId, 'held_salesforce_write', id, 'held_write_replayed', email ?? 'unknown', {
        outcome: result.kind,
        recorded: result.recorded,
      })
    }
    const warning =
      'recorded' in result && !result.recorded
        ? 'The write landed in Salesforce, or was answered, but its row could not be updated, so it still reads pending. Replaying it again resends the same update.'
        : undefined
    return c.json({ dryRun: false, ...result, ...(warning ? { warning } : {}) }, REPLAY_STATUS[result.kind])
  } catch (err) {
    return c.json({ error: formatErr(err) }, 500)
  }
})

admin.post('/held-writes/:id/abandon', async (c) => {
  const { orgId, email } = c.get('user')
  const id = c.req.param('id')
  if (!UUID.test(id)) return c.json({ error: 'id must be the held write\'s uuid' }, 400)
  const parsed: unknown = await c.req.json().catch(() => ({}))
  const reason = parsed !== null && typeof parsed === 'object' ? (parsed as { reason?: unknown }).reason : undefined
  if (typeof reason !== 'string' || reason.trim() === '') return c.json({ error: 'reason is required: say how the write was dealt with' }, 400)
  const supabase = createSupabaseClient(c.env)
  try {
    const result = await abandonHeldWrite(supabaseHeldWriteStore(supabase), orgId, id)
    if (result.kind === 'abandoned') {
      await writeAuditLog(supabase, orgId, 'held_salesforce_write', id, 'held_write_abandoned', email ?? 'unknown', { reason: reason.trim() })
    }
    return c.json(result, result.kind === 'abandoned' ? 200 : result.kind === 'not_found' ? 404 : 409)
  } catch (err) {
    return c.json({ error: formatErr(err) }, 500)
  }
})

export default admin
