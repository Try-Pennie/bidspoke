/**
 * Measures the partners page's workflow values fixture (#2142), the answer the
 * accessibility job gives the Workflow values tab for every partner.
 *
 * The route is not in production yet, so its answer cannot be captured the way
 * capture-partners.mjs captures the others. This builds it through the route's
 * own code (`workflowValuesAnswer`) from production's rows instead, READ ONLY:
 *
 * - the partners and their sub-account ids are the committed captures
 *   (apps/web/e2e/fixtures/partners/partners.json and partner-uuids.json), so the
 *   values the tab shows are the values every other tab of the scan shows;
 * - the workflows are a read only SELECT of the organization's workflows that
 *   are not soft deleted, saved by `supabase db query --output-format json`:
 *
 *     select id, name, is_active, organization_id, deleted_at, definition
 *     from workflows where organization_id = '<org>' and deleted_at is null order by name;
 *
 * Only the answer is written: workflow ids and names, node ids, namespaces and
 * labels, and the partner values already in partners.json. No definition text.
 *
 * Run (from apps/worker):
 *   npx tsx scripts/measure-workflow-values-e2e-fixture.ts <workflows.json from supabase db query>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { workflowValuesAnswer } from '../src/routes/api/partner-workflow-values'
import type { PartnerConstantsPartnerRow, PartnerConstantsUuidRow } from '../src/lib/partner-constants-loader'
import type { ScannableWorkflow } from '../src/lib/partner-workflow-values'

const [dump] = process.argv.slice(2)
if (!dump) throw new Error('usage: measure-workflow-values-e2e-fixture.ts <workflows.json>')

const FIXTURES = resolve(__dirname, '../../web/e2e/fixtures/partners')
const partners = JSON.parse(readFileSync(join(FIXTURES, 'partners.json'), 'utf8')) as Array<PartnerConstantsPartnerRow & { organization_id: string }>
const uuids = JSON.parse(readFileSync(join(FIXTURES, 'partner-uuids.json'), 'utf8')) as PartnerConstantsUuidRow[]

const raw = JSON.parse(readFileSync(dump, 'utf8')) as { rows?: Array<ScannableWorkflow & { organization_id: string; deleted_at: string | null }> }
if (!Array.isArray(raw.rows)) throw new Error(`${dump} carries no rows; save it with supabase db query --output-format json`)
const org = partners[0].organization_id
// Refused rather than filtered: the dump is meant to be exactly what readOrgWorkflows reads.
for (const w of raw.rows) {
  if (w.organization_id !== org || w.deleted_at !== null) throw new Error(`${w.id} is not a live workflow of ${org}; dump only what readOrgWorkflows reads`)
}
// In readOrgWorkflows' own order (by id), so the readers come in the order the route gives them.
const workflows: ScannableWorkflow[] = raw.rows
  .map((w) => ({ id: w.id, name: w.name, is_active: w.is_active, definition: w.definition }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const out: Record<string, unknown> = {}
for (const p of partners) {
  out[p.id] = workflowValuesAnswer(p, uuids.filter((u) => u.partner_slug === p.slug), workflows)
}
writeFileSync(join(FIXTURES, 'workflow-values.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`measure-workflow-values-e2e-fixture: wrote ${partners.length} answers over ${workflows.length} workflows`)
