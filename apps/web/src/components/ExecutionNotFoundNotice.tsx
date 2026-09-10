import { SearchX } from 'lucide-react'

/**
 * Empty state for an execution that neither recent history nor the archive
 * holds.
 *
 * THE AGE EXPLANATION IS GONE, deliberately (#874). This used to name the
 * seven day retention window as the likelier of two causes, and that stopped
 * being true the moment the page started falling back to the thirteen month
 * archive: a run that aged out of Postgres is now served from the archive
 * rather than reaching this screen. Leaving the sentence would have told a
 * person their run was deleted on schedule while a copy of it sat one failed
 * lookup away.
 *
 * What is left is the cause that survives: the run's logs never persisted (the
 * 2026-06-10 incident, where executions completed and responded normally and
 * only their history was lost), and the ordinary case of a mistyped or
 * truncated link.
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
            Recent history and the long term archive were both checked, and neither holds this run. Age is
            not the reason: runs older than recent history are served from the archive. The likeliest causes
            are that its logs never persisted when it ran, in which case the run itself usually completed
            and responded normally and only its history was lost, or that the link is incomplete.
          </p>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  )
}
