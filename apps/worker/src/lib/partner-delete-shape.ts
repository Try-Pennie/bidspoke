/**
 * The shape of the partner delete check and the delete's answers (#2140), with
 * no imports, so the web's guard can hold the page's copy of each type to this
 * one without compiling the Worker (as workflow-values-shape.ts does for #2142).
 *
 * The logic is lib/partner-delete.ts; the routes are routes/api/partner-delete.ts.
 */

/** The noun for one row of a table and for any other count, from apps/worker/src/partner-delete/labels/dependents.json. */
export interface DependentNoun {
  one: string
  many: string
}

/** One table a delete removes rows from (`deleted`), or leaves rows in with their link cleared (`cleared`, a SET NULL key). */
export interface PartnerDeleteTable {
  table: string
  kind: 'deleted' | 'cleared'
  rows: number
  noun: DependentNoun
}

/**
 * What refuses the delete: rows a RESTRICT key holds (sales, held clicks), and
 * the buyer ledger's own count of sales it has not yet written to the database
 * (`ledger_unmirrored`) or that wait on a person (`ledger_unresolved`), which
 * the database cannot see.
 */
export type PartnerDeleteBlocker =
  | { kind: 'rows'; table: string; rows: number; noun: DependentNoun }
  | { kind: 'ledger_unmirrored'; count: number }
  | { kind: 'ledger_unresolved'; count: number }

export interface PartnerDeleteWorkflow {
  id: string
  name: string
  is_active: boolean
}

/** A workflow reading one of the partner's Constants values (#2142's scanner). */
export interface PartnerDeleteReadingWorkflow extends PartnerDeleteWorkflow {
  /** `by_name` when it names this partner's value; `every_partner` when it reads a whole map, so it reads nothing for this partner afterwards rather than breaking. */
  reads: 'by_name' | 'every_partner'
  /** The Constants names it reads, as the node emits them. */
  values: string[]
}

/**
 * What the reviewed consequence was read from, sent back with the delete:
 * delete_partner_config refuses (BP024) when either part moved. counts holds
 * every dependent table, zeros included; workflows is every workflow of the
 * organization the scanner read, with updated_at as the database answered it.
 */
export interface PartnerDeleteFingerprint {
  counts: Record<string, number>
  workflows: Array<{ id: string; updated_at: string }>
}

/** GET /api/partners/:id/delete-check */
export interface PartnerDeleteCheck {
  partner: { id: string; name: string; slug: string; partner_type: string; is_active: boolean }
  /** Empty when the delete may go ahead. */
  blockers: PartnerDeleteBlocker[]
  /** The tables with rows the delete removes or unlinks; empty tables are left out. */
  removes: PartnerDeleteTable[]
  /** Workflows with a node naming the partner by id, or a buyer_select node that sells to it. */
  workflows_naming_partner: PartnerDeleteWorkflow[]
  /** Workflows reading one of its Constants values by name, or a whole map holding its entry. */
  workflows_reading_values: PartnerDeleteReadingWorkflow[]
  /** The Worker secret its cf_secret_key names, which a delete never removes, and how many other partners name it. */
  secret: { name: string; other_partners: number } | null
  fingerprint: PartnerDeleteFingerprint
}

/** DELETE /api/partners/:id, when it committed. */
export interface PartnerDeleted {
  ok: true
  /** A stored copy of the partner could not be cleared (copyWarning, COPY_NOT_CLEARED_MESSAGE). */
  stored_copy_warning?: string
  /** Today's lead count or the error breaker, kept under the slug, could not be reset. */
  state_reset_warning?: string
}

/** DELETE /api/partners/:id, when it refused and nothing was deleted. */
export interface PartnerDeleteRefused {
  error: 'blocked' | 'consequence_changed'
  message: string
  /** The check as it stands now, for the box to show; null when it could not be read again. */
  check: PartnerDeleteCheck | null
}
