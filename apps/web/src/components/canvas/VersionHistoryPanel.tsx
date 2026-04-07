'use client'

import { useEffect, useRef, useState } from 'react'
import { X, RotateCcw, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'
import type { WorkflowVersion } from '@/types/workflow'

interface Props {
  workflowId: string
  onClose: () => void
  onRestore: (versionId: string) => Promise<void>
}

export default function VersionHistoryPanel({ workflowId, onClose, onRestore }: Props) {
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.versions.list(workflowId)
      .then(setVersions)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load versions'))
      .finally(() => setLoading(false))
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [workflowId])

  function requestRestore(versionId: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    setConfirmingRestore(versionId)
    timerRef.current = setTimeout(() => setConfirmingRestore(null), 4000)
  }

  function cancelRestore() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setConfirmingRestore(null)
  }

  async function handleRestore(versionId: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    setConfirmingRestore(null)
    setRestoring(versionId)
    setError(null)
    try {
      await onRestore(versionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
      setRestoring(null)
    }
  }

  return (
    <aside className="flex h-full w-80 flex-shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <p className="text-sm font-semibold text-gray-900">Version history</p>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <ul className="divide-y divide-gray-50">
            {[...Array(4)].map((_, i) => (
              <li key={i} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1.5">
                    <Skeleton className="h-3 w-6" />
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                  <Skeleton className="h-6 w-14 rounded" />
                </div>
              </li>
            ))}
          </ul>
        ) : versions.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-xs font-medium text-gray-500">No versions yet</p>
            <p className="mt-1 text-xs text-gray-400">Save the workflow to create a snapshot. Versions let you roll back to any previous definition.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {versions.map((v) => (
              <li key={v.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-900">v{v.version_number}</p>
                    <p className="mt-0.5 truncate text-xs text-gray-400">
                      {v.message ?? 'No message'}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-300">
                      {formatDatetime(v.created_at)}
                    </p>
                  </div>

                  {confirmingRestore === v.id ? (
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => handleRestore(v.id)}
                        disabled={restoring === v.id}
                        className="rounded bg-amber-500 px-2 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                      >
                        {restoring === v.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'Restore'
                        )}
                      </button>
                      <button
                        onClick={cancelRestore}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => requestRestore(v.id)}
                      disabled={!!restoring}
                      className="flex flex-shrink-0 items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
