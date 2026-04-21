'use client'

import { useState, useEffect } from 'react'
import { X, Plus, Trash2, HelpCircle, Copy, Check } from 'lucide-react'
import type { TriggerDef } from '@/types/workflow'
import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787'
const HOOK_BASE = 'https://hook.trypennie.dev'

interface Props {
  workflowId: string
  trigger: TriggerDef
  onChange: (trigger: TriggerDef) => void
  onClose: () => void
  readOnly?: boolean
}

export default function TriggerConfigPanel({ workflowId, trigger, onChange, onClose, readOnly = false }: Props) {
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
  const webhookUrl = `${WORKER_URL}/webhooks/${workflowId}`

  useEffect(() => {
    api.endpoints.list()
      .then((eps) => setCustomEndpoints(eps.filter((e) => e.workflow_id === workflowId && e.is_active)))
      .catch(() => {/* non-critical */})
  }, [workflowId])

  function copyUrl() {
    navigator.clipboard.writeText(webhookUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function copyCustomUrl(url: string) {
    navigator.clipboard.writeText(url)
    setCopiedCustom(url)
    setTimeout(() => setCopiedCustom(null), 1500)
  }

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col border-l border-gray-200 bg-white">
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

        {/* Webhook URL */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-500">Endpoint</label>
          <div className="flex items-start gap-1.5 rounded border border-gray-200 bg-gray-50 pl-2.5 pr-1.5 py-1.5">
            <span className="flex-1 break-all font-mono text-xs text-gray-700">{webhookUrl}</span>
            <button
              type="button"
              onClick={copyUrl}
              className="mt-0.5 flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors"
              title="Copy URL"
            >
              {copied
                ? <Check className="h-3.5 w-3.5 text-green-500" />
                : <Copy className="h-3.5 w-3.5" />
              }
            </button>
          </div>
        </div>

        {/* Custom endpoints mapped to this workflow */}
        {customEndpoints.length > 0 && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Custom endpoints</label>
            <div className="space-y-1.5">
              {customEndpoints.map((ep) => {
                const url = `${HOOK_BASE}/${ep.subdomain}${ep.path}`
                return (
                  <div key={ep.id} className="flex items-start gap-1.5 rounded border border-p-blue-light bg-p-blue-light pl-2.5 pr-1.5 py-1.5">
                    <span className="flex-1 break-all font-mono text-xs text-p-blue-dark">{url}</span>
                    <button
                      type="button"
                      onClick={() => copyCustomUrl(url)}
                      className="mt-0.5 flex-shrink-0 rounded p-1 text-p-blue hover:bg-p-blue-light hover:text-p-blue-dark transition-colors"
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
          </div>
        )}

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

        {/* Custom response */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-gray-700">Custom response</p>
            <p className="text-xs text-gray-400">Use a Response node instead of auto-200</p>
          </div>
          <button
            onClick={() => update({ custom_response: !cfg.custom_response })}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              cfg.custom_response ? 'bg-p-blue-dark' : 'bg-gray-200'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                cfg.custom_response ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

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
              <div className="group relative">
                <HelpCircle className="h-3.5 w-3.5 text-gray-300 hover:text-gray-500 cursor-help" />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-64 -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-2.5 text-xs text-gray-600 opacity-0 shadow-md transition-opacity group-hover:opacity-100">
                  Prevents duplicate executions for the same lead. When enabled, identical requests return the cached response instead of running the workflow again. Configure which payload fields define &ldquo;same lead&rdquo; below.
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
                      className="rounded p-1 text-gray-400 hover:text-blue-500"
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
