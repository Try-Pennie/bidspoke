import { CheckCircle, XCircle, SkipForward, Clock, RefreshCw } from 'lucide-react'
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

const BADGE_CONFIG = {
  completed:            { icon: CheckCircle,  cls: 'bg-green-500' },
  failed:               { icon: XCircle,      cls: 'bg-red-500'   },
  skipped:              { icon: SkipForward,  cls: 'bg-gray-400'  },
  running:              { icon: Clock,        cls: 'bg-blue-500'  },
  failed_with_fallback: { icon: RefreshCw,    cls: 'bg-yellow-500'},
}

export function ExecutionBadge({ exec }: { exec: ExecutionStep | null | undefined }) {
  if (!exec) return null
  const cfg = BADGE_CONFIG[exec.status as keyof typeof BADGE_CONFIG]
  if (!cfg) return null
  const Icon = cfg.icon
  return (
    <span className={`absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-white shadow ${cfg.cls}`}>
      <Icon className="h-3 w-3" />
    </span>
  )
}
