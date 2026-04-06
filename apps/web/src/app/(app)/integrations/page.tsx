'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { CheckCircle, Unlink, Loader2 } from 'lucide-react'

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

  useEffect(() => {
    api.integrations.getSlack()
      .then(setSlack)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
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

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">Integrations</h1>
          <p className="mt-1 text-sm text-gray-500">Connect external services for alerts and notifications.</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Slack card */}
        <div className="max-w-xl rounded-xl border border-gray-200 bg-white p-6">
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
                <p className="font-semibold text-gray-900">Slack</p>
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
            <p className="text-sm text-gray-400">Loading…</p>
          ) : slack?.connected ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-gray-50 p-3 text-sm">
                {slack.workspace_name && (
                  <p className="text-gray-600">Workspace: <span className="font-medium text-gray-900">{slack.workspace_name}</span></p>
                )}
                <p className="text-gray-600">Default channel: <span className="font-medium text-gray-900">{slack.default_channel}</span></p>
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
                <p className="text-sm text-green-600">Slack connected successfully.</p>
              )}

              <button
                type="submit"
                disabled={saving || !resolved || !selectedChannel}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Connecting…' : 'Connect Slack'}
              </button>
            </form>
          )}
        </div>
      </div>
    </NavLayout>
  )
}
