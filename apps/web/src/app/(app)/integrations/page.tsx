'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { CheckCircle, Unlink } from 'lucide-react'

interface SlackStatus {
  connected: boolean
  workspace_name?: string | null
  default_channel?: string | null
  updated_at?: string
  updated_by_email?: string | null
}

export default function IntegrationsPage() {
  const [slack, setSlack] = useState<SlackStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [form, setForm] = useState({ bot_token: '', default_channel: '', workspace_name: '' })

  useEffect(() => {
    api.integrations.getSlack()
      .then(setSlack)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.bot_token || !form.default_channel) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      await api.integrations.saveSlack(form)
      const status = await api.integrations.getSlack()
      setSlack(status)
      setForm({ bot_token: '', default_channel: '', workspace_name: '' })
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Slack? Failure alerts will stop immediately.')) return
    setDisconnecting(true)
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
          <h1 className="text-xl font-semibold text-gray-900">Integrations</h1>
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
                Alert on: transient + permanent errors. Business rejections never alert.
                Override channel per-workflow in the canvas editor settings.
              </p>
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <Unlink className="h-4 w-4" />
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Bot token
                </label>
                <input
                  type="password"
                  className="input w-full font-mono"
                  placeholder="xoxb-..."
                  value={form.bot_token}
                  onChange={(e) => setForm({ ...form, bot_token: e.target.value })}
                  required
                />
                <p className="mt-1 text-xs text-gray-400">
                  From your Slack App → OAuth & Permissions → Bot User OAuth Token.
                  Requires <code className="rounded bg-gray-100 px-1">chat:write</code> scope.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Default alert channel
                </label>
                <input
                  className="input w-full"
                  placeholder="#alerts"
                  value={form.default_channel}
                  onChange={(e) => setForm({ ...form, default_channel: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Workspace name (optional)
                </label>
                <input
                  className="input w-full"
                  placeholder="My Company"
                  value={form.workspace_name}
                  onChange={(e) => setForm({ ...form, workspace_name: e.target.value })}
                />
              </div>
              {success && (
                <p className="text-sm text-green-600">Slack connected successfully.</p>
              )}
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Connect Slack'}
              </button>
            </form>
          )}
        </div>
      </div>
    </NavLayout>
  )
}
