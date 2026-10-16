/**
 * The shape of the workflow values answer (#2142) and the click URL's readers
 * outside workflows, with no imports, so the web's guards can hold the page's
 * copy of the type to this one without compiling the Worker.
 *
 * The scanner is lib/partner-workflow-values.ts; the route is
 * routes/api/partner-workflow-values.ts.
 */

/** The kinds the Constants node emits per partner (PARTNER_CONSTANT_KINDS) and its two maps (PARTNER_CONSTANT_MAPS). */
export type PartnerValueKind = 'ClickUrl' | 'SellOffOfferTitle' | 'SellOffOfferDetails' | 'SubAccountMinBids' | 'subAccountIdsMap' | 'activeBidding'

export interface PartnerValueName {
  /** The name the Constants node emits the value under. */
  constant_name: string
  kind: PartnerValueKind
  /** One of the two maps holding every partner's entry; this partner's value is its entry in it. */
  map: boolean
  /** How a template and a Code node read it, in the form the Engine Bidding mirror writes. */
  access: { template: string; code: string }
}

/** `by_name`: names this partner's value, or its entry in a map. `every_partner`: reads it for every partner at once. */
export type ReadHow = 'by_name' | 'every_partner'

export interface ReadingPlace {
  /** The node whose config or script reads it, or null when an edge condition does. */
  node_id: string | null
  namespace: string | null
  label: string | null
  node_type: string | null
  /** The edge whose condition reads it, or null when a node does. */
  edge_id: string | null
  reads: ReadHow
}

export interface ReadingWorkflow {
  workflow_id: string
  workflow_name: string
  is_active: boolean
  /** `by_name` when any place names this partner's value, else `every_partner`. */
  reads: ReadHow
  places: ReadingPlace[]
}

/** A workflow data key with the same name as a partner key: the node emits the partner value in its place. */
export interface ShadowedDataKey {
  workflow_id: string
  workflow_name: string
  is_active: boolean
  node_id: string
  namespace: string
}

export interface PartnerValueReaders extends PartnerValueName {
  readers: ReadingWorkflow[]
  shadowed_data_keys: ShadowedDataKey[]
}

export interface WorkflowValue extends PartnerValueReaders {
  /** Whether the Constants node emits it now: a flat value only when set, a map entry only when present. */
  emitted: boolean
  /** As the node emits it: the flat value, or this partner's part of a map: its entry in activeBidding, its id to slug entries in subAccountIdsMap. */
  value: unknown
  readers_outside_workflows: Array<{ reader: string; description: string }>
}

/** GET /api/partners/:id/workflow-values */
export interface WorkflowValuesAnswer {
  partner: { id: string; slug: string }
  values: WorkflowValue[]
  /** What was searched, so an empty reader list can be stated as what it measured. */
  searched: { workflows: number; with_constants_node: number }
}

/**
 * Where a partner's click URL is read outside any workflow: the engine reads
 * it through the buyer profile loader for a partner sold through a buyer
 * profile, not through the Constants node, so no workflow scan finds these.
 * `__guards__/worker/click-url-readers.test.ts` (apps/web) pins this list
 * against every Worker file that names the column.
 */
export const CLICK_URL_READERS_OUTSIDE_WORKFLOWS = [
  {
    reader: 'buyer_select',
    file: 'engine/nodes/buyer-select.ts',
    description: 'Buyer selection sends a lead it sells to this partner to the click URL.',
  },
  {
    reader: 'buyer_click_check',
    file: 'engine/nodes/buyer-click-check.ts',
    description: 'The click check offers a lead to a click sold partner at the click URL, and refuses to when it carries no {prospect_id}.',
  },
  {
    reader: 'click_alert',
    file: 'lib/buyer-click-alert.ts',
    description: 'The click alert pages when the click URL carries no {prospect_id}.',
  },
] as const
