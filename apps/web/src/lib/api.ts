import { createClient } from './supabase/client'
import type { Workflow, WorkflowSummary, WorkflowDef, WorkflowVersion, EnvVar, Folder, EnvVarFolder } from '@/types/workflow'
import type { PartnerType } from './partner-roles'

export type { PartnerType }

export type BidResolverType = 'formula' | 'matrix' | 'api'
export type BidMode = 'commit' | 'ping_only'
export type BidComparisonSource = 'auto' | 'api' | 'formula' | 'matrix'

export type ExtraExtractionSpec =
  | string
  | { path?: string; classifier?: string }

export type ExtraExtractionConfig = Record<string, ExtraExtractionSpec>

import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'

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
  bid_mode: BidMode
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
}

export type PartnerBody = Partial<Omit<Partner, 'id' | 'organization_id' | 'created_at' | 'updated_at' | 'updated_by_email'>>

// ── Partner Bid Configs (matrix definitions) ──────────────────────────────────

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

export interface SchemaField {
  name: string
  label: string
  type: string
  nullable?: boolean
}

export interface SchemaObject {
  name: string
  label: string
  fields: SchemaField[]
}

export interface ServiceConnection {
  id: string
  service_type: 'salesforce' | 'supabase' | 'snowflake'
  auth_type: string
  schema_cache: { objects: SchemaObject[] } | null
  schema_synced_at: string | null
  created_at: string
  updated_at: string
  updated_by_email: string | null
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

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.href = '/login'
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
    if (typeof window !== 'undefined') window.location.href = '/access-denied'
    return true
  }
  return false
}

// Default ceiling for a normal request. Long-running operations (test runs,
// schema syncs, the code-worker migration, replay/resume) pass a higher
// timeoutMs — see the per-endpoint call sites below.
const DEFAULT_TIMEOUT_MS = 30_000
// Operations that hit real partners / redeploy workers / walk a full execution.
const LONG_TIMEOUT_MS = 120_000
const MIGRATION_TIMEOUT_MS = 180_000
// A full schema pull for a large Salesforce org can exceed a minute; give it the
// same headroom as a test run so it doesn't false-timeout mid-fetch (#492).
const SCHEMA_SYNC_TIMEOUT_MS = 120_000

type ReqInit = RequestInit & { timeoutMs?: number }

// An Error raised when a request exceeds its ceiling. Callers can branch on
// `timedOut` to offer a retry; the message warns that the action may have
// reached the server, so a blind retry could double-fire (#492).
export class TimeoutError extends Error {
  readonly timedOut = true
  constructor(timeoutMs: number) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s. It may still be processing. ` +
        `Check execution history before retrying.`,
    )
    this.name = 'TimeoutError'
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
    throw new Error('Not authenticated')
  }
  const res = await fetchWithTimeout(`${WORKER_URL}${path}`, init ?? {}, headers)
  if (!res.ok) {
    if (redirectOnAuthRejection(res.status)) {
      throw new Error(res.status === 401 ? 'Not authenticated' : 'Access denied')
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
      req<Workflow & { deploy_errors?: { namespace: string; error: string }[]; version_id?: string; no_changes?: boolean }>(`/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    draftChangelog: (id: string, definition: WorkflowDef) =>
      req<{ draft: string | null; reason?: 'no_previous_version' | 'no_changes' | 'unavailable' | 'error'; cached?: boolean }>(
        `/api/workflows/${id}/draft-changelog`,
        { method: 'POST', body: JSON.stringify({ definition }) }
      ),
    delete: (id: string) => req<{ ok: boolean }>(`/api/workflows/${id}`, { method: 'DELETE' }),
    // Server-side clone — carries the full version history (and the latest saved
    // definition), unlike a name+definition copy which restarts at v1.
    duplicate: (id: string) =>
      req<Workflow>(`/api/workflows/${id}/duplicate`, { method: 'POST' }),
    // Batched per-node timeout suggestions for canvas badges — one call per
    // workflow instead of a step-duration-stats round-trip per node.
    timeoutSuggestions: (id: string) =>
      req<WorkflowTimeoutSuggestions>(`/api/workflows/${id}/timeout-suggestions`),
    setActive: (id: string, is_active: boolean) =>
      req<{ id: string; is_active: boolean }>(`/api/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      }),
    setFolder: (id: string, folder_id: string | null) =>
      req<{ id: string; folder_id: string | null }>(`/api/workflows/${id}`, {
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
      req<{ updated: number }>(`/api/workflows/${id}/rename-apply`, {
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
      req<{ ok: boolean; version_number: number }>(
        `/api/workflows/${workflowId}/versions/${versionId}/restore`,
        { method: 'POST' }
      ),
  },

  env: {
    list: () => req<EnvVar[]>('/api/env'),
    create: (data: { key: string; value?: string; is_secret?: boolean; scope?: string; folder_id?: string | null }) =>
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
      return req<Array<{
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
      }>>(`/api/executions?${params.toString()}`)
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
        throw new Error('Not authenticated')
      }
      const res = await fetchWithTimeout(`${WORKER_URL}/api/executions/${id}/replay`, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS }, headers)
      if (!res.ok) {
        if (redirectOnAuthRejection(res.status)) {
          throw new Error(res.status === 401 ? 'Not authenticated' : 'Access denied')
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
        throw new Error('Not authenticated')
      }
      const res = await fetchWithTimeout(`${WORKER_URL}/api/executions/${id}/resume`, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS }, headers)
      if (!res.ok) {
        if (redirectOnAuthRejection(res.status)) {
          throw new Error(res.status === 401 ? 'Not authenticated' : 'Access denied')
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
    update: (id: string, body: Partial<PartnerBody>) =>
      req<Partner>(`/api/partners/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/partners/${id}`, { method: 'DELETE' }),
    getCapCount: (id: string) =>
      req<{ count: number; date: string }>(`/api/partners/${id}/cap-count`),
  },

  // The buyer profile routes (#1412). A refused save throws an Error carrying
  // `status` and the parsed `body`; a 409 body holds `current`, the document
  // saved now, which the form shows beside the person's edits.
  buyerProfiles: {
    get: (partnerId: string) =>
      req<{ profile: BuyerProfileDocument | null; accept_signals: unknown[]; other_sellers: Array<{ id: string; name: string }> }>(`/api/partners/${partnerId}/buyer-profile`),
    save: (partnerId: string, body: { expected_version: number; profile: BuyerProfileDocument }) =>
      req<{ profile: BuyerProfileDocument }>(`/api/partners/${partnerId}/buyer-profile`, { method: 'PUT', body: JSON.stringify(body) }),
    history: (partnerId: string) =>
      req<{ entries: Array<{ changed_at: string; changed_by: string | null; action: string; changes: Record<string, { old: unknown; new: unknown }> | null }> }>(`/api/partners/${partnerId}/buyer-profile/history`),
    usage: (partnerId: string) =>
      req<{
        et_day: string
        hour_bucket: number
        hour: { leads: number; spend_cents: number }
        day: { leads: number; spend_cents: number; by_status: Record<string, number> }
        counted_populations: string[]
        outside_wins_today: number | null
        unmeasured: string[]
      }>(`/api/partners/${partnerId}/buyer-usage`),
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
      req<WebhookEndpoint>('/api/endpoints', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: WebhookEndpointBody) =>
      req<WebhookEndpoint>(`/api/endpoints/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      req<{ ok: boolean }>(`/api/endpoints/${id}`, { method: 'DELETE' }),
  },

  connections: {
    list: () => req<ServiceConnection[]>('/api/connections'),
    save: (service_type: string, credentials: Record<string, unknown>) =>
      req<ServiceConnection>('/api/connections', {
        method: 'POST',
        body: JSON.stringify({ service_type, credentials }),
      }),
    delete: (service_type: string) =>
      req<{ ok: boolean }>(`/api/connections/${service_type}`, { method: 'DELETE' }),
    syncSchema: (service_type: string) =>
      req<{ ok: boolean; object_count: number }>(`/api/connections/${service_type}/sync-schema`, {
        method: 'POST',
        timeoutMs: SCHEMA_SYNC_TIMEOUT_MS,
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
