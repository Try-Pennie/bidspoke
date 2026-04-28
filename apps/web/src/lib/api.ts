import { createClient } from './supabase/client'
import type { Workflow, WorkflowSummary, WorkflowDef, WorkflowVersion, EnvVar } from '@/types/workflow'

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
  dedup_endpoint: string | null
  response_classification: unknown
  alert_config: unknown
  circuit_error_threshold: number
  circuit_window_seconds: number
  circuit_cooldown_seconds: number
  circuit_enabled: boolean
  is_active: boolean
  priority: number
  sell_off_offer_title: string | null
  sell_off_offer_details: string | null
  click_url: string | null
  partner_type: 'source' | 'buyer'
  created_at: string
  updated_at: string
  updated_by_email: string | null
  updated_by_name: string | null
}

export type PartnerBody = Partial<Omit<Partner, 'id' | 'organization_id' | 'created_at' | 'updated_at' | 'updated_by_email'>>

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
    avg_duration_ms: number | null
    p95_duration_ms: number | null
    success_rate: number
  }
  by_day: Array<{ date: string; completed: number; failed: number; exited: number; total: number }>
  by_workflow: Array<{
    workflow_id: string
    name: string
    total: number
    completed: number
    failed: number
    exited: number
    successful: number
    success_rate: number | null
    avg_duration_ms: number | null
    avg_duration_completed_ms: number | null
    avg_duration_successful_ms: number | null
    avg_duration_failed_ms: number | null
    cost_usd: number
  }>
  by_partner: Array<{
    slug: string
    name: string
    bids_sent: number
    accepted: number
    skipped: number
    errors: number
    win_rate: number
    avg_bid: number | null
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let headers: HeadersInit
  try {
    headers = await authHeaders()
  } catch {
    redirectToLogin()
    throw new Error('Not authenticated')
  }
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...headers },
  })
  if (!res.ok) {
    if (res.status === 401) {
      redirectToLogin()
      throw new Error('Not authenticated')
    }
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

// Workflows
export const api = {
  workflows: {
    list: () => req<WorkflowSummary[]>('/api/workflows'),
    get: (id: string) => req<Workflow>(`/api/workflows/${id}`),
    create: (name: string) =>
      req<Workflow>('/api/workflows', { method: 'POST', body: JSON.stringify({ name }) }),
    save: (id: string, data: { name?: string; definition?: WorkflowDef; message?: string; slack_channel?: string | null }) =>
      req<Workflow & { deploy_errors?: { namespace: string; error: string }[] }>(`/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    draftChangelog: (id: string, definition: WorkflowDef) =>
      req<{ draft: string | null; reason?: 'no_previous_version' | 'no_changes' | 'unavailable' | 'error'; cached?: boolean }>(
        `/api/workflows/${id}/draft-changelog`,
        { method: 'POST', body: JSON.stringify({ definition }) }
      ),
    delete: (id: string) => req<{ ok: boolean }>(`/api/workflows/${id}`, { method: 'DELETE' }),
    duplicate: async (id: string) => {
      const wf = await req<Workflow>(`/api/workflows/${id}`)
      return req<Workflow>('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: `${wf.name} (copy)`, definition: wf.definition }),
      })
    },
    setActive: (id: string, is_active: boolean) =>
      req<{ id: string; is_active: boolean }>(`/api/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      }),
    test: (id: string, payload: unknown, executionId?: string, definition?: unknown) =>
      req<unknown>(`/api/workflows/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ payload, execution_id: executionId, definition }),
      }),
    testNode: (id: string, data: { namespace: string; execution_id: string; definition: unknown }) =>
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
    create: (data: { key: string; value?: string; is_secret?: boolean; scope?: string }) =>
      req<EnvVar>('/api/env', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { value?: string }) =>
      req<EnvVar>(`/api/env/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    reveal: (id: string) => req<{ value: string }>(`/api/env/${id}/reveal`),
    delete: (id: string) => req<{ ok: boolean }>(`/api/env/${id}`, { method: 'DELETE' }),
  },

  executions: {
    listRecent: () =>
      req<Array<{
        id: string
        workflow_id: string
        status: string
        outcome: 'successful' | 'completed' | 'failed' | null
        final_node_namespace: string | null
        started_at: string
      }>>('/api/executions'),
    list: (workflowId: string, opts?: { outcome?: 'successful' | 'completed' | 'failed' }) => {
      const params = new URLSearchParams({ workflow_id: workflowId })
      if (opts?.outcome) params.set('outcome', opts.outcome)
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
    get: (id: string) =>
      req<{
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
        child_executions: Array<{
          id: string
          started_at: string
          status: string
          outcome: string | null
          source: string
        }>
        steps: Array<{
          id: string
          step_namespace: string
          step_type: string
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
        }>
      }>(`/api/executions/${id}`),
    replay: async (id: string): Promise<{ executionId: string | null; response: unknown }> => {
      let headers: HeadersInit
      try {
        headers = await authHeaders()
      } catch {
        redirectToLogin()
        throw new Error('Not authenticated')
      }
      const res = await fetch(`${WORKER_URL}/api/executions/${id}/replay`, { method: 'POST', headers })
      if (res.status === 401) {
        redirectToLogin()
        throw new Error('Not authenticated')
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
    delete: (name: string) =>
      req<{ ok: boolean }>(`/api/sources/${name}`, { method: 'DELETE' }),
    listAssignments: () =>
      req<{ source_name: string; workflow_id: string }[]>('/api/sources/assignments'),
    assignWorkflow: (name: string, workflowId: string) =>
      req<{ ok: boolean }>(`/api/sources/${name}/workflows`, {
        method: 'POST',
        body: JSON.stringify({ workflow_id: workflowId }),
      }),
    unassignWorkflow: (name: string, workflowId: string) =>
      req<{ ok: boolean }>(`/api/sources/${name}/workflows/${workflowId}`, { method: 'DELETE' }),
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
      updated_at?: string
      updated_by_email?: string | null
    }>('/api/integrations/slack'),
    saveSlack: (data: { bot_token: string; default_channel: string; workspace_name?: string }) =>
      req<{ ok: boolean }>('/api/integrations/slack', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteSlack: () =>
      req<{ ok: boolean }>('/api/integrations/slack', { method: 'DELETE' }),
  },
  stats: {
    get: (window: 7 | 14 | 30 = 7) => req<StatsResponse>(`/api/stats?window=${window}`),
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
      }),
  },

  admin: {
    migrateCodeWorkers: () =>
      req<{
        migrated: number
        skipped: number
        errored: number
        results: { id: string; name: string; status: string; error?: string; node_count?: number }[]
      }>('/api/admin/migrate-code-workers', { method: 'POST' }),
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
}
