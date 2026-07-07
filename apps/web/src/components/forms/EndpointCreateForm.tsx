'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'
import type { WorkflowSummary } from '@/types/workflow'
import { deriveSourceName } from './endpoint-source-name'

const HOOK_BASE = 'https://hook.trypennie.dev'

// Single-segment endpoints (path '/' or empty) render without a trailing
// path; two-segment endpoints append the path.
function endpointUrl(subdomain: string, path: string): string {
  if (!path || path === '/') return `${HOOK_BASE}/${subdomain}`
  return `${HOOK_BASE}/${subdomain}${path}`
}

interface Props {
  /** Available workflows. Required unless lockWorkflow is true. */
  workflows?: WorkflowSummary[]
  /** Pre-selected workflow. Required if lockWorkflow is true. */
  workflowId?: string
  /** Display name shown when workflow is locked. */
  workflowName?: string
  /** When true, hides the workflow picker and uses workflowId. */
  lockWorkflow?: boolean
  /** Auto-focus the first input on mount. */
  autoFocus?: boolean
  onCreated: (endpoint: WebhookEndpoint) => void
  onCancel: () => void
}

export default function EndpointCreateForm({
  workflows = [],
  workflowId,
  workflowName,
  lockWorkflow = false,
  autoFocus = false,
  onCreated,
  onCancel,
}: Props) {
  const [form, setForm] = useState({
    subdomain: '',
    path: '',
    workflow_id: workflowId ?? '',
    source_name: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Stop mirroring subdomain → source_name once the user edits source_name (#99).
  const [sourceNameEdited, setSourceNameEdited] = useState(false)
  const subdomainInputRef = useRef<HTMLInputElement | null>(null)
  const subdomainId = useId()
  const pathId = useId()
  const workflowSelectId = useId()
  const sourceNameId = useId()

  useEffect(() => {
    if (autoFocus) {
      const frame = requestAnimationFrame(() => subdomainInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [autoFocus])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.subdomain) {
      setError('Partner slug is required.')
      return
    }
    if (!form.workflow_id) {
      setError('Select a workflow.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await api.endpoints.create({
        subdomain: form.subdomain,
        // Empty path = single-segment URL. Worker stores it as '/'.
        path: form.path,
        workflow_id: form.workflow_id,
        source_name: form.source_name || form.subdomain,
      })
      onCreated(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create endpoint')
    } finally {
      setSaving(false)
    }
  }

  const previewUrl = form.subdomain
    ? endpointUrl(form.subdomain, form.path)
    : null

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {previewUrl && (
        <div className="rounded-lg border border-p-blue-light bg-p-blue-light px-3 py-2">
          <p className="font-mono text-sm text-p-blue-dark break-all">{previewUrl}</p>
        </div>
      )}

      <div>
        <label htmlFor={subdomainId} className="mb-1 block text-xs font-medium text-gray-600">Partner slug</label>
        <div className="flex items-center rounded-lg border border-gray-200 bg-white focus-within:border-p-blue-dark focus-within:ring-2 focus-within:ring-p-blue-dark/20">
          <span className="flex-shrink-0 truncate rounded-l-lg border-r border-gray-100 bg-gray-50 px-2 py-2 font-mono text-xs text-gray-500">hook.trypennie.dev/</span>
          <input
            id={subdomainId}
            ref={subdomainInputRef}
            className="min-w-[6rem] flex-1 rounded-r-lg bg-transparent px-3 py-2 font-mono text-sm text-graphite outline-none placeholder:text-gray-500"
            placeholder="partner-name"
            value={form.subdomain}
            onChange={(e) => {
              const subdomain = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
              setForm((f) => ({ ...f, subdomain, source_name: deriveSourceName(subdomain, f.source_name, sourceNameEdited) }))
            }}
          />
        </div>
      </div>
      <div>
        <label htmlFor={pathId} className="mb-1 block text-xs font-medium text-gray-600">
          Path <span className="font-normal text-gray-500">(optional)</span>
        </label>
        <input
          id={pathId}
          className="input w-full font-mono"
          placeholder="/bidding"
          value={form.path}
          onChange={(e) => {
            let v = e.target.value.toLowerCase().replace(/[^a-z0-9\-_/]/g, '')
            if (v && !v.startsWith('/')) v = '/' + v
            setForm((f) => ({ ...f, path: v }))
          }}
        />
      </div>

      {lockWorkflow ? (
        <div>
          <span className="mb-1 block text-xs font-medium text-gray-600">Workflow</span>
          <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-600">
            {workflowName ?? 'This workflow'}
          </div>
        </div>
      ) : (
        <div>
          <label htmlFor={workflowSelectId} className="mb-1 block text-xs font-medium text-gray-600">Workflow</label>
          <select
            id={workflowSelectId}
            className="input w-full"
            value={form.workflow_id}
            onChange={(e) => setForm((f) => ({ ...f, workflow_id: e.target.value }))}
          >
            <option value="">Select a workflow…</option>
            {workflows.map((wf) => (
              <option key={wf.id} value={wf.id}>{wf.name}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label htmlFor={sourceNameId} className="mb-1 block text-xs font-medium text-gray-600">Source name</label>
        <input
          id={sourceNameId}
          className="input w-full font-mono"
          placeholder={form.subdomain || 'custom-name'}
          value={form.source_name}
          onChange={(e) => {
            setSourceNameEdited(true)
            setForm((f) => ({ ...f, source_name: e.target.value.toLowerCase().replace(/\s+/g, '_') }))
          }}
        />
        <p className="mt-1 text-xs text-gray-500">
          Available as <code className="rounded bg-gray-100 px-1 font-mono">trigger.source</code> in workflow steps.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
        >
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : 'Create endpoint'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
