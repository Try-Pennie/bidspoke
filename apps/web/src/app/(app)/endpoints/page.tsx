'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'
import type { WorkflowSummary } from '@/types/workflow'
import NavLayout from '@/components/NavLayout'
import { Globe, Plus, Copy, Check, Trash2, Loader2, ToggleLeft, ToggleRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

const ENDPOINT_DOMAIN = 'trypennie.dev'

function endpointUrl(subdomain: string, path: string): string {
  return `https://${subdomain}.${ENDPOINT_DOMAIN}${path}`
}

export default function EndpointsPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([])
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // New endpoint form
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ subdomain: '', path: '/bidding', workflow_id: '', source_name: '' })
  const [saving, setSaving] = useState(false)
  const subdomainInputRef = useRef<HTMLInputElement | null>(null)

  // Inline state
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (adding) {
      const frame = requestAnimationFrame(() => subdomainInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [adding])

  // Pre-fill source_name when subdomain changes
  useEffect(() => {
    if (!form.subdomain) return
    setForm((f) => ({ ...f, source_name: f.subdomain }))
  }, [form.subdomain])

  async function load() {
    try {
      const [eps, wfs] = await Promise.all([api.endpoints.list(), api.workflows.list()])
      setEndpoints(eps)
      setWorkflows(wfs)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.subdomain || !form.workflow_id) return
    setSaving(true)
    setError(null)
    try {
      await api.endpoints.create({
        subdomain: form.subdomain,
        path: form.path || '/webhook',
        workflow_id: form.workflow_id,
        source_name: form.source_name || form.subdomain,
      })
      setForm({ subdomain: '', path: '/bidding', workflow_id: '', source_name: '' })
      setAdding(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create endpoint')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(ep: WebhookEndpoint) {
    setTogglingId(ep.id)
    const next = !ep.is_active
    setEndpoints((prev) => prev.map((e) => e.id === ep.id ? { ...e, is_active: next } : e))
    try {
      await api.endpoints.update(ep.id, { is_active: next })
    } catch (e) {
      setEndpoints((prev) => prev.map((e) => e.id === ep.id ? { ...e, is_active: ep.is_active } : e))
      setError(e instanceof Error ? e.message : 'Failed to update endpoint')
    } finally {
      setTogglingId(null)
    }
  }

  function requestDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(id)
    deleteTimerRef.current = setTimeout(() => setConfirmingDelete(null), 4000)
  }

  function cancelDelete() {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(null)
  }

  async function handleDelete(ep: WebhookEndpoint) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(null)
    setRemovingId(ep.id)
    removeTimerRef.current = setTimeout(() => {
      setEndpoints((prev) => prev.filter((e) => e.id !== ep.id))
      setRemovingId(null)
    }, 150)
    try {
      await api.endpoints.delete(ep.id)
    } catch (e) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingId(null)
      setEndpoints((prev) => prev.find((e) => e.id === ep.id) ? prev : [...prev, ep])
      setError(e instanceof Error ? e.message : 'Failed to delete endpoint')
    }
  }

  async function handleCopy(ep: WebhookEndpoint) {
    await navigator.clipboard.writeText(endpointUrl(ep.subdomain, ep.path))
    setCopiedId(ep.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const previewUrl = form.subdomain
    ? endpointUrl(form.subdomain, form.path || '/webhook')
    : null

  return (
    <NavLayout>
      <div className="p-8">

        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Endpoints</h1>
            <p className="mt-1 text-sm text-gray-500">
              Give partners a branded URL instead of a generic webhook ID.
              Each endpoint maps a subdomain + path to a specific workflow.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            disabled={adding}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-0 disabled:pointer-events-none"
          >
            <Plus className="h-4 w-4" />
            New endpoint
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Slide-open add form */}
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${adding ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            <div className="mb-6 max-w-lg rounded-xl border border-gray-200 bg-white p-5" inert={!adding || undefined}>
              <p className="mb-4 text-sm font-medium text-gray-400">New endpoint</p>
              <form onSubmit={handleCreate} className="space-y-4">

                {/* URL preview */}
                {previewUrl && (
                  <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2">
                    <p className="font-mono text-sm text-indigo-700 break-all">{previewUrl}</p>
                  </div>
                )}

                {/* Subdomain + path row */}
                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Subdomain</label>
                    <div className="flex items-center rounded-lg border border-gray-200 bg-white focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/20">
                      <input
                        ref={subdomainInputRef}
                        className="min-w-0 flex-1 rounded-l-lg bg-transparent px-3 py-2 font-mono text-sm text-gray-900 outline-none placeholder:text-gray-400"
                        placeholder="tripoint"
                        value={form.subdomain}
                        onChange={(e) => setForm((f) => ({ ...f, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                        required
                      />
                      <span className="flex-shrink-0 rounded-r-lg border-l border-gray-100 bg-gray-50 px-2 py-2 font-mono text-xs text-gray-400">.{ENDPOINT_DOMAIN}</span>
                    </div>
                  </div>
                  <span className="mb-2 text-sm text-gray-400">/</span>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Path</label>
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

                {/* Workflow */}
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

                {/* Source name */}
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Source name</label>
                  <input
                    className="input w-full font-mono"
                    placeholder={form.subdomain || 'tripoint'}
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
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : 'Create endpoint'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAdding(false); setForm({ subdomain: '', path: '/bidding', workflow_id: '', source_name: '' }) }}
                    className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-900"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        {/* Endpoint list */}
        {loading ? (
          <div className="space-y-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
                <Skeleton className="mb-3 h-5 w-72" />
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : endpoints.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
            <Globe className="mx-auto mb-3 h-6 w-6 text-gray-300" />
            <p className="text-base font-semibold text-gray-900">No custom endpoints yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-400">
              Give partners a URL like <span className="font-mono text-gray-600">tripoint.{ENDPOINT_DOMAIN}/bidding</span> instead of a generic webhook ID and API key.
            </p>
            <button
              onClick={() => setAdding(true)}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Create your first endpoint
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {endpoints.map((ep) => (
              <div
                key={ep.id}
                className={`rounded-xl border bg-white p-4 transition-[colors,opacity] duration-150 ${
                  ep.is_active ? 'border-gray-200' : 'border-gray-100 bg-gray-50'
                } ${removingId === ep.id ? 'opacity-0' : ''}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {/* URL */}
                    <div className="mb-2.5 flex items-center gap-2">
                      <code className={`font-mono text-sm font-semibold break-all ${ep.is_active ? 'text-gray-900' : 'text-gray-400'}`}>
                        {endpointUrl(ep.subdomain, ep.path)}
                      </code>
                      {!ep.is_active && (
                        <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                          inactive
                        </span>
                      )}
                    </div>

                    {/* Meta row */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                      {ep.workflow_name && (
                        <span>
                          Workflow: <span className="font-medium text-gray-700">{ep.workflow_name}</span>
                        </span>
                      )}
                      <span>
                        Source: <code className="rounded bg-gray-100 px-1 font-mono text-gray-600">{ep.source_name}</code>
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    {/* Copy URL */}
                    <button
                      onClick={() => handleCopy(ep)}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                      title="Copy URL"
                    >
                      {copiedId === ep.id
                        ? <><Check className="h-3.5 w-3.5 text-green-500" /> Copied</>
                        : <><Copy className="h-3.5 w-3.5" /> Copy URL</>
                      }
                    </button>

                    {/* Toggle active */}
                    <button
                      onClick={() => handleToggle(ep)}
                      disabled={togglingId === ep.id}
                      className="rounded-lg border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                      title={ep.is_active ? 'Disable endpoint' : 'Enable endpoint'}
                    >
                      {ep.is_active
                        ? <ToggleRight className="h-4 w-4 text-indigo-500" />
                        : <ToggleLeft className="h-4 w-4" />
                      }
                    </button>

                    {/* Delete */}
                    {confirmingDelete === ep.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleDelete(ep)}
                          className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                        >
                          Delete
                        </button>
                        <button onClick={cancelDelete} className="text-xs text-gray-400 hover:text-gray-600">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => requestDelete(ep.id)}
                        className="rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:border-red-200 hover:bg-red-50 hover:text-red-500"
                        title="Delete endpoint"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </NavLayout>
  )
}
