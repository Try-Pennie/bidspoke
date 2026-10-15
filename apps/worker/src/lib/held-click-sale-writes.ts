/**
 * The Salesforce updates for a held click a person marked sent (#1659).
 *
 * When buyer_click_send holds a click, the click workflow's click_patch writes
 * nothing, because nobody knew whether the buyer had the lead. Once a person
 * confirms it in the buyer's system and presses Mark sent, the Prospect,
 * Submission and Lead must say what a live `sent` click would have said. This
 * writes exactly that:
 *
 *   bodies    buildClickSaleUpdates (the one builder, held byte for byte to the
 *             kept click_patch script by its test), Completed, with the lead id
 *             the person entered (or none, #2139), the time the click was HELD (when the buyer
 *             received it, not when the person got round to it), and PDFlow_3__c
 *             as the held run's Bidspoke link.
 *   terms     the partner name and routing code from the buyer's partner record,
 *             the consent text and lead sale type from the buyer's kept
 *             click_patch script (see click-sale-updates.ts for why).
 *   records   the ids the held run's own record step named (pick_record in the
 *             Liberty1 workflow): the step whose output carries this claim's
 *             sale_key and the prospect_id, submission_id and lead_id fields.
 *             The live flow writes each record only when that id is present,
 *             and so does this.
 *
 * WHERE THE RECORD IDS COME FROM PAST SEVEN DAYS. Step rows are purged after
 * seven days while a claim can stay held for good. The execution archive keeps
 * every run's full steps for thirteen months (#874), so an empty step log is
 * read from the archive instead, which is the same record step with the same
 * ids. Querying Salesforce for "the Submission of this Prospect" was considered
 * and rejected: one prospect can have several submissions, and a guess would
 * write a sale onto a submission the click was not for. When neither source
 * answers, nothing is written and every record says why, and the person can
 * retry from the page.
 *
 * Every write is reported on its own (written, failed with Salesforce's reason,
 * not named by the click, or not attempted with the reason), so one refusal
 * never hides the other two (L73). The updates are the same bodies every time,
 * so running this twice is safe.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { bidspokeRunLink } from '../engine/context'
import { buildClickSaleUpdates, clickPatchScriptFor, clickScriptTerms, type ClickSaleTerms } from './click-sale-updates'
import { readArchivedExecution, type ArchivedExecutionRead } from './archive-read'
import { salesforceUpdate } from './salesforce-write'
import type { SaleRecord, SaleWrite, SaleWrites } from '@bidspoke/buyer-profile'

// The report's shape is the package's, so the partner page reads the same type (L83).
export type { SaleRecord, SaleWrite, SaleWrites }

export interface HeldClickForSale {
  partner_id: string
  prospect_id: string
  workflow_id: string | null
  execution_id: string
  held_at: string
}

interface StepLike {
  step_namespace?: unknown
  output?: unknown
}

export interface HeldClickSaleDeps {
  loadPartner: (supabase: SupabaseClient, orgId: string, partnerId: string) => Promise<{ ok: true; partner: { name: string; external_routing_code: number | null } | null } | { ok: false; message: string }>
  loadSteps: (supabase: SupabaseClient, executionId: string, heldAt: string) => Promise<{ ok: true; steps: StepLike[] } | { ok: false; message: string }>
  readArchive: (env: Env, supabase: SupabaseClient, opts: { executionId: string; orgId: string; readBy: string }) => Promise<ArchivedExecutionRead>
  update: typeof salesforceUpdate
}

const RECORDS: ReadonlyArray<{ record: SaleRecord; object: string; idField: 'prospect_id' | 'submission_id' | 'lead_id' }> = [
  { record: 'prospect', object: 'Prospect__c', idField: 'prospect_id' },
  { record: 'submission', object: 'Submission__c', idField: 'submission_id' },
  { record: 'lead', object: 'Lead', idField: 'lead_id' },
]

const PURPOSE = 'a held click marked sent'

/** A window around the hold wide enough for the run that recorded it, narrow enough to prune the daily step partitions. */
const STEP_WINDOW_MS = 60 * 60 * 1000

const defaultDeps: HeldClickSaleDeps = {
  async loadPartner(supabase, orgId, partnerId) {
    const { data, error } = await supabase.from('partner_configs').select('name, external_routing_code').eq('id', partnerId).eq('organization_id', orgId).maybeSingle()
    if (error) return { ok: false, message: `the buyer's partner record could not be read: ${error.message}` }
    return { ok: true, partner: data ?? null }
  },
  async loadSteps(supabase, executionId, heldAt) {
    const at = Date.parse(heldAt)
    // paginate-ok: one execution's steps, a few dozen at most
    const { data, error } = await supabase
      .from('execution_steps')
      .select('step_namespace, output')
      .eq('execution_id', executionId)
      .gte('started_at', new Date(at - STEP_WINDOW_MS).toISOString())
      .lte('started_at', new Date(at + STEP_WINDOW_MS).toISOString())
    if (error) return { ok: false, message: `the run's step log could not be read: ${error.message}` }
    return { ok: true, steps: data ?? [] }
  },
  readArchive: (env, supabase, opts) => readArchivedExecution(env, supabase, opts),
  update: salesforceUpdate,
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The record step of the held run: the one output naming this claim's sale key and the three record ids. */
function recordsFor(steps: readonly unknown[], saleKey: string): Record<'prospect_id' | 'submission_id' | 'lead_id', string | null> | null {
  for (const step of steps) {
    const output = (step as StepLike | null)?.output
    if (!output || typeof output !== 'object' || Array.isArray(output)) continue
    const o = output as Record<string, unknown>
    if (o.sale_key !== saleKey || !('prospect_id' in o) || !('submission_id' in o) || !('lead_id' in o)) continue
    return {
      prospect_id: isId(o.prospect_id) ? o.prospect_id : null,
      submission_id: isId(o.submission_id) ? o.submission_id : null,
      lead_id: isId(o.lead_id) ? o.lead_id : null,
    }
  }
  return null
}

/** Every record not attempted, for one reason. Exported so a caller reports an unexpected throw the same way. */
export function notAttempted(message: string, recordsFrom: SaleWrites['records_from'] = null): SaleWrites {
  return { complete: false, records_from: recordsFrom, writes: RECORDS.map(({ record, object }) => ({ record, object, id: null, outcome: 'not_attempted', message })) }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'non Error thrown'
}

async function termsFor(supabase: SupabaseClient, orgId: string, row: HeldClickForSale, deps: HeldClickSaleDeps): Promise<{ ok: true; terms: ClickSaleTerms } | { ok: false; message: string }> {
  const script = clickPatchScriptFor(row.workflow_id)
  if (!script) return { ok: false, message: "Bidspoke keeps no click_patch script for this click's workflow, so the buyer's consent text is not known" }
  const read = clickScriptTerms(script)
  if (!read.ok) return read
  const loaded = await deps.loadPartner(supabase, orgId, row.partner_id)
  if (!loaded.ok) return loaded
  if (!loaded.partner) return { ok: false, message: "the buyer's partner record was not found" }
  if (loaded.partner.external_routing_code === null) return { ok: false, message: "the buyer's partner record has no routing code, so the sale cannot say which buyer it went to" }
  return { ok: true, terms: { partnerName: loaded.partner.name, routingCode: loaded.partner.external_routing_code, ...read.terms } }
}

/**
 * `buyerLeadId` is null when the person marked the click sent without one
 * (PM-7, #2139): the sale is still Completed on every record, and the lead id
 * fields are left out rather than blanked. The result names the lead id it was
 * written with, so the list can tell when the claim's id has since changed.
 */
export async function writeHeldClickSale(
  env: Env,
  supabase: SupabaseClient,
  input: { orgId: string; userId: string; row: HeldClickForSale; buyerLeadId: string | null },
  deps: Partial<HeldClickSaleDeps> = {},
): Promise<SaleWrites> {
  const result = await writeSaleRecords(env, supabase, input, { ...defaultDeps, ...deps })
  return { ...result, buyer_lead_id: input.buyerLeadId }
}

async function writeSaleRecords(
  env: Env,
  supabase: SupabaseClient,
  input: { orgId: string; userId: string; row: HeldClickForSale; buyerLeadId: string | null },
  d: HeldClickSaleDeps,
): Promise<SaleWrites> {
  const { row } = input

  const heldMs = Date.parse(row.held_at)
  if (!Number.isFinite(heldMs)) return notAttempted(`the time the click was held (${row.held_at}) is not a time`)

  const terms = await termsFor(supabase, input.orgId, row, d)
  if (!terms.ok) return notAttempted(terms.message)

  // The step log first; an EMPTY log means the rows were purged, and the archive holds them. A failed read is not a purge.
  let steps: readonly unknown[]
  let recordsFrom: 'step_log' | 'archive'
  const live = await d.loadSteps(supabase, row.execution_id, row.held_at)
  if (!live.ok) return notAttempted(live.message)
  if (live.steps.length > 0) {
    steps = live.steps
    recordsFrom = 'step_log'
  } else {
    const archived = await d.readArchive(env, supabase, { executionId: row.execution_id, orgId: input.orgId, readBy: input.userId })
    if (archived.kind === 'unavailable') return notAttempted(`the run's steps are past the seven day log and ${archived.waitingFor} did not answer: ${archived.detail}`)
    if (archived.kind === 'not-found') return notAttempted(`the run ${row.execution_id} is in neither the step log nor the execution archive, so which records the click was for is not known`)
    steps = archived.steps
    recordsFrom = 'archive'
  }

  const ids = recordsFor(steps, row.prospect_id)
  if (!ids) return notAttempted(`the run ${row.execution_id} names no records for ${row.prospect_id}`, recordsFrom)

  const bodies = buildClickSaleUpdates(terms.terms, {
    exchangeStatus: 'Completed',
    partnerLeadId: input.buyerLeadId,
    timestamp: new Date(heldMs).toISOString(),
    runLink: bidspokeRunLink(env.APP_URL, row.workflow_id, row.execution_id),
  })

  // One at a time, in the live flow's order, each with its own outcome.
  const writes: SaleWrite[] = []
  for (const { record, object, idField } of RECORDS) {
    const id = ids[idField]
    if (!id) {
      writes.push({ record, object, id: null, outcome: 'not_named' })
      continue
    }
    try {
      await d.update(env, supabase, input.orgId, object, id, bodies[record], PURPOSE)
      writes.push({ record, object, id, outcome: 'written' })
    } catch (err) {
      const message = messageOf(err)
      console.error(`[held-clicks] Salesforce ${object} ${id} update failed: ${message}`)
      writes.push({ record, object, id, outcome: 'failed', message })
    }
  }
  return { complete: writes.every((w) => w.outcome === 'written' || w.outcome === 'not_named'), records_from: recordsFrom, writes }
}
