/**
 * The Stage A parity record (#1413, Phase 6): GET reads, POST refresh writes
 * the counts, POST sign off writes the sign off. Three routes, three verbs that
 * say what they do (L206): the plan's first draft had one GET that also
 * upserted, which is the inspection named tool that modifies data.
 *
 * Org scoped through the workflows the caller can see; the table itself is
 * Worker only, so RLS does not stand in for this check.
 */
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { dbError } from '../../lib/api-error'
import { createSupabaseClient } from '../../lib/supabase'
import { runBuyerSelectParityRefreshForEnv, type RefreshScope } from '../../lib/buyer-select-parity'

const parity = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Every parity row for the caller's organisation, newest day first. Reads only. */
parity.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const workflowId = c.req.query('workflow_id')
  if (workflowId !== undefined && !UUID.test(workflowId)) return c.json({ error: 'workflow_id_invalid' }, 400)
  let q = supabase
    .from('buyer_select_parity_days')
    .select('*')
    .eq('organization_id', orgId)
    .order('et_day', { ascending: false })
    .limit(400)
  if (workflowId) q = q.eq('workflow_id', workflowId)
  const { data, error } = await q
  if (error) return dbError(c, error)
  return c.json({ rows: data ?? [] })
})

/**
 * Recompute the rows for today and yesterday, or one named day and workflow.
 * A POST because it writes; it never sets a sign off, and a sign off whose
 * numbers move is cleared by the function that writes them (L641).
 */
parity.post('/refresh', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  // An empty or missing body means every one of the caller's workflows and every
  // refreshable day. Never another organisation's: the refresh writes rows and
  // names workflows in its answer, so the scope is the caller's (L18).
  const body = await c.req.json<{ workflow_id?: unknown; day?: unknown }>().catch(() => ({} as { workflow_id?: unknown; day?: unknown }))
  const only: RefreshScope = { organizationId: orgId }
  if (body.workflow_id !== undefined) {
    if (typeof body.workflow_id !== 'string' || !UUID.test(body.workflow_id)) return c.json({ error: 'workflow_id_invalid' }, 400)
    // The workflow must be the caller's; a refresh names a workflow by id, so the
    // scope is checked here rather than inherited from the table (L18).
    const { data: wf, error } = await supabase.from('workflows').select('id').eq('id', body.workflow_id).eq('organization_id', orgId).maybeSingle()
    if (error) return dbError(c, error)
    if (!wf) return c.json({ error: 'workflow_not_found' }, 404)
    only.workflowId = body.workflow_id
  }
  if (body.day !== undefined) {
    if (typeof body.day !== 'string' || !ISO_DATE.test(body.day)) return c.json({ error: 'day_invalid' }, 400)
    only.day = body.day
  }
  const summary = await runBuyerSelectParityRefreshForEnv(supabase, c.env, only)
  return c.json(summary, summary.errors.length > 0 ? 207 : 200)
})

/** A person signs off one day against the counts hash they saw. */
parity.post('/:workflow_id/:day/sign-off', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const workflowId = c.req.param('workflow_id')
  const day = c.req.param('day')
  if (!UUID.test(workflowId)) return c.json({ error: 'workflow_id_invalid' }, 400)
  if (!ISO_DATE.test(day)) return c.json({ error: 'day_invalid' }, 400)
  let body: { counts_hash?: unknown; note?: unknown }
  try {
    body = await c.req.json<{ counts_hash?: unknown; note?: unknown }>()
  } catch {
    return c.json({ error: 'body_invalid' }, 400)
  }
  if (typeof body.counts_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.counts_hash)) return c.json({ error: 'counts_hash_required' }, 400)
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : ''
  const { data, error } = await supabase.rpc('sign_off_buyer_select_parity_day', {
    p_workflow: workflowId,
    p_day: day,
    p_org: orgId,
    p_actor: userId,
    p_counts_hash: body.counts_hash,
    p_note: note,
  })
  if (error) {
    const e = error as { code?: string; message?: string; details?: string }
    // Two named refusals from the function (L11); the third, P0002, is a genuine
    // not found, and this route asked for one specific row by its own key so a
    // 404 is the truthful answer (db-guard-ok: parity_day_not_found names the row the caller addressed).
    if (e.code === 'BP409') return c.json({ error: 'counts_changed', current_counts_hash: e.details ?? null }, 409)
    if (e.code === 'BP422') return c.json({ error: e.message ?? 'refused' }, 422)
    if (e.code === 'P0002') return c.json({ error: 'parity_day_not_found' }, 404)
    return dbError(c, error)
  }
  return c.json({ row: data })
})

export default parity
