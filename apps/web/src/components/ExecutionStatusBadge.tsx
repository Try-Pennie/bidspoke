import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, Clock, SkipForward, RefreshCw, AlertTriangle, HelpCircle } from 'lucide-react'
import { resolveExecutionStatus, OUTCOME_LABELS } from '@/lib/execution-status'

export const STATUS_STYLES: Record<string, { icon: React.ReactNode; label: string; bg: string; text: string }> = {
  completed:            { icon: <CheckCircle className="h-4 w-4" />, label: OUTCOME_LABELS.completed, bg: 'bg-green-50',  text: 'text-green-700' },
  // Served, but a post-response writeback failed (#310). Amber, not red — the
  // lead got a correct response; only a side-effect didn't land.
  degraded:             { icon: <AlertTriangle className="h-4 w-4" />, label: OUTCOME_LABELS.degraded, bg: 'bg-amber-50',  text: 'text-amber-700' },
  failed:               { icon: <XCircle className="h-4 w-4" />,    label: OUTCOME_LABELS.failed,    bg: 'bg-red-50',    text: 'text-red-700'   },
  skipped:              { icon: <SkipForward className="h-4 w-4" />, label: 'Skipped',      bg: 'bg-gray-50',   text: 'text-gray-500'  },
  running:              { icon: <Clock className="h-4 w-4" />,       label: 'Running',      bg: 'bg-p-blue-light', text: 'text-p-blue-dark' },
  failed_with_fallback: { icon: <RefreshCw className="h-4 w-4" />,   label: 'Fallback',     bg: 'bg-yellow-50', text: 'text-yellow-700'},
  // A run that has been 'running' past the stall threshold — almost always a
  // strand that never finalized (#477). Amber-warning, distinct from the blue
  // live-running badge.
  stalled:              { icon: <AlertTriangle className="h-4 w-4" />, label: 'Stalled',    bg: 'bg-amber-50',  text: 'text-amber-700' },
  // Any status we don't recognize. Neutral — never masquerade as running.
  unknown:              { icon: <HelpCircle className="h-4 w-4" />,  label: 'Unknown',      bg: 'bg-gray-100',  text: 'text-gray-600'  },
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

/**
 * Header badge for the whole execution. Unlike a plain per-step status badge,
 * this resolves the raw status into a display status that ticks: a running run
 * shows live elapsed ("Running · 12s") so it reads as still-alive (#492 rule),
 * and once it has run past the stall threshold it converts to "Stalled" (#477).
 */
export function ExecutionStatusBadge({ status, startedAt }: { status: string; startedAt: string }) {
  const startedAtMs = new Date(startedAt).getTime()
  const isRunning = status === 'running'
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isRunning) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])

  const display = resolveExecutionStatus(status, startedAtMs, isRunning ? now : startedAtMs)
  const s = STATUS_STYLES[display] ?? STATUS_STYLES.unknown
  const showElapsed = display === 'running' || display === 'stalled'
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAtMs) / 1000))

  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.bg} ${s.text}`}
      title={display === 'stalled' ? 'No update past the 60s stall threshold. This run likely never finalized.' : undefined}
    >
      {s.icon}
      {s.label}
      {showElapsed && <span className="tabular-nums opacity-80">· {formatElapsed(elapsedSeconds)}</span>}
    </span>
  )
}
