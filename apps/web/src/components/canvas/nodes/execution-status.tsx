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
