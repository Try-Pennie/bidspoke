'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ServicePreset } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { CheckCircle, Unlink, Loader2, Plus, Trash2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

interface SlackStatus {
  connected: boolean
  workspace_name?: string | null
  default_channel?: string | null
  updated_at?: string
  updated_by_email?: string | null
}

interface ResolvedSlack {
  workspace_name: string
  channels: Array<{ id: string; name: string }>
}

export default function IntegrationsPage() {
  const [slack, setSlack] = useState<SlackStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [token, setToken] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState<ResolvedSlack | null>(null)
  const [selectedChannel, setSelectedChannel] = useState('')

  // Service presets
  const [presets, setPresets] = useState<ServicePreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(true)
  const [presetsError, setPresetsError] = useState<string | null>(null)
  const [addingPreset, setAddingPreset] = useState(false)
  const [newPreset, setNewPreset] = useState({ name: '', slug: '', auth_type: 'none', base_url: '' })
  const [savingPreset, setSavingPreset] = useState(false)
  const [confirmingDeletePreset, setConfirmingDeletePreset] = useState<string | null>(null)
  const deletePresetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingPresetId, setRemovingPresetId] = useState<string | null>(null)
  const removePresetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const presetNameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (addingPreset) {
      const frame = requestAnimationFrame(() => presetNameInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [addingPreset])

  useEffect(() => {
    api.integrations.getSlack()
      .then(setSlack)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
    api.servicePresets.list()
      .then(setPresets)
      .catch((e) => setPresetsError(e.message))
      .finally(() => setPresetsLoading(false))
  }, [])

  async function handleTokenBlur() {
    const t = token.trim()
    if (!t || !t.startsWith('xoxb-') || resolved) return
    setResolving(true)
    setError(null)
    try {
      const data = await api.integrations.resolveSlack(t)
      setResolved(data)
      setSelectedChannel(data.channels[0]?.id ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to validate token')
    } finally {
      setResolving(false)
    }
  }

  function handleTokenChange(value: string) {
    setToken(value)
    if (resolved) {
      setResolved(null)
      setSelectedChannel('')
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!token || !selectedChannel || !resolved) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    const channel = resolved.channels.find((c) => c.id === selectedChannel)
    try {
      await api.integrations.saveSlack({
        bot_token: token.trim(),
        default_channel: channel ? `#${channel.name}` : selectedChannel,
        workspace_name: resolved.workspace_name,
      })
      const status = await api.integrations.getSlack()
      setSlack(status)
      setToken('')
      setResolved(null)
      setSelectedChannel('')
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function requestDisconnect() {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current)
    setConfirmingDisconnect(true)
    disconnectTimerRef.current = setTimeout(() => setConfirmingDisconnect(false), 4000)
  }

  function cancelDisconnect() {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current)
    setConfirmingDisconnect(false)
  }

  async function handleDisconnect() {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current)
    setConfirmingDisconnect(false)
    setDisconnecting(true)
    setError(null)
    try {
      await api.integrations.deleteSlack()
      setSlack({ connected: false })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed')
    } finally {
      setDisconnecting(false)
    }
  }

  async function handleAddPreset(e: React.FormEvent) {
    e.preventDefault()
    if (!newPreset.name.trim() || !newPreset.slug.trim()) return
    setSavingPreset(true)
    setPresetsError(null)
    try {
      const created = await api.servicePresets.create({
        name: newPreset.name.trim(),
        slug: newPreset.slug.trim(),
        auth_type: newPreset.auth_type,
        base_url: newPreset.base_url.trim() || undefined,
      })
      setPresets((ps) => [...ps, created])
      setNewPreset({ name: '', slug: '', auth_type: 'none', base_url: '' })
      setAddingPreset(false)
    } catch (e) {
      setPresetsError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingPreset(false)
    }
  }

  function requestDeletePreset(id: string) {
    if (deletePresetTimerRef.current) clearTimeout(deletePresetTimerRef.current)
    setConfirmingDeletePreset(id)
    deletePresetTimerRef.current = setTimeout(() => setConfirmingDeletePreset(null), 4000)
  }

  function cancelDeletePreset() {
    if (deletePresetTimerRef.current) clearTimeout(deletePresetTimerRef.current)
    setConfirmingDeletePreset(null)
  }

  async function handleDeletePreset(id: string) {
    if (deletePresetTimerRef.current) clearTimeout(deletePresetTimerRef.current)
    setConfirmingDeletePreset(null)
    const item = presets.find((p) => p.id === id)
    setRemovingPresetId(id)
    removePresetTimerRef.current = setTimeout(() => {
      setPresets((ps) => ps.filter((p) => p.id !== id))
      setRemovingPresetId(null)
    }, 150)
    try {
      await api.servicePresets.delete(id)
    } catch (e) {
      if (removePresetTimerRef.current) clearTimeout(removePresetTimerRef.current)
      setRemovingPresetId(null)
      if (item) setPresets((ps) => ps.find((p) => p.id === id) ? ps : [...ps, item])
      setPresetsError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-graphite">Integrations</h1>
          <p className="mt-1 text-sm text-gray-500">Connect external services for alerts and notifications.</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="max-w-lg space-y-4">

        {/* Slack card */}
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Slack logo */}
              <svg className="h-8 w-8" viewBox="0 0 54 54" fill="none">
                <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
                <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
                <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
                <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A"/>
              </svg>
              <div>
                <p className="font-semibold text-graphite">Slack</p>
                <p className="text-sm text-gray-500">Failure alerts and circuit breaker notifications</p>
              </div>
            </div>
            {loading ? null : slack?.connected ? (
              <span className="flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                <CheckCircle className="h-3.5 w-3.5" />
                Connected
              </span>
            ) : (
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
                Not connected
              </span>
            )}
          </div>

          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-8 w-28 rounded-lg" />
            </div>
          ) : slack?.connected ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-gray-50 p-3 text-sm">
                {slack.workspace_name && (
                  <p className="text-gray-600">Workspace: <span className="font-medium text-graphite">{slack.workspace_name}</span></p>
                )}
                <p className="text-gray-600">Default channel: <span className="font-medium text-graphite">{slack.default_channel}</span></p>
                {slack.updated_by_email && (
                  <p className="mt-1 text-xs text-gray-400">Connected by {slack.updated_by_email}</p>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Alerts fire on transient + permanent errors. Business rejections never alert.
                Override channel per-workflow in the canvas editor.
              </p>
              {confirmingDisconnect ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    <Unlink className="h-4 w-4" />
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                  <button onClick={cancelDisconnect} className="text-sm text-gray-400 hover:text-gray-600">
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={requestDisconnect}
                  disabled={disconnecting}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Unlink className="h-4 w-4" />
                  Disconnect
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Bot token</label>
                <div className="relative">
                  <input
                    type="password"
                    className="input w-full pr-10 font-mono"
                    placeholder="xoxb-..."
                    value={token}
                    onChange={(e) => handleTokenChange(e.target.value)}
                    onBlur={handleTokenBlur}
                    required
                  />
                  {resolving && (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" />
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-400">
                  Slack App → OAuth & Permissions → Bot User OAuth Token.
                  Requires <code className="rounded bg-gray-100 px-1">chat:write</code>, <code className="rounded bg-gray-100 px-1">channels:read</code>, and <code className="rounded bg-gray-100 px-1">groups:read</code> scopes.
                </p>
              </div>

              {resolved && (
                <>
                  <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                    Connected to <span className="font-medium">{resolved.workspace_name}</span>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Default alert channel</label>
                    {resolved.channels.length > 0 ? (
                      <select
                        className="input w-full"
                        value={selectedChannel}
                        onChange={(e) => setSelectedChannel(e.target.value)}
                        required
                      >
                        {resolved.channels.map((ch) => (
                          <option key={ch.id} value={ch.id}>#{ch.name}</option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-xs text-gray-500">No public channels found. Make sure the bot has <code className="rounded bg-gray-100 px-1">channels:read</code> scope.</p>
                    )}
                  </div>
                </>
              )}

              {success && (
                <p className="result-success text-sm text-green-600">Slack connected successfully.</p>
              )}

              <button
                type="submit"
                disabled={saving || !resolved || !selectedChannel}
                className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
              >
                {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</> : 'Connect Slack'}
              </button>
            </form>
          )}
        </div>

        </div> {/* end slack card wrapper */}

        {/* HTTP Services */}
        <div className="mt-10">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-graphite">HTTP Services</h2>
              <p className="mt-0.5 text-sm text-gray-500">
                Define reusable services that appear in the Webhook node dropdown. Each preset pre-fills the auth type and optionally the base URL.
              </p>
            </div>
            <button
              onClick={() => setAddingPreset(true)}
              disabled={addingPreset}
              className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-0 disabled:pointer-events-none"
            >
              <Plus className="h-4 w-4" />
              Add service
            </button>
          </div>

          {presetsError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {presetsError}
            </div>
          )}

          <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${addingPreset ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="min-h-0 overflow-hidden">
            <form
              onSubmit={handleAddPreset}
              className="mb-6 rounded-xl border border-gray-200 bg-white p-5"
              inert={!addingPreset || undefined}
            >
              <p className="mb-4 text-sm font-medium text-gray-400">New service</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Display name</label>
                  <input
                    ref={presetNameInputRef}
                    className="input w-full"
                    placeholder="My CRM"
                    value={newPreset.name}
                    onChange={(e) => {
                      const name = e.target.value
                      setNewPreset((p) => ({
                        ...p,
                        name,
                        slug: p.slug === slugify(p.name) ? slugify(name) : p.slug,
                      }))
                    }}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Slug (used in workflows)</label>
                  <input
                    className="input w-full font-mono"
                    placeholder="my_crm"
                    value={newPreset.slug}
                    onChange={(e) => setNewPreset((p) => ({ ...p, slug: slugify(e.target.value) }))}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Default auth type</label>
                  <select
                    className="input w-full"
                    value={newPreset.auth_type}
                    onChange={(e) => setNewPreset((p) => ({ ...p, auth_type: e.target.value }))}
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer token</option>
                    <option value="basic">Basic (username + password)</option>
                    <option value="api_key">API key header</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Base URL <span className="font-normal text-gray-400">(optional)</span></label>
                  <input
                    className="input w-full font-mono"
                    placeholder="https://api.mycrm.com"
                    value={newPreset.base_url}
                    onChange={(e) => setNewPreset((p) => ({ ...p, base_url: e.target.value }))}
                  />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  disabled={savingPreset}
                  className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
                >
                  {savingPreset ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save service'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAddingPreset(false); setNewPreset({ name: '', slug: '', auth_type: 'none', base_url: '' }) }}
                  className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
                >
                  Cancel
                </button>
              </div>
            </form>
            </div>
          </div>

          {presetsLoading ? (
            <div className="space-y-2">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-4 py-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : presets.length === 0 && !addingPreset ? (
            <div className="rounded-xl border-2 border-dashed border-gray-200 py-10 text-center">
              <p className="text-sm font-semibold text-graphite">No services yet</p>
              <p className="mx-auto mt-1.5 max-w-sm text-xs text-gray-400">
                Add a service to make it available in the Webhook node dropdown with pre-filled auth settings.
              </p>
              <button
                onClick={() => setAddingPreset(true)}
                className="mt-4 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0]"
              >
                Add your first service
              </button>
            </div>
          ) : presets.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Slug</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Auth</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Base URL</th>
                    <th className="w-16 px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {presets.map((p) => (
                    <tr key={p.id} className={`env-row hover:bg-gray-50 ${removingPresetId === p.id ? 'opacity-0 -translate-y-1' : ''}`}>
                      <td className="px-4 py-3 font-medium text-graphite">{p.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.slug}</td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{p.auth_type.replace('_', ' ')}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-400">{p.base_url ?? '—'}</td>
                      <td className="px-4 py-3">
                        {confirmingDeletePreset === p.id ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleDeletePreset(p.id)}
                              className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                            >
                              Delete
                            </button>
                            <button onClick={cancelDeletePreset} className="text-xs text-gray-400 hover:text-gray-600">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => requestDeletePreset(p.id)}
                            className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                            title="Delete service"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

      </div>
    </NavLayout>
  )
}
