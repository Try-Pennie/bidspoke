// Field coverage manifest + silence management (#423). Read-only manifest of what
// the silent-output detector watches per workflow (field + source + health),
// plus the silences and the code nodes it cannot statically read. jwtAuth; every
// handler verifies the workflow belongs to the caller's org.
import { Hono } from 'hono'
import { dbError, rowsTouched } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import { loadWorkflowDefinition } from '../../engine/definition-loader'
import { deriveWatchedFieldMap } from '../../engine/watched-fields'
import { findDroughts, classifyDeadFields, deadWindowStart, EVER_CARRIED_LOOKBACK_DAYS, type PresenceRow } from '../../lib/field-presence-anomaly'
import { fetchAllPaged } from '../../lib/paginate'

type Variables = AuthVariables
const fieldCoverage = new Hono<{ Bindings: Env; Variables: Variables }>()

async function ownedWorkflow(
  supabase: ReturnType<typeof createSupabaseClient>,
  workflowId: string,
  orgId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .maybeSingle()
  return !!data
}

// The dead alert's own lookback (#2018), so the manifest and the alert read the
// same rows through the same classifier and cannot disagree about a field.
const COVERAGE_WINDOW_DAYS = EVER_CARRIED_LOOKBACK_DAYS

fieldCoverage.get('/:workflowId', async (c) => {
  const workflowId = c.req.param('workflowId')
  const orgId = c.get('user').orgId
  const supabase = createSupabaseClient(c.env)

  if (!(await ownedWorkflow(supabase, workflowId, orgId))) {
    return c.json({ error: 'Workflow not found' }, 404)
  }

  const loaded = await loadWorkflowDefinition(workflowId, c.env.WORKFLOW_CACHE, supabase, {
    allowInactive: true,
  })
  const map = deriveWatchedFieldMap(loaded.definition)

  const since = new Date(Date.now() - COVERAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  let rollupRows: Record<string, unknown>[]
  try {
    rollupRows = await fetchAllPaged<Record<string, unknown>>(
      (from, to) =>
        supabase
          .from('field_presence_daily')
          .select('workflow_id, field_path, day, ran_count, present_count, key_present_count, key_measured_count')
          .eq('workflow_id', workflowId)
          .gte('day', since)
          .eq('is_test', false)
          .order('day', { ascending: true })
          .order('field_path', { ascending: true })
          .range(from, to),
      'field_presence_daily',
    )
  } catch (e) {
    return dbError(c, e)
  }
  const rows: PresenceRow[] = rollupRows.map((r) => ({
    workflow_id: r.workflow_id as string,
    field_path: r.field_path as string,
    day: r.day as string,
    ran_count: Number(r.ran_count),
    present_count: Number(r.present_count),
    // Default 0, so a row without them carries no key evidence rather than a NaN.
    key_present_count: r.key_present_count == null ? 0 : Number(r.key_present_count),
    key_measured_count: r.key_measured_count == null ? 0 : Number(r.key_measured_count),
  }))

  const droughtFields = new Set(findDroughts(rows, today).map((h) => h.field_path))
  const verdicts = classifyDeadFields(rows, { windowStart: deadWindowStart(rows) })
  const alerting = (list: { field_path: string; verdict: string }[]) =>
    new Set(list.filter((s) => s.verdict === 'alerting').map((s) => s.field_path))
  const deadFields = alerting(verdicts.dead)
  const wrongPathFields = alerting(verdicts.wrongPath)
  const byDesignFields = new Set(verdicts.byDesign.map((s) => s.field_path))
  const latestByField = new Map<string, PresenceRow>()
  for (const r of rows) {
    const prev = latestByField.get(r.field_path)
    if (!prev || r.day > prev.day) latestByField.set(r.field_path, r)
  }

  const { data: silenceRows } = await supabase
    .from('field_presence_silences')
    .select('field_path, reason, created_at')
    .eq('workflow_id', workflowId)

  const fields = map.fields.map((f) => {
    const latest = latestByField.get(f.path)
    const health = latest
      ? {
          latest_day: latest.day,
          ran: latest.ran_count,
          present: latest.present_count,
          rate: latest.ran_count > 0 ? latest.present_count / latest.ran_count : 0,
          drought: droughtFields.has(f.path),
          dead: deadFields.has(f.path),
          wrong_path: wrongPathFields.has(f.path),
          empty_by_design: byDesignFields.has(f.path),
        }
      : null
    return { path: f.path, source: f.source, health }
  })

  return c.json({
    workflow_id: workflowId,
    fields,
    unreadable_nodes: map.unreadableNodes,
    // Nodes that alias a steps reference into a local the scanner could not
    // follow, so their watched set may be incomplete (#435). Reported
    // separately from unreadable_nodes because it is a milder statement: the
    // node IS scanned, some of its reads just cannot be attributed.
    alias_only_nodes: map.aliasOnlyNodes,
    silences: (silenceRows ?? []).map((s) => ({
      field_path: s.field_path as string,
      reason: s.reason as string,
      created_at: s.created_at as string,
    })),
  })
})

// Silence a (workflow, field): the detector skips it because the field is
// legitimately allowed to be empty. reason is required so the manifest can show
// why. Upsert so re-silencing the same field updates the reason in place.
fieldCoverage.post('/:workflowId/silence', async (c) => {
  const workflowId = c.req.param('workflowId')
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  if (!(await ownedWorkflow(supabase, workflowId, orgId))) {
    return c.json({ error: 'Workflow not found' }, 404)
  }
  const body = await c.req.json<{ field?: string; reason?: string }>().catch(() => null)
  if (!body?.field || !body?.reason) {
    return c.json({ error: 'field and reason are required' }, 400)
  }
  const { error } = await supabase
    .from('field_presence_silences')
    .upsert(
      { workflow_id: workflowId, field_path: body.field, reason: body.reason, created_by: email },
      { onConflict: 'workflow_id,field_path' },
    )
  if (error) return dbError(c, error)
  await writeAuditLog(supabase, orgId, 'field_presence_silence', `${workflowId}:${body.field}`, 'field_silence_set', userId, {
    field: body.field,
    reason: body.reason,
  })
  return c.json({ ok: true })
})

fieldCoverage.delete('/:workflowId/silence', async (c) => {
  const workflowId = c.req.param('workflowId')
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  if (!(await ownedWorkflow(supabase, workflowId, orgId))) {
    return c.json({ error: 'Workflow not found' }, 404)
  }
  const body = await c.req.json<{ field?: string }>().catch(() => null)
  if (!body?.field) {
    return c.json({ error: 'field is required' }, 400)
  }
  const field = body.field
  // Clearing a silence that was never set is a no-op, so this stays 200. The
  // table has no organization_id column: ownedWorkflow() above is what scopes
  // it. Only the audit row is gated on the rows actually removed (#588).
  const { rows, blocked } = await rowsTouched(c, 'field_presence_silences.clear', () =>
    supabase.from('field_presence_silences').delete().eq('workflow_id', workflowId).eq('field_path', field).select('field_path')
  )
  if (blocked) return blocked
  if (rows.length > 0) {
    await writeAuditLog(supabase, orgId, 'field_presence_silence', `${workflowId}:${field}`, 'field_silence_cleared', userId, {
      field,
    })
  }
  return c.json({ ok: true })
})

export default fieldCoverage
