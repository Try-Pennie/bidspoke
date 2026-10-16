/**
 * The partner delete check (#2140, PM-13): everything a delete would remove,
 * what refuses it, and the workflows it would leave without the partner, read
 * before Delete is offered, so the box can say so up front.
 *
 * Its parts, each read once and joined here:
 *  - partner_delete_check (SQL): every table the delete touches or is refused
 *    by, from pg_constraint (partner_delete_dependents()), with row counts;
 *  - the partner's buyer ledger (a Durable Object): sales it has not yet written
 *    to buyer_sales, and sales waiting on a person, which the database cannot
 *    see and which a delete would strand (L38);
 *  - the organization's workflows (readOrgWorkflows, with updated_at), searched
 *    twice: for nodes naming the partner by id (partner-workflow-finder), and for
 *    reads of its Constants values by name (#2142's scanner).
 *
 * A failure of any part fails the whole check (L530): the box then offers no
 * field, never a partial answer read as complete. The Worker labels every table
 * from one file, partner-delete/labels/dependents.json; a dependent with no
 * label fails the check here, and the SQL suite fails on one first.
 */
import labels from '../partner-delete/labels/dependents.json'
import type { OrgWorkflow } from './org-workflows'
import { scanPartnerValueReaders } from './partner-workflow-values'
import { workflowsUsingPartner } from './partner-workflow-finder'
import type {
  DependentNoun,
  PartnerDeleteBlocker,
  PartnerDeleteCheck,
  PartnerDeleteFingerprint,
  PartnerDeleteReadingWorkflow,
  PartnerDeleteTable,
} from './partner-delete-shape'

export type * from './partner-delete-shape'

const NOUNS: Record<string, DependentNoun> = labels.tables

/** The words for one dependent table. Throws on a table with no label, so a new key fails loudly rather than rendering a raw table name. */
export function dependentNoun(table: string): DependentNoun {
  const noun = Object.prototype.hasOwnProperty.call(NOUNS, table) ? NOUNS[table] : undefined
  if (!noun) throw new Error(`the partner delete has no label for the dependent table ${table}; add it to apps/worker/src/partner-delete/labels/dependents.json`)
  return noun
}

/** One table as partner_delete_check answers it. */
export interface CheckDependent {
  table: string
  kind: 'blocks' | 'deleted' | 'cleared'
  rows: number
  blocking_rows: number
}

/** partner_delete_check's answer, validated. */
export interface CheckAnswer {
  partner: { id: string; name: string; slug: string; partner_type: string; is_active: boolean }
  dependents: CheckDependent[]
  secret: { name: string; other_partners: number } | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Reads partner_delete_check's jsonb. Throws on any other shape: a check that cannot be read is a failed check. */
export function parseCheckAnswer(data: unknown): CheckAnswer {
  if (!isRecord(data) || !isRecord(data.partner) || !Array.isArray(data.dependents)) {
    throw new Error('partner_delete_check answered in an unexpected shape')
  }
  const p = data.partner
  if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.slug !== 'string' || typeof p.partner_type !== 'string' || typeof p.is_active !== 'boolean') {
    throw new Error('partner_delete_check answered a partner in an unexpected shape')
  }
  const dependents = data.dependents.map((d): CheckDependent => {
    if (!isRecord(d) || typeof d.table !== 'string' || (d.kind !== 'blocks' && d.kind !== 'deleted' && d.kind !== 'cleared') || typeof d.rows !== 'number' || typeof d.blocking_rows !== 'number') {
      throw new Error('partner_delete_check answered a dependent in an unexpected shape')
    }
    return { table: d.table, kind: d.kind, rows: d.rows, blocking_rows: d.blocking_rows }
  })
  let secret: CheckAnswer['secret'] = null
  if (data.secret !== null && data.secret !== undefined) {
    const s = data.secret
    if (!isRecord(s) || typeof s.name !== 'string' || typeof s.other_partners !== 'number') throw new Error('partner_delete_check answered the secret in an unexpected shape')
    secret = { name: s.name, other_partners: s.other_partners }
  }
  return { partner: { id: p.id, name: p.name, slug: p.slug, partner_type: p.partner_type, is_active: p.is_active }, dependents, secret }
}

/** The buyer ledger's counts of what the database does not hold yet. */
export interface LedgerCounts {
  unmirrored: number
  unresolved: number
}

/** Where each part of the check is read from. Each throws on a failed read. */
export interface DeleteCheckSources {
  check: () => Promise<unknown>
  subAccountIds: (slug: string) => Promise<string[]>
  workflows: () => Promise<OrgWorkflow[]>
  /** The partners each buyer_select population sells to, read only when some workflow carries one. */
  pricedPartners: (workflows: OrgWorkflow[]) => Promise<ReadonlyMap<string, ReadonlySet<string>>>
  ledger: () => Promise<LedgerCounts>
}

/** The partner is not in the caller's organization (partner_delete_check's P0002): an answer, not a failure. */
export class PartnerNotFoundError extends Error {
  constructor(id: string) {
    super(`partner ${id} is not in this organization`)
    this.name = 'PartnerNotFoundError'
  }
}

/**
 * Reads every part and joins them. The SQL check goes first, so nothing else is
 * read for a partner it did not find in the organization (it throws
 * PartnerNotFoundError); the rest run in parallel. Throws when any part fails.
 */
export async function runDeleteCheck(sources: DeleteCheckSources): Promise<PartnerDeleteCheck> {
  const check = parseCheckAnswer(await sources.check())
  const [workflows, ledger, subAccountIds] = await Promise.all([sources.workflows(), sources.ledger(), sources.subAccountIds(check.partner.slug)])
  const priced = await sources.pricedPartners(workflows)
  return buildDeleteCheck(check, workflows, subAccountIds, priced, ledger)
}

/** The check from its parts. Pure, so each rule is tested on its own. */
export function buildDeleteCheck(
  check: CheckAnswer,
  workflows: readonly OrgWorkflow[],
  subAccountIds: readonly string[],
  pricedPartners: ReadonlyMap<string, ReadonlySet<string>>,
  ledger: LedgerCounts
): PartnerDeleteCheck {
  const blockers: PartnerDeleteBlocker[] = []
  const removes: PartnerDeleteTable[] = []
  for (const d of check.dependents) {
    // Labelled first, every table, rows or not: a missing label fails the check today, not on the day a row appears.
    const noun = dependentNoun(d.table)
    if (d.kind === 'blocks') {
      if (d.blocking_rows > 0) blockers.push({ kind: 'rows', table: d.table, rows: d.blocking_rows, noun })
    } else if (d.rows > 0) {
      removes.push({ table: d.table, kind: d.kind, rows: d.rows, noun })
    }
  }
  if (ledger.unmirrored > 0) blockers.push({ kind: 'ledger_unmirrored', count: ledger.unmirrored })
  if (ledger.unresolved > 0) blockers.push({ kind: 'ledger_unresolved', count: ledger.unresolved })

  const naming = workflowsUsingPartner(workflows, pricedPartners, { includeBuyerSelect: true, includeClickNodes: true })(check.partner.id)
  const activeById = new Map(workflows.map((w) => [w.id, w.is_active]))
  const workflows_naming_partner = naming.map((w) => ({ id: w.id, name: w.name, is_active: activeById.get(w.id) === true }))

  const reading = new Map<string, PartnerDeleteReadingWorkflow>()
  for (const value of scanPartnerValueReaders(workflows, { slug: check.partner.slug, subAccountIds })) {
    for (const r of value.readers) {
      const seen = reading.get(r.workflow_id) ?? { id: r.workflow_id, name: r.workflow_name, is_active: r.is_active, reads: 'every_partner' as const, values: [] }
      if (r.reads === 'by_name') seen.reads = 'by_name'
      if (!seen.values.includes(value.constant_name)) seen.values.push(value.constant_name)
      reading.set(r.workflow_id, seen)
    }
  }

  const fingerprint: PartnerDeleteFingerprint = {
    counts: Object.fromEntries(check.dependents.map((d) => [d.table, d.rows])),
    workflows: workflows.map((w) => ({ id: w.id, updated_at: w.updated_at })),
  }

  return {
    partner: check.partner,
    blockers,
    removes,
    workflows_naming_partner,
    workflows_reading_values: [...reading.values()],
    secret: check.secret,
    fingerprint,
  }
}

/** A fingerprint as the page sends it back, or null when it is not one. */
export function parseFingerprint(value: unknown): PartnerDeleteFingerprint | null {
  if (!isRecord(value) || !isRecord(value.counts) || !Array.isArray(value.workflows)) return null
  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(value.counts)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null
    counts[k] = v
  }
  const out: PartnerDeleteFingerprint['workflows'] = []
  for (const w of value.workflows) {
    if (!isRecord(w) || typeof w.id !== 'string' || typeof w.updated_at !== 'string') return null
    out.push({ id: w.id, updated_at: w.updated_at })
  }
  return { counts, workflows: out }
}

/** The blocker sentence parts, for the Worker's refusal message; the page composes its own from the same blockers. */
export function blockersSentence(name: string, blockers: readonly PartnerDeleteBlocker[]): string {
  const parts = blockers.map((b) => {
    if (b.kind === 'rows') return `${b.rows.toLocaleString('en-US')} ${b.rows === 1 ? `${b.noun.one} refers` : `${b.noun.many} refer`} to it`
    if (b.kind === 'ledger_unmirrored') return `${b.count.toLocaleString('en-US')} ${b.count === 1 ? 'sale is' : 'sales are'} not yet recorded`
    return `${b.count.toLocaleString('en-US')} ${b.count === 1 ? 'sale is' : 'sales are'} awaiting settlement`
  })
  return `${name} cannot be deleted: ${parts.join(', ')}.`
}
