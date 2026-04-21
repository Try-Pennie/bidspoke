'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { createClient } from '@/lib/supabase/client'
import { UserPlus, Trash2, Shield } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

interface AllowedUser {
  email: string
  added_by: string
  added_at: string
}

export default function AccessPage() {
  const [users, setUsers] = useState<AllowedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentEmail, setCurrentEmail] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [saving, setSaving] = useState(false)

  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setCurrentEmail(data.user?.email ?? null)
    })
    load()
  }, [])

  async function load() {
    try {
      const data = await api.access.list()
      setUsers(data.filter((u) => u.email !== 'e2e-test@trypennie.com'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load access list')
    } finally {
      setLoading(false)
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const email = newEmail.trim().toLowerCase()
    if (!email) return
    if (!email.endsWith('@trypennie.com')) {
      setError('Only @trypennie.com addresses are permitted')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.access.add(email)
      setNewEmail('')
      setAdding(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add user')
    } finally {
      setSaving(false)
    }
  }

  function requestRemove(email: string) {
    if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
    setConfirmingRemove(email)
    removeTimerRef.current = setTimeout(() => setConfirmingRemove(null), 4000)
  }

  async function handleRemove(email: string) {
    if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
    setConfirmingRemove(null)
    setRemoving(email)
    setError(null)
    try {
      await api.access.remove(email)
      setUsers((prev) => prev.filter((u) => u.email !== email))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove user')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-graphite">Access</h1>
            <p className="mt-1 text-sm text-gray-500">
              Only these accounts can sign in. All addresses must be <span className="font-mono text-xs bg-gray-100 rounded px-1">@trypennie.com</span>.
            </p>
          </div>
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0]"
            >
              <UserPlus className="h-4 w-4" />
              Add user
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {adding && (
          <form
            onSubmit={handleAdd}
            className="mb-6 flex items-end gap-3 rounded-xl border border-gray-200 bg-white p-4"
          >
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Email address</label>
              <input
                className="input w-full"
                placeholder="name@trypennie.com"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                autoFocus
                required
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewEmail(''); setError(null) }}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-beige"
            >
              Cancel
            </button>
          </form>
        )}

        <div className="max-w-xl rounded-xl border border-gray-200 bg-white overflow-hidden">
          {loading ? (
            <div className="divide-y divide-gray-100">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-7 w-16 rounded-lg" />
                </div>
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center">
              <Shield className="mx-auto mb-3 h-6 w-6 text-gray-300" />
              <p className="text-sm text-gray-500">No users on the allowlist.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {users.map((u) => (
                <li key={u.email} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-graphite">{u.email}</p>
                    <p className="text-xs text-gray-400">
                      Added {new Date(u.added_at).toLocaleDateString()} by {u.added_by}
                    </p>
                  </div>
                  {u.email === currentEmail ? (
                    <span className="shrink-0 rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-400">you</span>
                  ) : confirmingRemove === u.email ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => handleRemove(u.email)}
                        disabled={removing === u.email}
                        className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                      >
                        {removing === u.email ? 'Removing…' : 'Remove'}
                      </button>
                      <button
                        onClick={() => { clearTimeout(removeTimerRef.current!); setConfirmingRemove(null) }}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => requestRemove(u.email)}
                      className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:border-red-200 hover:bg-red-50 hover:text-red-500"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </NavLayout>
  )
}
