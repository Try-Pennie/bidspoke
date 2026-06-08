import { AlertTriangle } from 'lucide-react'
import { timeoutBelowFloor } from '@/lib/timeout-floor'

/**
 * Badge rendered in the bottom-left corner of a node whose configured timeout is
 * below the node-type reliability floor — a misconfig that fails on cold runs.
 * Shown in both view and edit mode so the issue is visible without opening the
 * node's config panel. Parent must be `relative`. Renders nothing when the
 * timeout is unset or already clears the floor.
 */
export function TimeoutWarningBadge({ type, config }: { type: string; config: Record<string, unknown> | undefined }) {
  const floor = timeoutBelowFloor(type, config)
  if (floor == null) return null
  const timeout = config!.timeout_ms as number
  return (
    <div
      title={`Timeout (${timeout}ms) is below the reliable minimum for this step (~${floor}ms). Cold runs exceed it on every retry, so the step times out and fails. Open the node and raise it to at least ${floor}ms.`}
      className="absolute -bottom-2 -left-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-red-300 bg-red-50 text-red-600 shadow-sm"
    >
      <AlertTriangle className="h-3 w-3" />
    </div>
  )
}
