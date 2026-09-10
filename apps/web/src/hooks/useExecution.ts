'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { archiveUnavailableFrom, isNotFoundError } from '@/lib/execution-retention'
import { isRunningStatus } from '@/lib/execution-status'

type Execution = Awaited<ReturnType<typeof api.executions.get>>

/**
 * Poll interval while an execution is still running (#477 / AUD-012). Real runs
 * finish in seconds (prod p50 ~1.7s), so a 3s poll surfaces completion promptly
 * without hammering the API.
 */
export const POLL_INTERVAL_MS = 3_000

interface UseExecutionResult {
  execution: Execution | null
  loading: boolean
  error: string | null
  notFound: boolean
  /**
   * Set when the archive could not be reached (#874). Distinct from notFound,
   * because "we could not look" and "it never existed" are different answers
   * and only one of them is worth retrying.
   */
  archiveUnavailable: { waitingFor: string; detail: string } | null
  /** Retries the load. The archive-unavailable state is the one worth offering it on. */
  reload: () => void
}

/**
 * Loads an execution and keeps it fresh while it is running. Refetches every
 * POLL_INTERVAL_MS until the status turns terminal (anything other than
 * `running`), so a live badge updates and a finished run stops the poll.
 *
 * Resetting on executionId change matters because replay-lineage links navigate
 * to a different executionId on the same route segment (this component instance
 * is reused). A cancellation flag guards against a slower earlier request or a
 * late poll overwriting newer data / setState-after-unmount (#101).
 */
export function useExecution(executionId: string): UseExecutionResult {
  const [execution, setExecution] = useState<Execution | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [archiveUnavailable, setArchiveUnavailable] =
    useState<{ waitingFor: string; detail: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    setExecution(null)
    setError(null)
    setNotFound(false)
    setArchiveUnavailable(null)
    setLoading(true)

    const load = () => {
      api.executions.get(executionId)
        .then((e) => {
          if (cancelled) return
          setExecution(e)
          setError(null)
          setNotFound(false)
          setArchiveUnavailable(null)
          // Keep polling only while the run is still in progress.
          if (isRunningStatus(e.status)) {
            timer = setTimeout(load, POLL_INTERVAL_MS)
          }
        })
        .catch((e) => {
          if (cancelled) return
          setError(e.message)
          setNotFound(isNotFoundError(e))
          setArchiveUnavailable(archiveUnavailableFrom(e))
          // Stop polling on error — an errored fetch (incl. not-found) is terminal
          // for this view; the user can reload if they want to retry.
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }

    load()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [executionId, attempt])

  return {
    execution,
    loading,
    error,
    notFound,
    archiveUnavailable,
    reload: () => setAttempt((n) => n + 1),
  }
}
