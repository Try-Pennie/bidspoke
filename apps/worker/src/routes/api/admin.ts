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
  upsertPerson,
} from '../../engine/lead-sightings'
import { formatSsn } from '../../engine/persons-crypto'
import { runSightingsExport } from '../../lib/sightings-export'
import { runAchieveExport } from '../../lib/achieve-export'
import { formatErr } from '../../lib/format-error'

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
 * One-shot backfill of lead_sightings + lead_sighting_bids + persons from
 * historical workflow_executions and execution_steps. Writes through Supabase
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

      // persons upsert (best-effort — null person_id is fine if it fails)
      let personId: string | null = null
      if (personFields) {
        personId = await upsertPerson(
          supabase,
          { organization_id: orgId, ...personFields },
          c.env.SECRET_ENCRYPTION_KEY,
          c.env.SSN_HASH_PEPPER,
        )
      }

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
      const filterPassed = terminalNode?.type === 'filter' && lastStep
        ? Boolean((lastStep.output as { passed?: unknown } | null)?.passed) : null
      const bidRoute = terminalNode?.type === 'bid_group' && lastStep
        ? ((lastStep.output as { _route?: string } | null)?._route ?? null) : null
      const terminalHandle =
        terminalNode?.type === 'filter' && filterPassed === false ? 'exit'
        : terminalNode?.type === 'filter' && filterPassed === true ? 'pass'
        : terminalNode?.type === 'bid_group' && bidRoute ? bidRoute
        : null

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
        person_id: personId,
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

export default admin
