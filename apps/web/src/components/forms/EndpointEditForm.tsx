'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'
import type { WorkflowSummary } from '@/types/workflow'

const HOOK_BASE = 'https://hook.trypennie.dev'

// Single-segment endpoints (path '/' or empty) render without a trailing path.
function endpointUrl(subdomain: string, path: string): string {
  if (!path || path === '/') return `${HOOK_BASE}/${subdomain}`
  return `${HOOK_BASE}/${subdomain}${path}`
}

interface Props {
  endpoint: WebhookEndpoint
  workflows: WorkflowSummary[]
  onSaved: (endpoint: WebhookEndpoint) => void
  onCancel: () => void
}

export default function EndpointEditForm({ endpoint, workflows, onSaved, onCancel }: Props) {
  const [form, setForm] = useState({
    subdomain: endpoint.subdomain,
    // Stored '/' is the single-segment marker; show it as empty in the editor.
    path: endpoint.path === '/' ? '' : endpoint.path,
    workflow_id: endpoint.workflow_id,
    source_name: endpoint.source_name,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.subdomain || !form.workflow_id) return
    setSaving(true)
    setError(null)
    try {
      const updated = await api.endpoints.update(endpoint.id, {
        subdomain: form.subdomain,
        path: form.path,
        workflow_id: form.workflow_id,
        source_name: form.source_name || form.subdomain,
      })
      // The PUT response doesn't include the joined workflow name; resolve it
      // from the loaded workflows so the list row stays accurate.
      const wf = workflows.find((w) => w.id === updated.workflow_id)
      onSaved({ ...updated, workflow_name: wf?.name ?? endpoint.workflow_name })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update endpoint')
    } finally {
      setSaving(false)
    }
  }

  const previewUrl = form.subdomain ? endpointUrl(form.subdomain, form.path) : null

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

      <div className="grid grid-cols-2 items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Partner slug</label>
          <div className="flex items-center rounded-lg border border-gray-200 bg-white focus-within:border-p-blue-dark focus-within:ring-2 focus-within:ring-p-blue-dark/20">
            <span className="flex-shrink-0 rounded-l-lg border-r border-gray-100 bg-gray-50 px-2 py-2 font-mono text-xs text-gray-400">hook.trypennie.dev/</span>
            <input
              className="min-w-0 flex-1 rounded-r-lg bg-transparent px-3 py-2 font-mono text-sm text-graphite outline-none placeholder:text-gray-400"
              placeholder="partner-name"
              value={form.subdomain}
              onChange={(e) => setForm((f) => ({ ...f, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
              required
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Path <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
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
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Workflow</label>
        <select
          className="input w-full"
          value={form.workflow_id}
          onChange={(e) => setForm((f) => ({ ...f, workflow_id: e.target.value }))}
          required
        >
          <option value="">Select a workflow…</option>
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id}>{wf.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Source name</label>
        <input
          className="input w-full font-mono"
          placeholder={form.subdomain || 'custom-name'}
          value={form.source_name}
          onChange={(e) => setForm((f) => ({ ...f, source_name: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
        />
        <p className="mt-1 text-xs text-gray-400">
          Available as <code className="rounded bg-gray-100 px-1 font-mono">trigger.source</code> in workflow steps.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !form.subdomain || !form.workflow_id}
          className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
        >
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save changes'}
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
