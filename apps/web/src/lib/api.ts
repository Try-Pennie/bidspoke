import { createClient } from './supabase/client'
import type { Workflow, WorkflowSummary, WorkflowDef, WorkflowVersion, EnvVar, Folder, EnvVarFolder } from '@/types/workflow'
import type { PartnerType } from './partner-roles'
import type { LiveMissReportBody, PartnerPageVersions } from '@bidspoke/partner-page-live'
import type { PartnerHistory } from '@bidspoke/partner-history'
import { holdAuthRedirect } from './leave-guard'

export type { PartnerType }

export type BidResolverType = 'formula' | 'matrix' | 'api'
export type BidComparisonSource = 'auto' | 'api' | 'formula' | 'matrix'

export type ExtraExtractionSpec =
  | string
  | { path?: string; classifier?: string }

export type ExtraExtractionConfig = Record<string, ExtraExtractionSpec>

import type { BuyerProfileDocument, SaleWrites, SalesforceStanding, SalesforceWritesView } from '@bidspoke/buyer-profile'

export interface Partner {
  id: string
  organization_id: string
  name: string
  slug: string
  api_endpoint: string | null
  cf_secret_key: string | null
  daily_cap: number | null
  min_bid: number | null
  bid_formula: string | null
  bid_resolver_type: BidResolverType
  bid_resolver_config: Record<string, unknown>
  outbound_field_mapping: Record<string, unknown> | null
  bid_comparison_source: BidComparisonSource
  extra_extraction: ExtraExtractionConfig | null
  last_probe_response: unknown
  dedup_endpoint: string | null
  response_classification: unknown
  /** The buyer_select accept rules, the shared Signal shape (#1412). */
  accept_signals?: unknown[] | null
  /** Decline answers that mean the buyer already holds the lead, recorded as Duplicate (#1416). Same Signal shape. */
  duplicate_signals?: unknown[] | null
  /** The Salesforce routing code the prospect patch carries for a sale to this buyer (#1416). */
  external_routing_code?: number | null
  alert_config: unknown
  circuit_error_threshold: number
  circuit_window_seconds: number
  circuit_cooldown_seconds: number
  circuit_enabled: boolean
  confirmation_window_ms: number | null
  is_active: boolean
  priority: number
  sell_off_offer_title: string | null
  sell_off_offer_details: string | null
  click_url: string | null
  sub_account_min_bids: Record<string, number> | null
  partner_type: PartnerType
  /**
   * A declared credential the environment cannot supply (#416). Derived per
   * response by the worker rather than stored, so it is always current, and null
   * means "checked, nothing owed" rather than "not checked".
   */
  credential_warning?: string | null
  created_at: string
  updated_at: string
  updated_by_email: string | null
  updated_by_name: string | null
  /**
   * Moved by the database on every change (#2132). A save names the version it
   * was edited from, and a newer one refuses it. Absent only on a row read from
   * a Worker older than the versioned save.
   */
  version?: number
  /** The save press that last wrote the row (#2132). */
  last_save_id?: string | null
}

/**
 * The fields a partner save may name: the row less its identity, its
 * bookkeeping and what the Worker derives. bid_mode is not a Partner field
 * at all since #2182: nothing reads it, and the Worker refuses a save naming it.
 */
export type PartnerBody = Partial<Omit<Partner, 'id' | 'organization_id' | 'created_at' | 'updated_at' | 'updated_by_email' | 'updated_by_name' | 'credential_warning' | 'version' | 'last_save_id'>>

/** One workflow step that names a partner (#2137), from GET /api/partners/:id/usage. */
export interface PartnerUsageStep {
  workflow_id: string
  workflow_name: string
  /** A switched off workflow still counts: switched on again, it calls the partner at once. */
  is_active: boolean
  node_id: string | null
}

/**
 * Which of the organization's workflow steps name a partner, per node kind
 * (#2137): a Bid Group or Partner Bid step makes the Bid Group tab apply, a
 * Latency Gate the confirmation window.
 */
export interface PartnerUsage {
  /** partner_ids are asked on every lead (a tiered group's from its tiers); the fallback only once nobody wins. */
  bid_group: Array<PartnerUsageStep & { mode: 'highest_bid' | 'cascade' | 'tiered'; partner_ids: string[]; fallback_partner_id: string | null }>
  partner_bid: PartnerUsageStep[]
  latency_gate: PartnerUsageStep[]
}

/**
 * The page's one save beside its partner patch (#2133): the pair of versions it
 * was edited from, the profile document when it saves one, and this press's id.
 * A save that never read the profile (a source partner, or a profile read that
 * failed) names neither the profile nor its version, and is not compared on it.
 */
export interface PartnerPageSaveRequest {
  expected_partner_version: number
  expected_profile_version: number | null
  profile: BuyerProfileDocument | null
  save_id: string
  /**
   * This browser tab (#2135), carried on the live notice the save sends, so the
   * tab recognises its own echo by client_id plus save_id. Optional; a UUID.
   */
  client_id?: string
}

export type { PartnerPageVersions, PartnerPageChange, PartnerPageNotice, LiveMissCause, LiveMissReportBody } from '@bidspoke/partner-page-live'
// The partners page History (#2141): entries newest first, each naming who made it.
export type { PartnerHistory, HistoryEntry, HistoryEditor, HistoryEntityType } from '@bidspoke/partner-history'

/** What a page save answers (#2133): both halves as stored after it, and the stored copy warning when there is one. */
export interface PartnerPageSaved extends StoredCopyAnswer {
  partner: Partner
  profile: BuyerProfileDocument | null
  partner_version: number
  profile_version: number
}

/**
 * The workflow values tab's answer (#2142, GET /api/partners/:id/workflow-values):
 * every value the Constants node emits for the partner, with the workflows that
 * read it. Held to the Worker's own type by
 * apps/web/src/lib/__tests__/workflow-values-answer-type.test.ts.
 */
export type PartnerValueKind = 'ClickUrl' | 'SellOffOfferTitle' | 'SellOffOfferDetails' | 'SubAccountMinBids' | 'subAccountIdsMap' | 'activeBidding'

/** `by_name`: names this partner's value, or its entry in a map. `every_partner`: reads it for every partner at once. */
export type PartnerValueReadHow = 'by_name' | 'every_partner'

export interface PartnerValueReadingPlace {
  node_id: string | null
  namespace: string | null
  label: string | null
  node_type: string | null
  edge_id: string | null
  reads: PartnerValueReadHow
}

export interface PartnerValueReadingWorkflow {
  workflow_id: string
  workflow_name: string
  is_active: boolean
  reads: PartnerValueReadHow
  places: PartnerValueReadingPlace[]
}

export interface PartnerWorkflowValue {
  /** The name the Constants node emits it under. */
  constant_name: string
  kind: PartnerValueKind
  /** One of the two maps holding every partner's entry. */
  map: boolean
  access: { template: string; code: string }
  /** Whether the node emits it now. */
  emitted: boolean
  /** As the node emits it: the value, or this partner's part of a map: its entry in activeBidding, its id to slug entries in subAccountIdsMap. */
  value: unknown
  readers: PartnerValueReadingWorkflow[]
  /** Workflow data keys with this name, which the partner value replaces. */
  shadowed_data_keys: Array<{ workflow_id: string; workflow_name: string; is_active: boolean; node_id: string; namespace: string }>
  /** For the click URL: the engine's readers outside workflows. */
  readers_outside_workflows: Array<{ reader: string; description: string }>
}

export interface PartnerWorkflowValues {
  partner: { id: string; slug: string }
  values: PartnerWorkflowValue[]
  /** What was searched, so an empty reader list can be worded as what it measured. */
  searched: { workflows: number; with_constants_node: number }
}

/**
 * The partner delete check (#2140), the page's copy of the Worker's types in
 * apps/worker/src/lib/partner-delete-shape.ts; partner-delete-answer-type.test.ts
 * holds the two equal.
 */
export interface DependentNoun {
  one: string
  many: string
}

export interface PartnerDeleteTable {
  table: string
  kind: 'deleted' | 'cleared'
  rows: number
  noun: DependentNoun
}

export type PartnerDeleteBlocker =
  | { kind: 'rows'; table: string; rows: number; noun: DependentNoun }
  | { kind: 'ledger_unmirrored'; count: number }
  | { kind: 'ledger_unresolved'; count: number }

export interface PartnerDeleteWorkflow {
  id: string
  name: string
  is_active: boolean
}

export interface PartnerDeleteReadingWorkflow extends PartnerDeleteWorkflow {
  reads: 'by_name' | 'every_partner'
  values: string[]
}

export interface PartnerDeleteFingerprint {
  counts: Record<string, number>
  workflows: Array<{ id: string; updated_at: string }>
}

export interface PartnerDeleteCheck {
  partner: { id: string; name: string; slug: string; partner_type: string; is_active: boolean }
  blockers: PartnerDeleteBlocker[]
  removes: PartnerDeleteTable[]
  workflows_naming_partner: PartnerDeleteWorkflow[]
  workflows_reading_values: PartnerDeleteReadingWorkflow[]
  secret: { name: string; other_partners: number } | null
  fingerprint: PartnerDeleteFingerprint
}

export interface PartnerDeleted {
  ok: true
  stored_copy_warning?: string
  state_reset_warning?: string
}

/** A refused delete (409): nothing was deleted, and check is the consequence as it stands now, or null when it could not be read. */
export interface PartnerDeleteRefused {
  error: 'blocked' | 'consequence_changed'
  message: string
  check: PartnerDeleteCheck | null
}

/**
 * What a stale page save is answered with (#2132, #2133): both halves as
 * stored now, the press that last saved, and who last changed either half.
 */
export interface PartnerPageStale {
  error: 'stale_version'
  partner: Partner | null
  profile: BuyerProfileDocument | null
  partner_version: number | null
  profile_version: number | null
  last_save_id: string | null
  changed_by_name: string | null
  changed_at: string | null
}

// ── Partner Bid Configs (matrix definitions) ──────────────────────────────────

/** A held click claim's live state, as the claim object reports it (#1552). */
export type HeldClaim =
  | { status: 'held'; generation: number }
  | { status: 'sending'; generation: number; releasable_at: string }
  | { status: 'free'; generation: number }
  | { status: 'sold'; generation: number; partner_lead_id: string | null }
  | { status: 'unreadable'; message: string }

/** Another buyer sold on the offer (#2324, PM-21): what the Priority section says this buyer stands among. */
export interface OfferBuyer {
  id: string
  name: string
  priority: number | null
}

/** One click buyer_click_send left held for a person (#1552). */
export interface HeldClick {
  id: string
  prospect_id: string
  reason: string
  detail: string
  partner_lead_id: string | null
  workflow_id: string | null
  execution_id: string
  held_at: string
  last_seen_at: string
  claim: HeldClaim
  /** A sold entry's last Salesforce updates (#1659); null while the claim is not sold. */
  salesforce: SalesforceWritesView | null
  /**
   * Where a sold entry stands in Salesforce, read by the Worker with
   * salesforceStandingOf (#2139): every value but written offers Retry
   * Salesforce. Null while the claim is not sold; absent from a Worker older
   * than #2139. A sold entry with written and no lead id is on the list only so
   * the lead id can be added (L1008).
   */
  salesforce_standing?: SalesforceStanding | null
  /** Set on the page only, once the server confirmed the entry left the list; its Salesforce retry went with it. */
  cleared?: boolean
  /**
   * Set on the page only, true once this page's Mark sent was told the click
   * was counted (#2325), and false when it was not or may not have been. The
   * card says Counted only when true: the Worker keeps no record of the count's
   * outcome on the entry, so after a reload it is unset and nothing is claimed (L11).
   */
  counted?: boolean
}

export type MarkSentResult =
  | { outcome: 'sent'; generation: number; count: { added: boolean; count: number; date: string }; salesforce: SaleWrites; audit_recorded: boolean; list_cleared: boolean }
  | {
      outcome: 'sent'; generation: number; count: null
      /**
       * not_added: the counter refused the add. unknown: nothing it answered says
       * whether it took the click (#1766). Absent from a worker older than that,
       * which the page reads as unknown, because its message cannot say which.
       */
      count_failure?: 'not_added' | 'unknown'
      count_error: string; count_date: string; salesforce: SaleWrites; audit_recorded: boolean; list_cleared: boolean
    }

/** Writing a marked sent click's Salesforce updates again (#1659). */
export interface SalesforceRetryResult {
  outcome: 'written' | 'incomplete'
  salesforce: SaleWrites
  /** False when the audit entry, the only record of this outcome, did not land. */
  audit_recorded: boolean
  list_cleared: boolean
}

/**
 * Adding or correcting a marked sent sale's lead id (#2139, decision 3). The
 * new id stands whatever Salesforce answers; `salesforce` says what each record
 * took, in Salesforce's own words when it refused, and an entry whose updates
 * did not all land stays listed for Retry Salesforce.
 */
export interface LeadIdResult {
  outcome: 'amended'
  generation: number
  salesforce: SaleWrites
  /** False when the audit entry, the only record of this outcome, did not land. */
  audit_recorded: boolean
  list_cleared: boolean
}

export interface BidConfigDimension {
  name: string
  payload_field: string
  column: 'row' | 'range'
}

export interface PartnerBidConfig {
  id: string
  partner_id: string
  slug: string
  name: string
  is_default: boolean
  is_active: boolean
  sync_source: 'salesforce' | 'manual'
  sf_object: string | null
  sf_filters: Record<string, unknown> | null
  dimensions: BidConfigDimension[]
  last_synced_at: string | null
  last_sync_error: string | null
  created_at: string
  updated_at: string
  updated_by_email: string | null
  updated_by_name: string | null
}

export interface BidMatrixRow {
  id: string
  is_sell_off: boolean
  row_id: string | null
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
  bid_amount: number
  source_synced_at: string | null
}

export interface PartnerBidConfigDetail {
  config: PartnerBidConfig
  rows: BidMatrixRow[]
}

// A structural problem in a bid matrix found at sync time (#182): two bands
// claiming the same lead (overlap) or a hole no band covers (gap). Mirrors the
// worker's MatrixProblem (apps/worker/src/lib/bid-matrix-validate.ts).
export interface MatrixProblem {
  kind: 'overlap' | 'gap'
  axis: 'row' | 'range'
  is_sell_off: boolean
  detail: string
}

export interface SyncResult {
  config_id: string
  config_slug: string
  rows_fetched: number
  rows_upserted: number
  rows_deleted: number
  last_synced_at: string
  problems: MatrixProblem[]
}

export type PartnerBidConfigBody = Partial<Omit<PartnerBidConfig,
  'id' | 'last_synced_at' | 'last_sync_error' | 'created_at' | 'updated_at' | 'updated_by_email' | 'updated_by_name'>>

export interface PartnerUuid {
  id: string
  partner_slug: string
  uuid: string
  created_at: string
}

/** What every incident in the record carries (#2101). The worker resolves every reader facing field (apps/worker/src/lib/incidents-read.ts), so the page only lays them out. */
interface IncidentBase {
  id: string
  /** The stored signal key, shown beside the label only when the signal is unrecognised. */
  signal: string
  signal_label: string
  signal_known: boolean
  subject_name: string
  scope: 'org' | 'platform'
  started_at: string
  pages_sent: number
}

/** A closed incident, as GET /api/incidents returns it for the Incidents card. */
export interface Incident extends IncidentBase {
  ended_at: string | null
  state: 'ended' | 'end_not_recorded'
  duration: string | null
  /** A failure rate incident's failed runs still kept (#2102); null for every other signal. */
  failed_runs: IncidentFailedRunsSummary | null
}

/**
 * What the card can say about a failure rate incident's runs (#2102): a count, or
 * that none of its span is still kept, or that the count could not be read (never
 * shown as 0).
 */
export type IncidentFailedRunsSummary =
  | { workflow_id: string; state: 'counted'; count: number }
  | { workflow_id: string; state: 'not_kept' }
  | { workflow_id: string; state: 'unreadable' }

/** One run in the workflow page's run list, as GET /api/executions and the incident runs route return it. */
export interface ExecutionListRow {
  id: string
  status: string
  outcome: 'successful' | 'completed' | 'failed' | null
  final_node_namespace: string | null
  source: string
  started_at: string
  duration_ms: number | null
  error_message: string | null
  parent_execution_id: string | null
  has_children: boolean
}

/** GET /api/incidents/:id/failed-runs (#2102): one failure rate incident's failed runs still kept. */
export interface IncidentFailedRuns {
  incident: {
    id: string
    workflow_id: string
    match: string
    started_at: string
    ended_at: string | null
    /** Still open; closed with its end recorded; or closed without one, which is never said as still running. */
    state: 'ongoing' | 'ended' | 'end_not_recorded'
  }
  /** The oldest moment whose runs are still kept. */
  kept_since: string
  /** The incident started before kept_since, so its earliest runs are gone. */
  clipped: boolean
  /** The length of `runs`. */
  count: number
  runs: ExecutionListRow[]
}

/** An open incident, as GET /api/incidents/ongoing returns it for the line under the page header. */
export interface OngoingIncident extends IncidentBase {
  so_far: string | null
}

export interface IncidentsResponse {
  incidents: Incident[]
  has_more: boolean
  next_offset: number | null
}

export interface OngoingIncidentsResponse {
  incidents: OngoingIncident[]
  has_more: boolean
}

export interface StatsResponse {
  window_days: number
  summary: {
    total: number
    completed: number
    failed: number
    exited: number
    successful: number
    // Served, but a post-response writeback failed (#310). Neutral in success_rate
    // (excluded from the numerator like exited, kept in the denominator); surfaced
    // as its own number so a writeback problem is visible.
    degraded: number
    avg_duration_ms: number | null
    p95_duration_ms: number | null
    success_rate: number
  }
  by_day: Array<{ date: string; completed: number; failed: number; exited: number; degraded: number; total: number }>
  by_workflow: Array<{
    workflow_id: string
    name: string
    total: number
    completed: number
    failed: number
    exited: number
    successful: number
    degraded: number
    success_rate: number | null
    avg_duration_ms: number | null
    avg_duration_completed_ms: number | null
    avg_duration_successful_ms: number | null
    avg_duration_failed_ms: number | null
    cost_usd: number
  }>
  recent_failures: Array<{
    id: string
    workflow_id: string
    workflow_name: string
    error_message: string | null
    started_at: string
    source: string | null
    trace_id: string | null
  }>
}

export interface ConfigWarningsResponse {
  workflows: Array<{
    workflow_id: string
    workflow_name: string
    nodes: Array<{
      node_id: string
      namespace: string
      label: string | null
      type: string
      configured_ms: number
      floor_ms: number
    }>
  }>
  // Nodes whose timeout is below the history-based suggested value: slower
  // runs hit the timeout and burn retries (amber) or typical runs fail
  // outright (red). Also included in the daily Slack alert.
  under_provisioned: Array<{
    workflow_id: string
    workflow_name: string
    nodes: Array<{
      node_id: string
      namespace: string
      label: string | null
      type: string
      configured_ms: number
      suggested_ms: number
      p99_ms: number
      max_ms: number
      sample_size: number
      severity: 'red' | 'amber'
    }>
  }>
  // Nodes whose timeout is far above what their run history needs (could be
  // lower). Low-urgency cleanup, shown separately from the sub-floor list.
  over_provisioned: Array<{
    workflow_id: string
    workflow_name: string
    nodes: Array<{
      node_id: string
      namespace: string
      label: string | null
      type: string
      configured_ms: number
      suggested_ms: number
      p99_ms: number
      sample_size: number
    }>
  }>
}

export interface WorkflowTimeoutSuggestions {
  window_days: number
  nodes: Array<{
    node_id: string
    namespace: string
    type: string
    configured_ms: number | null
    retries: number
    suggested_ms: number
    p50: number | null
    p99: number
    max_ms: number
    sample_size: number
    window_days: number
  }>
}

/**
 * One connection as GET /api/connections lists it (#2338, build PR 4). The
 * status keys are CONNECTION_PAGE_STATUSES in @bidspoke/service-catalogue, and
 * status_word is the word the server read from that one list, so the page shows
 * it rather than spelling its own. Null status: ops gave none (the Slack alert
 * login, or no status known while the checks do not answer).
 */
export interface ConnectionListRow {
  id: string
  name: string
  /** The service's catalogue key. */
  service: string
  /** The service's name as the page shows it (the catalogue's), absent from a Worker before build PR 9. */
  service_name?: string
  /** The Slack alert login, listed as Bidspoke Alerts; its status is Slack's own answer about its token. */
  alert_login?: boolean
  acts_as: string | null
  person_bound: boolean
  owner: { user_id: string; name: string | null; email: string | null } | null
  target: Record<string, unknown> | null
  status: 'ok' | 'reauth' | 'failing' | null
  status_word: string | null
  health: {
    ops_status: string
    last_check_ok_at: string | null
    last_check_failed_at: string | null
    last_check_cause: string | null
    needs_reauth_at: string | null
    needs_reauth_cause: string | null
  } | null
  /** How many workflows use it, soft deleted ones included (R5). */
  used_by: number
  /** When its login was last checked, either way (build PR 9): ops's latest check, or when Slack last answered about the alert login. */
  checked_at?: string | null
  /** Those workflows by name, deleted ones marked (build PR 9). */
  workflows?: Array<{ id: string; name: string; deleted: boolean }>
  /** A Salesforce connection's org host (build PR 9). */
  org?: string | null
  created_at: string
  updated_at: string
}

export interface ConnectionList {
  connections: ConnectionListRow[]
  /**
   * stale: the login checks did not answer, so each status is the last known
   * one, as of as_of (null when none is known); unavailable says why (D22).
   */
  statuses: { as_of: string | null; stale: boolean; unavailable: { cause: string; detail: string } | null }
}

/** What POST /api/connections/:id/lookup/:key found. */
export type ConnectionLookupAnswer =
  | { key: 'objects' | 'tables'; entries: { name: string; label: string }[] }
  | { key: 'fields' | 'columns'; parent: string; fields: { name: string; label: string; type: string; nullable?: boolean }[] }

/**
 * An edit route's answer when its change landed but a stored outage copy of the
 * old version could not be refreshed or cleared (#1845, #1846). Every page that
 * makes the change shows the warning; the server's sweep repairs the copy.
 */
export interface StoredCopyAnswer {
  stored_copy_warning?: string
}

export interface WebhookEndpoint {
  id: string
  subdomain: string
  path: string
  workflow_id: string
  workflow_name: string | null
  source_name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface WebhookEndpointBody {
  subdomain?: string
  path?: string
  workflow_id?: string
  source_name?: string
  is_active?: boolean
}

export interface ServicePreset {
  id: string
  name: string
  slug: string
  auth_type: string
  base_url: string | null
  created_at: string
}

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'

async function authHeaders(): Promise<HeadersInit> {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Not authenticated')
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  }
}

// Both auth redirects ask the leave guard first (#2138): while a page holds a
// draft or a save not yet confirmed, the redirect is not made and the page
// says why instead, so an expired session never takes unsaved work with it.
function redirectToLogin() {
  if (typeof window === 'undefined' || holdAuthRedirect(401)) return
  window.location.href = '/login'
}

// Handle an auth-level rejection from the Worker API. 401 = not authenticated
// -> /login; 403 = authenticated but not allowlisted (e.g. removed mid-session)
// -> /access-denied, matching the browser middleware gate. Returns true if it
// handled the status, false otherwise.
function redirectOnAuthRejection(status: number): boolean {
  if (status === 401) {
    redirectToLogin()
    return true
  }
  if (status === 403) {
    if (typeof window !== 'undefined' && !holdAuthRedirect(403)) window.location.href = '/access-denied'
    return true
  }
  return false
}

/**
 * The error an auth rejection throws, carrying its status (#2138), so a caller
 * whose redirect was held can tell an expired session from a request that got
 * no answer at all.
 */
function authRejection(status: 401 | 403): Error & { status: 401 | 403 } {
  return Object.assign(new Error(status === 401 ? 'Not authenticated' : 'Access denied'), { status })
}

// Default ceiling for a normal request. Long-running operations (test runs,
// the connections list and lookups, the code-worker migration, replay/resume)
// pass a higher timeoutMs: see the per-endpoint call sites below.
const DEFAULT_TIMEOUT_MS = 30_000
// Operations that hit real partners / redeploy workers / walk a full execution.
const LONG_TIMEOUT_MS = 120_000
const MIGRATION_TIMEOUT_MS = 180_000
// The Worker waits up to 15 s for the login checks before answering the last
// known statuses, and a lookup up to 30 s for ops (OPS_CONNECTIONS_DEADLINES_MS
// in apps/worker/src/lib/ops-connections-client.ts); each gets headroom past
// that, so the Worker's own named answer arrives before the browser gives up.
export const CONNECTIONS_LIST_TIMEOUT_MS = 45_000
const CONNECTION_LOOKUP_TIMEOUT_MS = 45_000

type ReqInit = RequestInit & { timeoutMs?: number }

// An Error raised when a request exceeds its ceiling. Callers can branch on
// `timedOut` to offer a retry; the message warns that the action may have
// reached the server, so a blind retry could double-fire (#492).
export class TimeoutError extends Error {
  readonly timedOut = true
  /** The ceiling that was passed, so a caller can say how long it waited (#2321). */
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s. It may still be processing. ` +
        `Check execution history before retrying.`,
    )
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

// fetch with a client-side abort ceiling. Uses a manual setTimeout + AbortController
// (rather than AbortSignal.timeout) so the timer is controllable in tests and the
// timeout can be told apart from any other abort.
async function fetchWithTimeout(url: string, init: ReqInit, headers: HeadersInit): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const { timeoutMs: _omit, ...rest } = init
  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: { ...(rest.headers ?? {}), ...headers },
    })
  } catch (e) {
    if (controller.signal.aborted) throw new TimeoutError(timeoutMs)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function req<T>(path: string, init?: ReqInit): Promise<T> {
  let headers: HeadersInit
  try {
    headers = await authHeaders()
  } catch {
    redirectToLogin()
    throw authRejection(401)
  }
  const res = await fetchWithTimeout(`${WORKER_URL}${path}`, init ?? {}, headers)
  if (!res.ok) {
    if (redirectOnAuthRejection(res.status)) {
      throw authRejection(res.status === 401 ? 401 : 403)
    }
    // Surface the server's `error` field when the body is JSON, so users see
    // the actual rejection (e.g. "Workflow has a loop: ...") instead of an
    // `API NNN: {json}` wrapper that reads like a developer error. Fall back to
    // raw text, then a status-only message. Status is kept on the Error for
    // callers that branch on it.
    const body = await res.text().catch(() => '')
    let message = ''
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed.error === 'string') {
        message = parsed.error
        // Folder-delete 409s carry child counts — spell out what's still inside
        // instead of the bare "folder not empty".
        if (parsed.error === 'folder not empty') {
          const parts: string[] = []
          if (typeof parsed.child_folders === 'number' && parsed.child_folders > 0) {
            parts.push(`${parsed.child_folders} subfolder${parsed.child_folders === 1 ? '' : 's'}`)
          }
          if (typeof parsed.child_workflows === 'number' && parsed.child_workflows > 0) {
            parts.push(`${parsed.child_workflows} workflow${parsed.child_workflows === 1 ? '' : 's'}`)
          }
          if (typeof parsed.child_variables === 'number' && parsed.child_variables > 0) {
            parts.push(`${parsed.child_variables} variable${parsed.child_variables === 1 ? '' : 's'}`)
          }
          if (parts.length) message = `Folder still has ${parts.join(' and ')} — move or delete them first.`
        }
      }
    } catch {
      // Body is not JSON (e.g. a short plain-text server message). Use it as-is,
      // but collapse infrastructure error pages (HTML, or anything very long)
      // to a status-only message rather than dumping a raw blob on the user.
      const trimmed = body.trim()
      if (trimmed && trimmed.length <= 200 && !trimmed.startsWith('<')) message = trimmed
    }
    const err = new Error(message || `API ${res.status}`) as Error & {
      status?: number
      body?: unknown
    }
    err.status = res.status
    // The parsed body, kept alongside the message. A rejection routinely carries
    // fields the sentence cannot (which archive a read was waiting for, how long
    // it waited), and without this every caller that needs one has to re-parse a
    // message that was written for a person to read (#874).
    try {
      err.body = JSON.parse(body)
    } catch {
      // Not JSON. The message already holds whatever the server said.
    }
    throw err
  }
  return res.json() as Promise<T>
}

// Workflows
export const api = {
  workflows: {
    list: () => req<WorkflowSummary[]>('/api/workflows'),
    get: (id: string) => req<Workflow>(`/api/workflows/${id}`),
    create: (name: string, folder_id?: string | null) =>
      req<Workflow>('/api/workflows', { method: 'POST', body: JSON.stringify({ name, folder_id: folder_id ?? null }) }),
    save: (id: string, data: { name?: string; definition?: WorkflowDef; message?: string; slack_channel?: string | null }) =>
      // no_changes (#569): the server short-circuits a save whose definition is
      // identical to what's stored: the row is untouched, so version_id and the
      // Workflow body are absent. Callers branch on no_changes before reading them.
      req<Workflow & { deploy_errors?: { namespace: string; error: string }[]; stored_copy_warning?: string; version_id?: string; no_changes?: boolean }>(`/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    draftChangelog: (id: string, definition: WorkflowDef) =>
      req<{ draft: string | null; reason?: 'no_previous_version' | 'no_changes' | 'unavailable' | 'error'; cached?: boolean }>(
        `/api/workflows/${id}/draft-changelog`,
        { method: 'POST', body: JSON.stringify({ definition }) }
      ),
    delete: (id: string) => req<{ ok: boolean; stored_copy_warning?: string }>(`/api/workflows/${id}`, { method: 'DELETE' }),
    // Server-side clone — carries the full version history (and the latest saved
    // definition), unlike a name+definition copy which restarts at v1.
    duplicate: (id: string) =>
      req<Workflow & { history_copied?: boolean }>(`/api/workflows/${id}/duplicate`, { method: 'POST' }),
    // Batched per-node timeout suggestions for canvas badges — one call per
    // workflow instead of a step-duration-stats round-trip per node.
    timeoutSuggestions: (id: string) =>
      req<WorkflowTimeoutSuggestions>(`/api/workflows/${id}/timeout-suggestions`),
    setActive: (id: string, is_active: boolean) =>
      req<{ id: string; is_active: boolean; stored_copy_warning?: string }>(`/api/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      }),
    setFolder: (id: string, folder_id: string | null) =>
      req<{ id: string; folder_id: string | null; stored_copy_warning?: string }>(`/api/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ folder_id }),
      }),
    test: (id: string, payload: unknown, executionId?: string, definition?: unknown) =>
      req<unknown>(`/api/workflows/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ payload, execution_id: executionId, definition }),
        timeoutMs: LONG_TIMEOUT_MS,
      }),
    testNode: (id: string, data: { namespace: string; definition: unknown; execution_id?: string; trigger_payload?: unknown; steps?: Record<string, unknown> }) =>
      req<{
        output: unknown
        status: string
        error_message: string | null
        duration_ms: number
        deploy?: { deployed: boolean; skipped: boolean; error?: string }
      }>(`/api/workflows/${id}/test-node`, { method: 'POST', body: JSON.stringify(data) }),
    saveTestPayloads: (id: string, test_payloads: Array<{ name: string; payload: unknown }>) =>
      req<{ test_payloads: Array<{ name: string; payload: unknown }> }>(`/api/workflows/${id}/test-payloads`, {
        method: 'PATCH',
        body: JSON.stringify({ test_payloads }),
      }),
    renameImpact: (id: string, oldNs: string, newNs: string) =>
      req<{
        partner_formulas: Array<{
          partner_id: string
          partner_name: string
          partner_slug: string
          references: number
          formula_preview: string
          shared_with_workflows: Array<{ id: string; name: string }>
          can_rewrite: boolean
        }>
      }>(`/api/workflows/${id}/rename-impact?old=${encodeURIComponent(oldNs)}&new=${encodeURIComponent(newNs)}`),
    renameApply: (id: string, oldNs: string, newNs: string, partner_ids: string[]) =>
      req<{ updated: number; copies_not_cleared?: string[] } & StoredCopyAnswer>(`/api/workflows/${id}/rename-apply`, {
        method: 'POST',
        body: JSON.stringify({ old: oldNs, new: newNs, partner_ids }),
      }),
  },

  versions: {
    list: (workflowId: string) =>
      req<WorkflowVersion[]>(`/api/workflows/${workflowId}/versions`),
    get: (workflowId: string, versionId: string) =>
      req<WorkflowVersion & { definition: WorkflowDef }>(
        `/api/workflows/${workflowId}/versions/${versionId}`
      ),
    restore: (workflowId: string, versionId: string) =>
      req<{ ok: boolean; version_number: number; stored_copy_warning?: string }>(
        `/api/workflows/${workflowId}/versions/${versionId}/restore`,
        { method: 'POST' }
      ),
  },

  env: {
    list: () => req<EnvVar[]>('/api/env'),
    /** `workflow_id` saves the variable as that workflow's own, read by its runs only (#1681, #1774). */
    create: (data: { key: string; value?: string; is_secret?: boolean; scope?: string; workflow_id?: string; folder_id?: string | null }) =>
      req<EnvVar>('/api/env', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { value?: string; folder_id?: string | null }) =>
      req<EnvVar>(`/api/env/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    setFolder: (id: string, folder_id: string | null) =>
      req<EnvVar>(`/api/env/${id}`, { method: 'PUT', body: JSON.stringify({ folder_id }) }),
    reveal: (id: string) => req<{ value: string }>(`/api/env/${id}/reveal`),
    delete: (id: string) => req<{ ok: boolean }>(`/api/env/${id}`, { method: 'DELETE' }),
    resyncSecrets: () =>
      req<{ missing: number; resynced: string[]; skipped: { key: string; reason: string }[] }>(
        '/api/env/resync-secrets',
        { method: 'POST' },
      ),
  },

  executions: {
    stepDurationStats: (
      workflowId: string,
      namespace: string,
      opts?: { node_type?: string; subtype?: string; retries?: number }
    ) => {
      const params = new URLSearchParams({ workflow_id: workflowId, namespace })
      if (opts?.node_type) params.set('node_type', opts.node_type)
      if (opts?.subtype) params.set('subtype', opts.subtype)
      if (opts?.retries != null) params.set('retries', String(opts.retries))
      return req<{
        p50: number | null
        p95: number | null
        p99: number | null
        max_ms: number | null
        sample_size: number
        suggested_ms: number | null
        floor_ms: number | null
        floor_reason: string | null
        window_days: number
        source: 'history' | 'similar'
        subtype: string | null
        retries_assumed: number
      }>(`/api/executions/step-duration-stats?${params.toString()}`)
    },
    listRecent: () =>
      req<Array<{
        id: string
        workflow_id: string
        status: string
        outcome: 'successful' | 'completed' | 'failed' | null
        final_node_namespace: string | null
        started_at: string
      }>>('/api/executions'),
    list: (workflowId: string, opts?: { outcome?: 'successful' | 'completed' | 'failed'; status?: 'degraded'; before?: string; beforeId?: string }) => {
      const params = new URLSearchParams({ workflow_id: workflowId })
      if (opts?.outcome) params.set('outcome', opts.outcome)
      if (opts?.status) params.set('status', opts.status)
      if (opts?.before) params.set('before', opts.before)
      if (opts?.beforeId) params.set('before_id', opts.beforeId)
      return req<ExecutionListRow[]>(`/api/executions?${params.toString()}`)
    },
    get: (id: string, opts?: { summary?: boolean }) => {
      const qs = opts?.summary ? '?summary=1' : ''
      return req<{
        id: string
        workflow_id: string
        status: string
        outcome: string | null
        source: string
        trace_id: string
        started_at: string
        completed_at: string | null
        duration_ms: number | null
        error_message: string | null
        trigger_payload: unknown
        parent_execution_id: string | null
        slack_alert_type: 'failure' | 'duration' | null
        slack_alert_fired_at: string | null
        slack_alert_reason: {
          step_namespace: string
          step_type: string
          step_duration_ms: number
          threshold_ms?: number
          error_message?: string | null
          error_type?: 'transient' | 'permanent' | null
          summary?: string
          slack_ts?: string
        } | null
        child_executions: Array<{
          id: string
          started_at: string
          status: string
          outcome: string | null
          source: string
        }>
        /**
         * What this lead earned (#1160), read from its lead_sightings row.
         *
         * Null when there is no sighting at all, which is a real and ordinary
         * state: executions are kept 7 days and lead_sightings about two, so an
         * execution in that gap has no record rather than a zero.
         */
        lead_economics: {
          quoted_rate_cents: number | null
          winning_bid_cents: number | null
          margin_cents: number | null
          winning_partner_slug: string | null
        } | null
        /**
         * Set only when this came from the execution archive rather than
         * Postgres (#874), which is every run older than the seven day
         * retention. Absent, not false, on a live one, so a reader that forgets
         * to check cannot silently treat a live run as archived.
         */
        archived?: true
        /** The archive day the run was found on, shown on the archived banner. */
        archive_day?: string
        /** The run was still going when the archive took it, so its record is partial. */
        archived_incomplete?: boolean
        /**
         * The replay and resume runs could not be looked up (#874). Distinct
         * from an empty list, which means there genuinely are none: this means
         * we could not tell, and the page has to say so rather than show
         * nothing and imply the first.
         */
        child_executions_unavailable?: boolean
        steps: Array<{
          id: string
          step_namespace: string
          step_type: string
          step_node_id?: string | null
          parallel_group_id?: string | null
          status: string
          input: unknown
          output: unknown
          logs: Array<{ level: string; message: string; ts: string }> | null
          error_message: string | null
          error_type: string | null
          retries_used: number
          started_at: string
          completed_at: string
          duration_ms: number
          step_order: number
          /** The exit a routing node chose, present in the summary response (#1503). */
          route?: string | null
        }>
      }>(`/api/executions/${id}${qs}`)
    },
    getStep: (id: string, stepId: string) =>
      req<{
        id: string
        step_namespace: string
        input: unknown
        output: unknown
        logs: Array<{ level: string; message: string; ts: string }> | null
      }>(`/api/executions/${id}/steps/${stepId}`),
    replay: async (id: string): Promise<{ executionId: string | null; response: unknown }> => {
      let headers: HeadersInit
      try {
        headers = await authHeaders()
      } catch {
        redirectToLogin()
        throw authRejection(401)
      }
      const res = await fetchWithTimeout(`${WORKER_URL}/api/executions/${id}/replay`, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS }, headers)
      if (!res.ok) {
        if (redirectOnAuthRejection(res.status)) {
          throw authRejection(res.status === 401 ? 401 : 403)
        }
        const errBody = await res.text().catch(() => '')
        throw new Error(`API ${res.status}: ${errBody}`)
      }
      const newId = res.headers.get('X-Execution-Id')
      const body = await res.json().catch(() => null)
      return { executionId: newId, response: body }
    },
    resume: async (id: string): Promise<{ executionId: string | null; response: unknown }> => {
      let headers: HeadersInit
      try {
        headers = await authHeaders()
      } catch {
        redirectToLogin()
        throw authRejection(401)
      }
      const res = await fetchWithTimeout(`${WORKER_URL}/api/executions/${id}/resume`, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS }, headers)
      if (!res.ok) {
        if (redirectOnAuthRejection(res.status)) {
          throw authRejection(res.status === 401 ? 401 : 403)
        }
        const errBody = await res.text().catch(() => '')
        throw new Error(`API ${res.status}: ${errBody}`)
      }
      const newId = res.headers.get('X-Execution-Id')
      const body = await res.json().catch(() => null)
      return { executionId: newId, response: body }
    },
  },

  circuit: {
    status: (name: string) => req<unknown>(`/api/circuit/${name}/status`),
    reset: (name: string) =>
      req<{ ok: boolean }>(`/api/circuit/${name}/reset`, { method: 'POST' }),
  },

  sources: {
    list: () => req<{ name: string; api_key: string; created_at: string }[]>('/api/sources'),
    create: (name: string, assignWorkflowId?: string) =>
      req<{ name: string; api_key: string }>('/api/sources', {
        method: 'POST',
        body: JSON.stringify(assignWorkflowId ? { name, assign_workflow_id: assignWorkflowId } : { name }),
      }),
    // encodeURIComponent the name so a source containing URL-special characters
    // (legacy rows created before the charset was enforced) can still be revoked
    // or assigned instead of mangling the path (#100).
    delete: (name: string) =>
      req<{ ok: boolean }>(`/api/sources/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    listAssignments: () =>
      req<{ source_name: string; workflow_id: string }[]>('/api/sources/assignments'),
    assignWorkflow: (name: string, workflowId: string) =>
      req<{ ok: boolean }>(`/api/sources/${encodeURIComponent(name)}/workflows`, {
        method: 'POST',
        body: JSON.stringify({ workflow_id: workflowId }),
      }),
    unassignWorkflow: (name: string, workflowId: string) =>
      req<{ ok: boolean }>(`/api/sources/${encodeURIComponent(name)}/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' }),
  },

  partners: {
    list: () => req<Partner[]>('/api/partners'),
    get: (id: string) => req<Partner>(`/api/partners/${id}`),
    create: (body: PartnerBody) =>
      req<Partner>('/api/partners', { method: 'POST', body: JSON.stringify(body) }),
    // The page's one save (#2133): the partner patch and the buyer profile in
    // one transaction. A refusal throws carrying `status` and the parsed body; a
    // 409 body is a PartnerPageStale.
    savePage: (id: string, patch: Partial<PartnerBody>, request: PartnerPageSaveRequest) =>
      req<PartnerPageSaved>(`/api/partners/${id}/page`, { method: 'PUT', body: JSON.stringify({ ...request, patch }) }),
    // What deleting the partner would do (#2140), read before Delete is offered.
    deleteCheck: (id: string) => req<PartnerDeleteCheck>(`/api/partners/${id}/delete-check`),
    // The delete as reviewed: a refusal throws carrying `status` and the body; a
    // 409 body is a PartnerDeleteRefused.
    delete: (id: string, fingerprint: PartnerDeleteFingerprint) =>
      req<PartnerDeleted>(`/api/partners/${id}`, { method: 'DELETE', body: JSON.stringify({ fingerprint }) }),
    getCapCount: (id: string) =>
      req<{ count: number; date: string; sold_on?: 'click'; day_zone?: string }>(`/api/partners/${id}/cap-count`),
    // The workflow values tab (#2142): which workflows read the partner's Constants values.
    workflowValues: (id: string) => req<PartnerWorkflowValues>(`/api/partners/${id}/workflow-values`),
    // The live channel's versions probe (#2135): both versions, the last press,
    // and the newest change of each half, direct or not.
    versions: (id: string) => req<PartnerPageVersions>(`/api/partners/${id}/versions`),
    // A change the probe found that no notice announced (#2135). Recorded only.
    reportLiveMiss: (report: LiveMissReportBody) =>
      req<{ ok: true; id: string }>('/api/partners/live-miss', { method: 'POST', body: JSON.stringify(report) }),
    // Which workflow steps name the partner, per node kind (#2137). A failure throws: never read as "none".
    usage: (id: string) => req<PartnerUsage>(`/api/partners/${id}/usage`),
    // History (#2141): audit_log and the matrix syncs merged, newest first. Any
    // read failing is an error naming it (`history_unavailable`), never a
    // shorter list; the page groups by Eastern day through dates.ts.
    history: (id: string) => req<PartnerHistory>(`/api/partners/${id}/history`),
  },

  // The buyer profile read routes (#1412). The profile is saved with the
  // partner through partners.savePage (#2133).
  buyerProfiles: {
    // offer_buyers (#2324): the org's other enabled offer buyers whose partner is on, by priority. Absent from a Worker deployed before it.
    get: (partnerId: string) =>
      req<{ profile: BuyerProfileDocument | null; accept_signals: unknown[]; other_sellers: Array<{ id: string; name: string }>; offer_buyers?: OfferBuyer[] }>(`/api/partners/${partnerId}/buyer-profile`),
    // An offer buyer's ledger counts, or a click buyer's clicks today (#1543), told apart by sold_on.
    usage: (partnerId: string) =>
      req<
        | {
            sold_on: 'offer'
            et_day: string
            hour_bucket: number
            hour: { leads: number; spend_cents: number }
            day: { leads: number; spend_cents: number; by_status: Record<string, number> }
            counted_populations: string[]
            outside_wins_today: number | null
            unmeasured: string[]
          }
        | { sold_on: 'click'; count: number; date: string; day_zone: string }
      >(`/api/partners/${partnerId}/buyer-usage`),
  },

  buyerSales: {
    list: (params: { status: string; page?: number; limit?: number; partner_id?: string }) => {
      const q = new URLSearchParams({ status: params.status, page: String(params.page ?? 1), limit: String(params.limit ?? 20) })
      if (params.partner_id) q.set('partner_id', params.partner_id)
      return req<{ entries: Array<Record<string, unknown>>; total: number; page: number; limit: number }>(`/api/buyer-sales?${q.toString()}`)
    },
    settle: (id: string, outcome: 'accepted' | 'released') =>
      req<{ entry: Record<string, unknown>; mirrored: boolean; mirror_error?: string }>(`/api/buyer-sales/${id}/settle`, { method: 'POST', body: JSON.stringify({ outcome }) }),
  },

  /** Click claims buyer_click_send left held, and a person's release of each (#1552). */
  heldClicks: {
    list: (partnerId: string) =>
      req<{ entries: HeldClick[]; total: number }>(`/api/held-clicks?partner_id=${encodeURIComponent(partnerId)}`),
    /** `buyerLeadId` is optional (PM-7): null or blank marks it sent with no lead id, still counted and Completed in Salesforce. */
    markSent: (id: string, generation: number, buyerLeadId: string | null) =>
      req<MarkSentResult>(`/api/held-clicks/${id}/mark-sent`, { method: 'POST', body: JSON.stringify({ generation, buyer_lead_id: buyerLeadId }) }),
    /** Add or correct the lead id of a sale a person marked sent, at the generation the page read (#2139). */
    setLeadId: (id: string, generation: number, buyerLeadId: string) =>
      req<LeadIdResult>(`/api/held-clicks/${id}/lead-id`, { method: 'POST', body: JSON.stringify({ generation, buyer_lead_id: buyerLeadId }) }),
    free: (id: string, generation: number) =>
      req<{ outcome: 'freed'; generation: number; list_cleared: boolean }>(`/api/held-clicks/${id}/free`, { method: 'POST', body: JSON.stringify({ generation }) }),
    clear: (id: string) =>
      req<{ outcome: 'cleared'; claim: 'free' | 'sold'; list_cleared: boolean }>(`/api/held-clicks/${id}/clear`, { method: 'POST', body: JSON.stringify({}) }),
    retrySalesforce: (id: string) =>
      req<SalesforceRetryResult>(`/api/held-clicks/${id}/salesforce`, { method: 'POST', body: JSON.stringify({}) }),
  },

  partnerBidConfigs: {
    list: (partnerId?: string) =>
      req<PartnerBidConfig[]>(`/api/partner-bid-configs${partnerId ? `?partner_id=${partnerId}` : ''}`),
    get: (id: string) => req<PartnerBidConfigDetail>(`/api/partner-bid-configs/${id}`),
    create: (body: PartnerBidConfigBody) =>
      req<PartnerBidConfig>('/api/partner-bid-configs', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: PartnerBidConfigBody) =>
      req<PartnerBidConfig>(`/api/partner-bid-configs/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/partner-bid-configs/${id}`, { method: 'DELETE' }),
    sync: (id: string) =>
      req<SyncResult>(`/api/partner-bid-configs/${id}/sync`, { method: 'POST' }),
    history: (id: string) =>
      req<Array<{ id: string; changed_at: string; source: string; diff: Record<string, unknown> }>>(
        `/api/partner-bid-configs/${id}/history`
      ),
  },

  partnerUuids: {
    list: () => req<PartnerUuid[]>('/api/partner-uuids'),
    create: (body: { partner_slug: string; uuid: string }) =>
      req<PartnerUuid>('/api/partner-uuids', { method: 'POST', body: JSON.stringify(body) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/partner-uuids/${id}`, { method: 'DELETE' }),
  },

  integrations: {
    resolveSlack: (bot_token: string) =>
      req<{ workspace_name: string; channels: Array<{ id: string; name: string }> }>(
        '/api/integrations/slack/resolve',
        { method: 'POST', body: JSON.stringify({ bot_token }) }
      ),
    getSlack: () => req<{
      connected: boolean
      workspace_name?: string | null
      default_channel?: string | null
      volume_alerts_enabled?: boolean
      matrix_alerts_enabled?: boolean
      config_alerts_enabled?: boolean
      backup_alerts_enabled?: boolean
      matrix_alerts_channel?: string | null
      updated_at?: string
      updated_by_email?: string | null
    }>('/api/integrations/slack'),
    saveSlack: (data: { bot_token: string; default_channel: string; workspace_name?: string }) =>
      req<{ ok: boolean }>('/api/integrations/slack', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateSlackSettings: (data: { volume_alerts_enabled?: boolean; default_channel?: string; matrix_alerts_enabled?: boolean; matrix_alerts_channel?: string | null; config_alerts_enabled?: boolean; backup_alerts_enabled?: boolean }) =>
      req<{ ok: boolean }>('/api/integrations/slack/settings', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    searchSlackChannels: (q: string) =>
      req<{ channels: Array<{ id: string; name: string }> }>(`/api/integrations/slack/channels?q=${encodeURIComponent(q)}`),
    deleteSlack: () =>
      req<{ ok: boolean }>('/api/integrations/slack', { method: 'DELETE' }),
  },
  stats: {
    get: (window: 7 | 14 | 30 = 7) => req<StatsResponse>(`/api/stats?window=${window}`),
  },
  configWarnings: {
    get: () => req<ConfigWarningsResponse>('/api/config-warnings'),
  },
  incidents: {
    list: (days: 7 | 14 | 30, offset = 0) => req<IncidentsResponse>(`/api/incidents?days=${days}&offset=${offset}`),
    ongoing: () => req<OngoingIncidentsResponse>('/api/incidents/ongoing'),
    failedRuns: (id: string) => req<IncidentFailedRuns>(`/api/incidents/${encodeURIComponent(id)}/failed-runs`),
  },

  servicePresets: {
    list: () => req<ServicePreset[]>('/api/service-presets'),
    create: (body: { name: string; slug: string; auth_type: string; base_url?: string }) =>
      req<ServicePreset>('/api/service-presets', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: { name?: string; auth_type?: string; base_url?: string }) =>
      req<ServicePreset>(`/api/service-presets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/service-presets/${id}`, { method: 'DELETE' }),
  },

  access: {
    list: () => req<{ email: string; added_by: string; added_at: string }[]>('/api/access'),
    add: (email: string) =>
      req<{ email: string }>('/api/access', { method: 'POST', body: JSON.stringify({ email }) }),
    remove: (email: string) =>
      req<{ ok: boolean }>(`/api/access/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  },

  endpoints: {
    list: () => req<WebhookEndpoint[]>('/api/endpoints'),
    create: (body: WebhookEndpointBody) =>
      req<WebhookEndpoint & StoredCopyAnswer>('/api/endpoints', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: WebhookEndpointBody) =>
      req<WebhookEndpoint & StoredCopyAnswer>(`/api/endpoints/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      req<{ ok: boolean } & StoredCopyAnswer>(`/api/endpoints/${id}`, { method: 'DELETE' }),
  },

  connections: {
    list: () => req<ConnectionList>('/api/connections', { timeoutMs: CONNECTIONS_LIST_TIMEOUT_MS }),
    // The save, POST /api/connections (#2338, build PR 5), is called by the
    // Add connection form, which arrives with build PR 10.
    // The History tab (build PR 9): newest first, each naming who made it.
    history: (id: string) =>
      req<{ entries: Array<{ id: string; action: string; at: string; by: string | null; credential_changed: boolean; changes: unknown }> }>(`/api/connections/${encodeURIComponent(id)}/history`),
    // The company list of Google mailboxes and drives (R10). Each refusal throws carrying the route's sentence in body.message.
    googleSubjects: () =>
      req<{ subjects: Array<{ kind: 'mailbox' | 'drive'; subject: string; display_name: string | null; added_by: string; added_at: string }>; reached_limit: boolean }>('/api/connections/google/subjects'),
    addGoogleSubject: (body: { kind: 'mailbox' | 'drive'; subject: string; display_name: string | null }) =>
      req<{ outcome: 'added' | 'already_listed'; entry: { kind: 'mailbox' | 'drive'; subject: string; display_name: string | null; added_by: string; added_at: string } }>('/api/connections/google/subjects', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    removeGoogleSubject: (kind: 'mailbox' | 'drive', subject: string) =>
      req<{ outcome: 'removed' }>(`/api/connections/google/subjects/${encodeURIComponent(kind)}/${encodeURIComponent(subject)}`, { method: 'DELETE' }),
    lookup: (id: string, key: string, parents: string[] = []) =>
      req<{ answer: ConnectionLookupAnswer }>(`/api/connections/${encodeURIComponent(id)}/lookup/${encodeURIComponent(key)}`, {
        method: 'POST',
        body: JSON.stringify({ parents }),
        timeoutMs: CONNECTION_LOOKUP_TIMEOUT_MS,
      }),
  },

  admin: {
    migrateCodeWorkers: () =>
      req<{
        migrated: number
        skipped: number
        errored: number
        results: { id: string; name: string; status: string; error?: string; node_count?: number }[]
      }>('/api/admin/migrate-code-workers', { method: 'POST', timeoutMs: MIGRATION_TIMEOUT_MS }),
  },

  settings: {
    getAnthropicKey: () =>
      req<{ configured: boolean; updated_at?: string; updated_by_email?: string }>(
        '/api/settings/anthropic-key'
      ),
    setAnthropicKey: (key: string) =>
      req<{ configured: boolean }>('/api/settings/anthropic-key', {
        method: 'PUT',
        body: JSON.stringify({ key }),
      }),
    clearAnthropicKey: () =>
      req<{ configured: boolean }>('/api/settings/anthropic-key', { method: 'DELETE' }),
  },

  folders: {
    list: () => req<Folder[]>('/api/folders'),
    create: (name: string, parent_id: string | null) =>
      req<Folder>('/api/folders', { method: 'POST', body: JSON.stringify({ name, parent_id }) }),
    update: (id: string, data: { name?: string; parent_id?: string | null }) =>
      req<Folder>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/folders/${id}`, { method: 'DELETE' }),
  },

  envFolders: {
    list: () => req<EnvVarFolder[]>('/api/env-folders'),
    create: (name: string, parent_id: string | null) =>
      req<EnvVarFolder>('/api/env-folders', { method: 'POST', body: JSON.stringify({ name, parent_id }) }),
    update: (id: string, data: { name?: string; parent_id?: string | null }) =>
      req<EnvVarFolder>(`/api/env-folders/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/env-folders/${id}`, { method: 'DELETE' }),
  },
}
