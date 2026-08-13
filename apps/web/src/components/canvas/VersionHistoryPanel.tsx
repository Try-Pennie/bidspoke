'use client'

import { useEffect, useRef, useState } from 'react'
import { X, RotateCcw, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'
import type { WorkflowVersion } from '@/types/workflow'
import RailResizeHandle from './RailResizeHandle'

interface Props {
  workflowId: string
  onClose: () => void
  onRestore: (versionId: string) => Promise<void>
  width: number
  onResize: (width: number) => void
  // Bumped by the canvas on every successful save so the open panel refetches
  // and shows the just-created version instead of a stale list (#241).
  refreshToken?: number
  // #494: restore overwrites the canvas outright, so unsaved edits are simply gone
  // and there is no undo across it. When the canvas is dirty the confirm has to say
  // so, instead of looking identical to a restore that costs nothing.
  isDirty?: boolean
}

// Longer than the clean 4s window: there is now a consequence to read before the
// destructive click, and letting it time out under someone mid-sentence just makes
// them click Restore twice (#494).
const CONFIRM_WINDOW_MS = 4000
const CONFIRM_WINDOW_DIRTY_MS = 8000

export default function VersionHistoryPanel({ workflowId, onClose, onRestore, width, onResize, refreshToken, isDirty = false }: Props) {
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refetch on mount, when the workflow changes, and whenever refreshToken bumps
  // (a save just landed). Don't toggle `loading` on a refresh — the initial
  // `loading=true` covers the first fetch, and a refresh shouldn't flash the
  // skeletons over an already-populated list.
  useEffect(() => {
    let cancelled = false
    api.versions.list(workflowId)
      .then((v) => { if (!cancelled) { setVersions(v); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load versions') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workflowId, refreshToken])

  // Clear the restore-confirm countdown on unmount.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function requestRestore(versionId: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    setConfirmingRestore(versionId)
    timerRef.current = setTimeout(
      () => setConfirmingRestore(null),
      isDirty ? CONFIRM_WINDOW_DIRTY_MS : CONFIRM_WINDOW_MS
    )
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
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-gray-200 bg-white"
      style={{ width: width }}
    >
      <RailResizeHandle width={width} onResize={onResize} />
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <p className="text-sm font-semibold text-graphite">Version history</p>
        <button onClick={onClose} aria-label="Close" className="rounded p-1 text-gray-500 hover:bg-gray-100">
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
            <p className="mt-1 text-xs text-gray-500">Save the workflow to create a snapshot. Versions let you roll back to any previous definition.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {versions.map((v) => (
              <li key={v.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-graphite">v{v.version_number}</p>
                    <p className="mt-0.5 truncate text-xs text-gray-500">
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
                        className="text-xs text-gray-500 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => requestRestore(v.id)}
                      disabled={!!restoring}
                      className="flex flex-shrink-0 items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-beige disabled:opacity-40"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </button>
                  )}
                </div>

                {/* The consequence, stated only when there IS one (#494). A warning
                    shown on every restore would be wallpaper, and the one time it
                    mattered nobody would read it. */}
                {confirmingRestore === v.id && isDirty && (
                  <p role="alert" className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    Restoring replaces the canvas. Your unsaved changes will be lost.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
