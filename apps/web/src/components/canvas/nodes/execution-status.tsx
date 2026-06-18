import type { CSSProperties } from 'react'
import type { ExecutionStep } from '@/types/workflow'

export function getExecutionClasses(exec: ExecutionStep | null | undefined): string {
  if (exec === undefined) return ''
  if (exec === null) return 'opacity-25 pointer-events-none'
  switch (exec.status) {
    case 'completed':            return 'ring-2 ring-green-400 ring-offset-1'
    case 'failed':               return 'ring-2 ring-red-500 ring-offset-1'
    case 'skipped':              return 'ring-2 ring-gray-300 ring-offset-1 opacity-50'
    case 'failed_with_fallback': return 'ring-2 ring-yellow-400 ring-offset-1'
    case 'running':              return 'ring-2 ring-blue-400 ring-offset-1 animate-pulse'
    default:                     return ''
  }
}

export function getExecutionStyle(exec: ExecutionStep | null | undefined): CSSProperties {
  if (!exec) return {}
  switch (exec.status) {
    case 'completed':            return { backgroundColor: '#f0fdf4' } // green-50
    case 'failed':               return { backgroundColor: '#fef2f2' } // red-50
    case 'failed_with_fallback': return { backgroundColor: '#fefce8' } // yellow-50
    default:                     return {}
  }
}

/**
 * Use instead of getExecutionClasses when validation error state also applies.
 * Execution state always takes precedence over validation indicators.
 * `isReachable` is accepted for back-compat but no longer dims the node —
 * we keep all nodes looking uniform regardless of graph context, so the
 * grey region backdrop is the only visual signal of nesting / orphans.
 */
export function getNodeClasses(
  exec: ExecutionStep | null | undefined,
  hasError?: boolean,
  _isReachable?: boolean
): string {
  if (exec !== undefined) return getExecutionClasses(exec)
  // Unconfigured / invalid node: a throbbing amber glow (see .node-warning in
  // globals.css) so it stays findable when the canvas is zoomed out on a large
  // workflow. The animated box-shadow overrides each node's static inline ring.
  if (hasError) return 'node-warning'
  return ''
}

/** Returns a one-line output preview for a completed step, e.g. "status: 200" */
export function getOutputPreview(exec: ExecutionStep | null | undefined): string | null {
  if (!exec || exec.status !== 'completed') return null
  const out = exec.output
  if (out === null || out === undefined) return null
  if (typeof out === 'string') return out.slice(0, 40)
  if (typeof out === 'number' || typeof out === 'boolean') return String(out)
  if (typeof out === 'object') {
    const keys = Object.keys(out as object)
    if (keys.length === 0) return null
    const key = keys[0]
    const val = (out as Record<string, unknown>)[key]
    const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val)
    return `${key}: ${valStr.slice(0, 32)}`
  }
  return null
}
