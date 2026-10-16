/**
 * The partners page's workflow values tab (#2142, PM-15), mounted under
 * /partners beside the partner routes:
 *
 *   GET /partners/:id/workflow-values
 *
 * Every value the Constants node emits for the partner (its click URL, sell off
 * offer, sub-account minimum bids, and its entries in activeBidding and
 * subAccountIdsMap), each with the value as the node would emit it now, how a
 * template and a Code node read it, the workflows that read it (from the one
 * scanner, lib/partner-workflow-values.ts, which the delete check, #2140, is to call too),
 * any workflow data key it shadows, and for the click URL the readers outside
 * workflows.
 *
 * Who may call it: any signed in, allowlisted member of the organization (the
 * jwtAuth middleware on /api), the same as every partner route. Whose data: the
 * Worker is service_role, so every read filters the caller's organization
 * itself: the partner by id and organization (another organization's partner is
 * a 404), its sub-account ids by organization and slug, and the workflows
 * through readOrgWorkflows (organization, not soft deleted). Read only.
 *
 * A failed read is a failed answer (500), never an empty list: an empty list
 * says no workflow reads the value, which the page states as a fact.
 */
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { fetchAllPaged } from '../../lib/paginate'
import { readOrgWorkflows } from '../../lib/org-workflows'
import { isUuid } from '../../lib/query-validators'
import { partnerConstantsFromRows, type PartnerConstantsPartnerRow, type PartnerConstantsUuidRow } from '../../lib/partner-constants-loader'
import { partnerConstantOutput } from '../../engine/nodes/constants'
import { CLICK_URL_READERS_OUTSIDE_WORKFLOWS, carriesConstantsNode, scanPartnerValueReaders, type ScannableWorkflow } from '../../lib/partner-workflow-values'
import type { WorkflowValue, WorkflowValuesAnswer } from '../../lib/workflow-values-shape'

const workflowValues = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

workflowValues.get('/:id/workflow-values', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  // A malformed id names no partner: a 404 before any read, as the usage route answers it, never Postgres' 500.
  if (!isUuid(id)) return c.json({ error: 'Partner not found' }, 404)
  const supabase = createSupabaseClient(c.env)

  const { data: partner, error } = await supabase
    .from('partner_configs')
    .select('id, slug, sell_off_offer_title, sell_off_offer_details, click_url, is_active, sub_account_min_bids')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!partner) return c.json({ error: 'Partner not found' }, 404)
  const row = partner as PartnerConstantsPartnerRow

  let uuidRows: PartnerConstantsUuidRow[]
  let workflows
  try {
    ;[uuidRows, workflows] = await Promise.all([
      fetchAllPaged<PartnerConstantsUuidRow>(
        (from, to) =>
          supabase
            .from('partner_uuid_map')
            .select('uuid, partner_slug')
            .eq('org_id', orgId)
            .eq('partner_slug', row.slug)
            .order('id', { ascending: true })
            .range(from, to),
        `sub-account ids of partner ${row.slug}`,
        { maxPages: 20 }
      ),
      readOrgWorkflows(supabase, orgId),
    ])
  } catch (err) {
    return dbError(c, err)
  }

  return c.json(workflowValuesAnswer(row, uuidRows, workflows))
})

/**
 * The answer, from the rows the route read: the partner, its sub-account ids and
 * the organization's workflows. Pure, so the e2e fixture's measurement
 * (apps/worker/scripts/measure-workflow-values-e2e-fixture.ts) builds it from
 * production's rows through exactly this code.
 */
export function workflowValuesAnswer(
  row: PartnerConstantsPartnerRow,
  uuidRows: readonly PartnerConstantsUuidRow[],
  workflows: readonly ScannableWorkflow[]
): WorkflowValuesAnswer {
  const emitted = partnerConstantOutput(partnerConstantsFromRows(uuidRows, [row]))
  const subAccountIds = uuidRows.map((u) => u.uuid)
  const scan = scanPartnerValueReaders(workflows, { slug: row.slug, subAccountIds })

  const values: WorkflowValue[] = scan.map((v) => {
    let value: unknown
    let isEmitted: boolean
    if (v.kind === 'activeBidding') {
      const entries = emitted.activeBidding as Record<string, boolean>
      isEmitted = Object.prototype.hasOwnProperty.call(entries, row.slug)
      value = isEmitted ? entries[row.slug] : null
    } else if (v.kind === 'subAccountIdsMap') {
      // The node emits the map whole; this partner's part is the entries mapping to its slug.
      const entries = Object.fromEntries(
        Object.entries(emitted.subAccountIdsMap as Record<string, string>).filter(([, slug]) => slug === row.slug)
      )
      isEmitted = Object.keys(entries).length > 0
      value = entries
    } else {
      isEmitted = Object.prototype.hasOwnProperty.call(emitted, v.constant_name)
      value = isEmitted ? emitted[v.constant_name] : null
    }
    return {
      ...v,
      emitted: isEmitted,
      value,
      readers_outside_workflows: v.kind === 'ClickUrl' ? CLICK_URL_READERS_OUTSIDE_WORKFLOWS.map((r) => ({ reader: r.reader, description: r.description })) : [],
    }
  })

  const withConstants = workflows.filter(carriesConstantsNode).length

  return {
    partner: { id: row.id, slug: row.slug },
    values,
    searched: { workflows: workflows.length, with_constants_node: withConstants },
  }
}

export default workflowValues
