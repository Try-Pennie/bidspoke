'use client'

export const runtime = 'edge'

import { useEffect, useId, useRef, useState } from 'react'
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
  volume_alerts_enabled?: boolean
  matrix_alerts_enabled?: boolean
  config_alerts_enabled?: boolean
  backup_alerts_enabled?: boolean
  matrix_alerts_channel?: string | null
  updated_at?: string
  updated_by_email?: string | null
}

type ChannelKind = 'default' | 'matrix'

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

  // Inline channel editor (shown only when Slack is already connected).
  // Type-to-search: query Slack only after >= 3 chars, debounced.
  // Editing kind tells us which field to save (default vs matrix-alerts override).
  const [editingChannel, setEditingChannel] = useState<ChannelKind | null>(null)
  const [channelQuery, setChannelQuery] = useState('')
  const [channelResults, setChannelResults] = useState<Array<{ id: string; name: string }>>([])
  const [searchingChannels, setSearchingChannels] = useState(false)
  const [pendingChannel, setPendingChannel] = useState('')  // selected #name to save
  const [savingChannel, setSavingChannel] = useState(false)
  const channelInputRef = useRef<HTMLInputElement | null>(null)

  const botTokenId = useId()
  const alertChannelId = useId()
  const presetNameId = useId()
  const presetSlugId = useId()
  const presetAuthTypeId = useId()
  const presetBaseUrlId = useId()

  useEffect(() => {
    if (!editingChannel) return
    const q = channelQuery.trim()
    if (q.length < 3) {
      setChannelResults([])
      setSearchingChannels(false)
      return
    }
    setSearchingChannels(true)
    const t = setTimeout(async () => {
      try {
        const data = await api.integrations.searchSlackChannels(q)
        setChannelResults(data.channels)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Channel search failed')
      } finally {
        setSearchingChannels(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [channelQuery, editingChannel])

  useEffect(() => {
    if (editingChannel !== null) {
      const frame = requestAnimationFrame(() => channelInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [editingChannel])

  function exitChannelEditor() {
    setEditingChannel(null)
    setChannelQuery('')
    setChannelResults([])
    setPendingChannel('')
  }

  async function saveEditingChannel() {
    if (!editingChannel || !slack) return
    const valueToSave = pendingChannel || (editingChannel === 'matrix' ? '' : '')
    if (editingChannel === 'default' && !valueToSave) return
    setSavingChannel(true)
    const prevDefault = slack.default_channel
    const prevMatrix = slack.matrix_alerts_channel ?? null
    if (editingChannel === 'default') {
      setSlack((s) => (s ? { ...s, default_channel: valueToSave } : s))
    } else {
      setSlack((s) => (s ? { ...s, matrix_alerts_channel: valueToSave || null } : s))
    }
    try {
      if (editingChannel === 'default') {
        await api.integrations.updateSlackSettings({ default_channel: valueToSave })
      } else {
        await api.integrations.updateSlackSettings({ matrix_alerts_channel: valueToSave || null })
      }
      exitChannelEditor()
    } catch (e) {
      setSlack((s) => (s ? { ...s, default_channel: prevDefault, matrix_alerts_channel: prevMatrix } : s))
      setError(e instanceof Error ? e.message : 'Failed to update channel')
    } finally {
      setSavingChannel(false)
    }
  }

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
              <div className="rounded-lg bg-beige p-3 text-sm">
                {slack.workspace_name && (
                  <p className="text-gray-600">Workspace: <span className="font-medium text-graphite">{slack.workspace_name}</span></p>
                )}
                {editingChannel === 'default' ? (
                  <div className="mt-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-600">Default channel:</span>
                      <input
                        ref={channelInputRef}
                        className="input flex-1 py-1 text-sm"
                        placeholder="Type at least 3 characters to search"
                        value={channelQuery}
                        onChange={(e) => {
                          setChannelQuery(e.target.value)
                          setPendingChannel('')
                        }}
                        disabled={savingChannel}
                      />
                      <button
                        onClick={saveEditingChannel}
                        disabled={!pendingChannel || savingChannel}
                        className="rounded-lg bg-p-blue-dark px-3 py-1 text-xs font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
                      >
                        {savingChannel ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={exitChannelEditor}
                        disabled={savingChannel}
                        className="text-xs text-gray-500 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                    {channelQuery.trim().length >= 3 && (
                      <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                        {searchingChannels ? (
                          <p className="px-3 py-2 text-xs text-gray-500">Searching…</p>
                        ) : channelResults.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-gray-500">No channels match.</p>
                        ) : (
                          <ul className="divide-y divide-gray-100">
                            {channelResults.map((ch) => {
                              const value = `#${ch.name}`
                              const selected = pendingChannel === value
                              return (
                                <li key={ch.id}>
                                  <button
                                    onClick={() => setPendingChannel(value)}
                                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${selected ? 'bg-p-blue-light/10 text-p-blue-dark' : 'text-graphite'}`}
                                  >
                                    <span>#{ch.name}</span>
                                    {selected && <CheckCircle className="h-3.5 w-3.5" />}
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-600">
                    Default channel: <span className="font-medium text-graphite">{slack.default_channel}</span>
                    <button
                      onClick={() => setEditingChannel('default')}
                      className="ml-2 text-xs text-p-blue-dark hover:underline"
                    >
                      Change
                    </button>
                  </p>
                )}
                {slack.updated_by_email && (
                  <p className="mt-1 text-xs text-gray-500">Connected by {slack.updated_by_email}</p>
                )}
              </div>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 p-3">
                <div className="text-sm">
                  <p className="font-medium text-graphite">Volume anomaly alerts</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Daily check for unexpectedly high or low execution volume. Turn off during testing or low-traffic periods.
                  </p>
                </div>
                <SlackToggle
                  checked={slack.volume_alerts_enabled !== false}
                  onChange={async (next) => {
                    setSlack((s) => (s ? { ...s, volume_alerts_enabled: next } : s))
                    try {
                      await api.integrations.updateSlackSettings({ volume_alerts_enabled: next })
                    } catch (e) {
                      setSlack((s) => (s ? { ...s, volume_alerts_enabled: !next } : s))
                      setError(e instanceof Error ? e.message : 'Failed to update setting')
                    }
                  }}
                  label="Volume anomaly alerts"
                />
              </div>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 p-3">
                <div className="text-sm">
                  <p className="font-medium text-graphite">Configuration warning alerts</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Daily audit that flags live workflow nodes whose timeout is below the reliable floor for their type. Turn off to mute the digest.
                  </p>
                </div>
                <SlackToggle
                  checked={slack.config_alerts_enabled !== false}
                  onChange={async (next) => {
                    setSlack((s) => (s ? { ...s, config_alerts_enabled: next } : s))
                    try {
                      await api.integrations.updateSlackSettings({ config_alerts_enabled: next })
                    } catch (e) {
                      setSlack((s) => (s ? { ...s, config_alerts_enabled: !next } : s))
                      setError(e instanceof Error ? e.message : 'Failed to update setting')
                    }
                  }}
                  label="Configuration warning alerts"
                />
              </div>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 p-3">
                <div className="text-sm">
                  <p className="font-medium text-graphite">Backup failure alerts</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Warns when workflow backups to GitHub keep failing (an expired token, wrong repo, or GitHub outage). Protects the off-Supabase copy of every workflow. Separate from configuration warnings so muting noise can&apos;t silently disable it.
                  </p>
                </div>
                <SlackToggle
                  checked={slack.backup_alerts_enabled !== false}
                  onChange={async (next) => {
                    setSlack((s) => (s ? { ...s, backup_alerts_enabled: next } : s))
                    try {
                      await api.integrations.updateSlackSettings({ backup_alerts_enabled: next })
                    } catch (e) {
                      setSlack((s) => (s ? { ...s, backup_alerts_enabled: !next } : s))
                      setError(e instanceof Error ? e.message : 'Failed to update setting')
                    }
                  }}
                  label="Backup failure alerts"
                />
              </div>
              <div className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="text-sm">
                    <p className="font-medium text-graphite">Bid matrix change alerts</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Posted at the top of every hour when the Salesforce bid matrix has any rows added, edited, or removed since the last sync. Pick a separate channel below, or leave empty to use the default channel.
                    </p>
                  </div>
                  <SlackToggle
                    checked={slack.matrix_alerts_enabled !== false}
                    onChange={async (next) => {
                      setSlack((s) => (s ? { ...s, matrix_alerts_enabled: next } : s))
                      try {
                        await api.integrations.updateSlackSettings({ matrix_alerts_enabled: next })
                      } catch (e) {
                        setSlack((s) => (s ? { ...s, matrix_alerts_enabled: !next } : s))
                        setError(e instanceof Error ? e.message : 'Failed to update setting')
                      }
                    }}
                    label="Bid matrix change alerts"
                  />
                </div>
                {editingChannel === 'matrix' ? (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        ref={channelInputRef}
                        className="input flex-1 py-1 text-sm"
                        placeholder="Type at least 3 characters to search"
                        value={channelQuery}
                        onChange={(e) => {
                          setChannelQuery(e.target.value)
                          setPendingChannel('')
                        }}
                        disabled={savingChannel}
                      />
                      <button
                        onClick={saveEditingChannel}
                        disabled={!pendingChannel || savingChannel}
                        className="rounded-lg bg-p-blue-dark px-3 py-1 text-xs font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
                      >
                        {savingChannel ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={exitChannelEditor}
                        disabled={savingChannel}
                        className="text-xs text-gray-500 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                    {channelQuery.trim().length >= 3 && (
                      <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                        {searchingChannels ? (
                          <p className="px-3 py-2 text-xs text-gray-500">Searching…</p>
                        ) : channelResults.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-gray-500">No channels match.</p>
                        ) : (
                          <ul className="divide-y divide-gray-100">
                            {channelResults.map((ch) => {
                              const value = `#${ch.name}`
                              const selected = pendingChannel === value
                              return (
                                <li key={ch.id}>
                                  <button
                                    onClick={() => setPendingChannel(value)}
                                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${selected ? 'bg-p-blue-light/10 text-p-blue-dark' : 'text-graphite'}`}
                                  >
                                    <span>#{ch.name}</span>
                                    {selected && <CheckCircle className="h-3.5 w-3.5" />}
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2 text-sm text-gray-600">
                    <span>
                      {slack.matrix_alerts_channel
                        ? <>Channel: <span className="font-medium text-graphite">{slack.matrix_alerts_channel}</span></>
                        : <span className="text-gray-500">Using default channel</span>}
                    </span>
                    <button
                      onClick={() => setEditingChannel('matrix')}
                      className="text-xs text-p-blue-dark hover:underline"
                    >
                      {slack.matrix_alerts_channel ? 'Change' : 'Set channel'}
                    </button>
                    {slack.matrix_alerts_channel && (
                      <button
                        onClick={async () => {
                          const prev = slack.matrix_alerts_channel ?? null
                          setSlack((s) => (s ? { ...s, matrix_alerts_channel: null } : s))
                          try {
                            await api.integrations.updateSlackSettings({ matrix_alerts_channel: null })
                          } catch (e) {
                            setSlack((s) => (s ? { ...s, matrix_alerts_channel: prev } : s))
                            setError(e instanceof Error ? e.message : 'Failed to clear channel')
                          }
                        }}
                        className="text-xs text-gray-500 hover:text-gray-600"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Failure alerts fire on transient + permanent errors. Business rejections never alert.
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
                  <button onClick={cancelDisconnect} className="text-sm text-gray-500 hover:text-gray-600">
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
                <label htmlFor={botTokenId} className="mb-1 block text-xs font-medium text-gray-600">Bot token</label>
                <div className="relative">
                  <input
                    id={botTokenId}
                    type="password"
                    className="input w-full pr-10 font-mono"
                    placeholder="xoxb-..."
                    value={token}
                    onChange={(e) => handleTokenChange(e.target.value)}
                    onBlur={handleTokenBlur}
                    required
                  />
                  {resolving && (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-500" />
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
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
                    <label htmlFor={alertChannelId} className="mb-1 block text-xs font-medium text-gray-600">Default alert channel</label>
                    {resolved.channels.length > 0 ? (
                      <select
                        id={alertChannelId}
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
                className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
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
              className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#155E99] disabled:opacity-0 disabled:pointer-events-none"
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
              <p className="mb-4 text-sm font-medium text-gray-500">New service</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor={presetNameId} className="mb-1 block text-xs font-medium text-gray-600">Display name</label>
                  <input
                    id={presetNameId}
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
                  <label htmlFor={presetSlugId} className="mb-1 block text-xs font-medium text-gray-600">Slug (used in workflows)</label>
                  <input
                    id={presetSlugId}
                    className="input w-full font-mono"
                    placeholder="my_crm"
                    value={newPreset.slug}
                    onChange={(e) => setNewPreset((p) => ({ ...p, slug: slugify(e.target.value) }))}
                    required
                  />
                </div>
                <div>
                  <label htmlFor={presetAuthTypeId} className="mb-1 block text-xs font-medium text-gray-600">Default auth type</label>
                  <select
                    id={presetAuthTypeId}
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
                  <label htmlFor={presetBaseUrlId} className="mb-1 block text-xs font-medium text-gray-600">Base URL <span className="font-normal text-gray-500">(optional)</span></label>
                  <input
                    id={presetBaseUrlId}
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
                  className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
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
              <p className="mx-auto mt-1.5 max-w-sm text-xs text-gray-500">
                Add a service to make it available in the Webhook node dropdown with pre-filled auth settings.
              </p>
              <button
                onClick={() => setAddingPreset(true)}
                className="mt-4 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#155E99]"
              >
                Add your first service
              </button>
            </div>
          ) : presets.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-beige">
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
                    <tr key={p.id} className={`env-row hover:bg-beige ${removingPresetId === p.id ? 'opacity-0 -translate-y-1' : ''}`}>
                      <td className="px-4 py-3 font-medium text-graphite">{p.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.slug}</td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{p.auth_type.replace('_', ' ')}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.base_url ?? '—'}</td>
                      <td className="px-4 py-3">
                        {confirmingDeletePreset === p.id ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleDeletePreset(p.id)}
                              className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                            >
                              Delete
                            </button>
                            <button onClick={cancelDeletePreset} className="text-xs text-gray-500 hover:text-gray-600">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => requestDeletePreset(p.id)}
                            className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-500"
                            aria-label="Delete service"
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

function SlackToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark focus-visible:ring-offset-1 ${checked ? 'bg-p-blue-dark' : 'bg-gray-200'}`}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}
