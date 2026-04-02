import { createClient } from './supabase/client'
import type { Workflow, WorkflowSummary, WorkflowDef, WorkflowVersion, EnvVar } from '@/types/workflow'

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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders()
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...headers },
  })
  if (!res.ok) {
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
    save: (id: string, data: { name?: string; definition?: WorkflowDef; message?: string }) =>
      req<Workflow>(`/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => req<{ ok: boolean }>(`/api/workflows/${id}`, { method: 'DELETE' }),
    test: (id: string, payload: unknown) =>
      req<unknown>(`/api/workflows/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ payload }),
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
    delete: (id: string) => req<{ ok: boolean }>(`/api/env/${id}`, { method: 'DELETE' }),
  },

  circuit: {
    status: (name: string) => req<unknown>(`/api/circuit/${name}/status`),
    reset: (name: string) =>
      req<{ ok: boolean }>(`/api/circuit/${name}/reset`, { method: 'POST' }),
  },
}
