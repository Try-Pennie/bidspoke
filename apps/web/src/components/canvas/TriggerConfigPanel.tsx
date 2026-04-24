'use client'

import { useState, useEffect } from 'react'
import { X, Plus, Trash2, HelpCircle, Copy, Check, Eye, EyeOff } from 'lucide-react'
import type { TriggerDef } from '@/types/workflow'
import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'
import EndpointCreateForm from '@/components/forms/EndpointCreateForm'
import SourceCreateForm from '@/components/forms/SourceCreateForm'
import RailResizeHandle from './RailResizeHandle'

interface Source {
  name: string
  api_key: string
  created_at: string
}

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'
const HOOK_BASE = 'https://hook.trypennie.dev'

interface Props {
  workflowId: string
  workflowName?: string
  trigger: TriggerDef
  /** Namespaces of non-trigger nodes currently on the canvas, used for the success-node picker. */
  nodeNamespaces?: string[]
  onChange: (trigger: TriggerDef) => void
  onClose: () => void
  readOnly?: boolean
  width?: number
  onResize?: (width: number) => void
}

export default function TriggerConfigPanel({ workflowId, workflowName, trigger, nodeNamespaces = [], onChange, onClose, readOnly = false, width, onResize }: Props) {
  const effectiveWidth = width ?? 320
  const cfg = trigger.config
  const idempotency = cfg.idempotency ?? { enabled: false, derive_from_fields: [], ttl_seconds: 86400 }

  function update(patch: Partial<TriggerDef['config']>) {
    onChange({ ...trigger, config: { ...cfg, ...patch } })
  }

  function updateIdempotency(patch: Partial<typeof idempotency>) {
    update({ idempotency: { ...idempotency, ...patch } })
  }

  const [newField, setNewField] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedCustom, setCopiedCustom] = useState<string | null>(null)
  const [customEndpoints, setCustomEndpoints] = useState<WebhookEndpoint[]>([])
  const [addingEndpoint, setAddingEndpoint] = useState(false)
  const [sources, setSources] = useState<Source[]>([])
  const [addingSource, setAddingSource] = useState(false)
  const [assigningExisting, setAssigningExisting] = useState(false)
  const [assignments, setAssignments] = useState<{ source_name: string; workflow_id: string }[]>([])
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const webhookUrl = `${WORKER_URL}/webhooks/${workflowId}`

  useEffect(() => {
    api.endpoints.list()
      .then((eps) => setCustomEndpoints(eps.filter((e) => e.workflow_id === workflowId && e.is_active)))
      .catch(() => {/* non-critical */})
  }, [workflowId])

  useEffect(() => {
    Promise.all([api.sources.list(), api.sources.listAssignments()])
      .then(([srcs, asns]) => {
        setSources(srcs as unknown as Source[])
        setAssignments(asns)
      })
      .catch(() => {/* non-critical */})
  }, [])

  const assignedSourceNames = new Set(
    assignments.filter((a) => a.workflow_id === workflowId).map((a) => a.source_name)
  )
  const assignedSources = sources.filter((s) => assignedSourceNames.has(s.name))
  const unassignedSources = sources.filter((s) => !assignedSourceNames.has(s.name))

  async function handleAssignExisting(sourceName: string) {
    try {
      await api.sources.assignWorkflow(sourceName, workflowId)
      setAssignments((prev) => [...prev, { source_name: sourceName, workflow_id: workflowId }])
      setAssigningExisting(false)
    } catch {/* surface later */}
  }

  async function handleUnassign(sourceName: string) {
    try {
      await api.sources.unassignWorkflow(sourceName, workflowId)
      setAssignments((prev) => prev.filter((a) => !(a.source_name === sourceName && a.workflow_id === workflowId)))
    } catch {/* surface later */}
  }

  async function writeToClipboard(text: string): Promise<boolean> {
    // Modern path. If it rejects (permission, insecure context, etc.) fall
    // through to the execCommand fallback instead of silently failing.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch (err) {
      console.warn('clipboard.writeText failed, trying execCommand fallback', err)
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch (err) {
      console.error('clipboard fallback failed', err)
      return false
    }
  }

  async function copyUrl() {
    if (await writeToClipboard(webhookUrl)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  async function copyCustomUrl(url: string) {
    if (await writeToClipboard(url)) {
      setCopiedCustom(url)
      setTimeout(() => setCopiedCustom(null), 1500)
    }
  }

  async function copyKey(key: string) {
    if (await writeToClipboard(key)) {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    }
  }

  function toggleReveal(key: string) {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  return (
    <aside
      className="relative flex flex-shrink-0 flex-col border-l border-gray-200 bg-white"
      style={{ width: effectiveWidth }}
    >
      {onResize && <RailResizeHandle width={effectiveWidth} onResize={onResize} />}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Trigger</p>
          <p className="mt-0.5 text-sm font-semibold text-graphite">Webhook</p>
        </div>
        <div className="flex items-center gap-1">
          {readOnly && <span className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400">View only</span>}
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto text-sm">
      <div className={`p-4 space-y-5 ${readOnly ? 'pointer-events-none' : ''}`}>

        {/* Generic webhook URL — hidden when a custom endpoint is mapped */}
        {customEndpoints.length === 0 && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Endpoint</label>
            <div className="flex items-start gap-1.5 rounded border border-gray-200 bg-beige pl-2.5 pr-1.5 py-1.5">
              <span className="flex-1 break-all font-mono text-xs text-gray-700">{webhookUrl}</span>
              <button
                type="button"
                onClick={copyUrl}
                className="pointer-events-auto mt-0.5 flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors"
                title="Copy URL"
              >
                {copied
                  ? <Check className="h-3.5 w-3.5 text-green-500" />
                  : <Copy className="h-3.5 w-3.5" />
                }
              </button>
            </div>
          </div>
        )}

        {/* Custom endpoints mapped to this workflow */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-xs font-medium text-gray-500">Custom endpoints</label>
            {!readOnly && !addingEndpoint && (
              <button
                type="button"
                onClick={() => setAddingEndpoint(true)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-p-blue-dark hover:bg-p-blue-light"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            )}
          </div>
          {customEndpoints.length > 0 && (
            <div className="space-y-1.5">
              {customEndpoints.map((ep) => {
                const url = `${HOOK_BASE}/${ep.subdomain}${ep.path}`
                return (
                  <div key={ep.id} className="flex items-start gap-1.5 rounded border border-p-blue-light bg-p-blue-light pl-2.5 pr-1.5 py-1.5">
                    <span className="flex-1 break-all font-mono text-xs text-p-blue-dark">{url}</span>
                    <button
                      type="button"
                      onClick={() => copyCustomUrl(url)}
                      className="pointer-events-auto mt-0.5 flex-shrink-0 rounded p-1 text-p-blue hover:bg-p-blue-light hover:text-p-blue-dark transition-colors"
                      title="Copy URL"
                    >
                      {copiedCustom === url
                        ? <Check className="h-3.5 w-3.5 text-green-500" />
                        : <Copy className="h-3.5 w-3.5" />
                      }
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          {customEndpoints.length === 0 && !addingEndpoint && (
            <p className="text-xs text-gray-400">Give partners a branded URL like <span className="font-mono">hook.trypennie.dev/partner/bidding</span>.</p>
          )}
          <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${addingEndpoint ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="min-h-0 overflow-hidden">
              <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3" inert={!addingEndpoint || undefined}>
                <EndpointCreateForm
                  workflowId={workflowId}
                  workflowName={workflowName}
                  lockWorkflow
                  autoFocus={addingEndpoint}
                  onCreated={(ep) => {
                    if (ep.workflow_id === workflowId && ep.is_active) {
                      setCustomEndpoints((prev) => [...prev, ep])
                    }
                    setAddingEndpoint(false)
                  }}
                  onCancel={() => setAddingEndpoint(false)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Method */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-500">HTTP method</label>
          <select
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-p-blue-dark focus:outline-none"
            value={cfg.method}
            onChange={(e) => update({ method: e.target.value })}
          >
            <option value="POST">POST</option>
            <option value="GET">GET</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>

        {/* Success nodes */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <label className="block text-xs font-medium text-gray-500">Success nodes</label>
            <div className="group pointer-events-auto relative">
              <HelpCircle className="h-3.5 w-3.5 text-gray-300 hover:text-gray-500 cursor-help" />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-64 -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-2.5 text-xs text-gray-600 opacity-0 shadow-md transition-opacity group-hover:opacity-100">
                Runs that end on one of these nodes are marked <span className="font-medium">Successful</span>. Clean runs that end elsewhere are marked <span className="font-medium">Completed</span>. Leave empty and no runs get the Successful label.
              </div>
            </div>
          </div>
          {(() => {
            const picked = cfg.success_node_namespaces ?? []
            if (readOnly) {
              if (picked.length === 0) {
                return <p className="text-xs text-gray-400">No success nodes chosen.</p>
              }
              return (
                <div className="flex flex-wrap gap-1">
                  {picked.map((ns) => (
                    <span key={ns} className="inline-flex items-center rounded border border-p-blue-light bg-p-blue-light px-2 py-0.5 font-mono text-xs text-p-blue-dark">
                      {ns}
                    </span>
                  ))}
                </div>
              )
            }
            if (nodeNamespaces.length === 0) {
              return <p className="text-xs text-gray-400">Add nodes to the workflow to choose success endpoints.</p>
            }
            return (
              <div className="space-y-1">
                {nodeNamespaces.map((ns) => {
                  const isPicked = picked.includes(ns)
                  return (
                    <label key={ns} className="flex cursor-pointer items-center gap-2 rounded border border-gray-100 px-2 py-1 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={() => {
                          const next = isPicked ? picked.filter((n) => n !== ns) : [...picked, ns]
                          update({ success_node_namespaces: next })
                        }}
                        className="h-3.5 w-3.5 accent-p-blue-dark"
                      />
                      <span className="font-mono text-xs text-graphite">{ns}</span>
                    </label>
                  )
                })}
              </div>
            )
          })()}
        </div>

        {/* Auth method */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-500">Authentication</label>
          <select
            className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:border-p-blue-dark focus:outline-none"
            value={cfg.auth_method}
            onChange={(e) => update({ auth_method: e.target.value as 'api_key' })}
          >
            <option value="api_key">API Key (X-API-Key header)</option>
            <option value="none">None</option>
          </select>
        </div>

        {/* API keys assigned to this workflow */}
        {cfg.auth_method === 'api_key' && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-500">API keys</label>
              {!readOnly && !addingSource && !assigningExisting && (
                <div className="flex items-center gap-1">
                  {unassignedSources.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAssigningExisting(true)}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-graphite"
                    >
                      Assign existing
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAddingSource(true)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-p-blue-dark hover:bg-p-blue-light"
                  >
                    <Plus className="h-3 w-3" /> New key
                  </button>
                </div>
              )}
            </div>

            {assignedSources.length > 0 ? (
              <div className="space-y-1.5">
                {assignedSources.map((s) => {
                  const revealed = revealedKeys.has(s.api_key)
                  const display = revealed ? s.api_key : `${s.api_key.slice(0, 8)}${'•'.repeat(16)}`
                  return (
                    <div key={s.name} className="rounded border border-gray-200 bg-white p-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold text-graphite">{s.name}</span>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => handleUnassign(s.name)}
                            className="rounded px-1 py-0.5 text-xs text-gray-400 hover:bg-red-50 hover:text-red-500"
                            title="Unassign from this workflow"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <code className="flex-1 truncate rounded border border-gray-100 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-700">
                          {display}
                        </code>
                        <button
                          type="button"
                          onClick={() => toggleReveal(s.api_key)}
                          className="pointer-events-auto flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                          title={revealed ? 'Hide' : 'Reveal'}
                        >
                          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => copyKey(s.api_key)}
                          className="pointer-events-auto flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                          title="Copy key"
                        >
                          {copiedKey === s.api_key
                            ? <Check className="h-3.5 w-3.5 text-green-500" />
                            : <Copy className="h-3.5 w-3.5" />
                          }
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              !addingSource && !assigningExisting && (
                <p className="text-xs text-gray-400">
                  No keys assigned. Any valid key works until you assign one here — then only assigned keys can trigger this workflow.
                </p>
              )
            )}

            {/* Assign existing picker */}
            <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${assigningExisting ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="min-h-0 overflow-hidden">
                <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3" inert={!assigningExisting || undefined}>
                  {unassignedSources.length === 0 ? (
                    <p className="text-xs text-gray-500">No unassigned keys in this org. Create a new one instead.</p>
                  ) : (
                    <>
                      <p className="mb-2 text-xs font-medium text-gray-600">Assign an existing key</p>
                      <div className="space-y-1">
                        {unassignedSources.map((s) => (
                          <button
                            key={s.name}
                            type="button"
                            onClick={() => handleAssignExisting(s.name)}
                            className="flex w-full items-center justify-between rounded border border-gray-200 px-2 py-1.5 text-left hover:border-p-blue-light hover:bg-p-blue-light"
                          >
                            <span className="font-mono text-xs text-graphite">{s.name}</span>
                            <span className="text-xs text-p-blue-dark">Assign →</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setAssigningExisting(false)}
                      className="text-xs text-gray-500 hover:text-graphite"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Create new key (auto-assigns) */}
            <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${addingSource ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="min-h-0 overflow-hidden">
                <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3" inert={!addingSource || undefined}>
                  <SourceCreateForm
                    autoFocus={addingSource}
                    assignWorkflowId={workflowId}
                    onCreated={(src) => {
                      setSources((prev) => [...prev, { ...src, created_at: new Date().toISOString() }])
                      setAssignments((prev) => [...prev, { source_name: src.name, workflow_id: workflowId }])
                      setAddingSource(false)
                    }}
                    onCancel={() => setAddingSource(false)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Duration alert */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-500">Slow execution alert</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1000}
              step={1000}
              placeholder="Off"
              value={cfg.duration_alert_ms ?? ''}
              onChange={(e) => update({ duration_alert_ms: e.target.value ? Number(e.target.value) : undefined })}
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-p-blue-dark focus:outline-none"
            />
            <span className="text-xs text-gray-400 whitespace-nowrap">ms</span>
          </div>
          <p className="mt-1 text-xs text-gray-400">Send a Slack alert if any execution takes longer than this. Leave blank to disable.</p>
        </div>

        {/* Idempotency */}
        <div className="rounded-lg border border-gray-200 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-gray-700">Idempotency</p>
              <div className="group pointer-events-auto relative">
                <HelpCircle className="h-3.5 w-3.5 text-gray-300 hover:text-gray-500 cursor-help" />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-64 -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-2.5 text-xs text-gray-600 opacity-0 shadow-md transition-opacity group-hover:opacity-100">
                  When the same lead comes in twice, only run the workflow once. The second call gets back whatever the first run returned. Pick the fields that define &quot;same lead&quot; below (e.g. <code className="rounded bg-gray-100 px-1 font-mono">body.leadUuid</code>), or send an <code className="rounded bg-gray-100 px-1 font-mono">X-Idempotency-Key</code> header on the request.
                </div>
              </div>
            </div>
            <button
              onClick={() => updateIdempotency({ enabled: !idempotency.enabled })}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                idempotency.enabled ? 'bg-p-blue-dark' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  idempotency.enabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {idempotency.enabled && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">
                  Match on these fields
                </label>
                <p className="mb-1.5 text-xs text-gray-400">Requests with the same values for these fields count as the same lead. Leave empty to match on the entire payload.</p>
                <div className="space-y-1">
                  {(idempotency.derive_from_fields ?? []).map((field, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <span className="flex-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-700">
                        {field}
                      </span>
                      <button
                        onClick={() => {
                          const fields = [...(idempotency.derive_from_fields ?? [])]
                          fields.splice(i, 1)
                          updateIdempotency({ derive_from_fields: fields })
                        }}
                        className="rounded p-1 text-gray-400 hover:text-red-500"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-1">
                    <input
                      className="flex-1 rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-p-blue-dark focus:outline-none"
                      placeholder="body.field_name"
                      value={newField}
                      onChange={(e) => setNewField(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newField.trim()) {
                          updateIdempotency({
                            derive_from_fields: [...(idempotency.derive_from_fields ?? []), newField.trim()],
                          })
                          setNewField('')
                        }
                      }}
                    />
                    <button
                      onClick={() => {
                        if (!newField.trim()) return
                        updateIdempotency({
                          derive_from_fields: [...(idempotency.derive_from_fields ?? []), newField.trim()],
                        })
                        setNewField('')
                      }}
                      className="rounded p-1 text-gray-400 hover:text-p-blue-dark"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Remember for (seconds)</label>
                <input
                  type="number"
                  className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-p-blue-dark focus:outline-none"
                  value={idempotency.ttl_seconds ?? 86400}
                  min={60}
                  onChange={(e) => updateIdempotency({ ttl_seconds: Number(e.target.value) })}
                />
                <p className="mt-1 text-xs text-gray-400">How long to cache the response. Default 86400 = 24 hours.</p>
              </div>
            </>
          )}
        </div>

      </div>
      </div>
    </aside>
  )
}
