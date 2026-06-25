import { SearchX } from 'lucide-react'
import { EXECUTION_RETENTION_DAYS } from '@/lib/execution-retention'

/**
 * Empty state for an execution link whose row has no record in the database.
 * Two real causes, indistinguishable after the fact (execution ids are random
 * UUIDs, so a missing row carries no timestamp): the row aged out of the
 * retention window, or the log flush failed when the run happened (the
 * 2026-06-10 incident — the execution itself completed and responded fine,
 * only its observability was lost). Spell out both so an old Slack link
 * answers "what happened here?" without an investigation.
 */
export function ExecutionNotFoundNotice({ executionId, action }: { executionId: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex items-start gap-3">
        <SearchX className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-500" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-graphite">No record of this execution</p>
          <p className="mt-1 break-all font-mono text-xs text-gray-500">{executionId}</p>
          <p className="mt-2 text-sm text-gray-600">
            Two things can cause this: the run is older than the {EXECUTION_RETENTION_DAYS}-day retention
            window and its logs were removed by the nightly cleanup, or its logs failed to persist when it
            ran. In the second case the execution itself usually completed and responded normally; only its
            history was lost. Links in Slack alerts stay live for {EXECUTION_RETENTION_DAYS} days.
          </p>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  )
}
