import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'

/**
 * Per-namespace timeout suggestions for the canvas, fetched once per workflow
 * via the batched endpoint (one grouped percentile query server-side) instead
 * of a step-duration-stats round-trip per node. Best-effort: on fetch failure
 * the map stays empty and only the local sub-floor badge renders.
 */
export interface NodeTimeoutSuggestion {
  suggested_ms: number
  /** Flag threshold: suggested_ms x tolerance, so at-suggested configs don't flap. */
  warn_below_ms: number
  p99: number
  max_ms: number
  retries: number
  sample_size: number
}

const TimeoutSuggestionsContext = createContext<Map<string, NodeTimeoutSuggestion>>(new Map())

export function useTimeoutSuggestion(namespace: string | undefined): NodeTimeoutSuggestion | undefined {
  const map = useContext(TimeoutSuggestionsContext)
  return namespace ? map.get(namespace) : undefined
}

export function TimeoutSuggestionsProvider({ workflowId, children }: { workflowId: string; children: ReactNode }) {
  const [map, setMap] = useState<Map<string, NodeTimeoutSuggestion>>(new Map())

  useEffect(() => {
    let cancelled = false
    api.workflows
      .timeoutSuggestions(workflowId)
      .then((res) => {
        if (cancelled) return
        setMap(new Map(res.nodes.map((n) => [n.namespace, n])))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workflowId])

  return <TimeoutSuggestionsContext.Provider value={map}>{children}</TimeoutSuggestionsContext.Provider>
}
