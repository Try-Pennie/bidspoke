'use client'

/**
 * The history list (#1412, L46): one entry per save from audit_log, who and
 * when, each changed path old to new in the form's own words.
 */
import { formatProfileValue, profileFieldLabel } from './labels'

export interface HistoryEntry {
  changed_at: string
  changed_by: string | null
  action: string
  changes: Record<string, { old: unknown; new: unknown }> | null
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function BuyerProfileHistory({ entries }: { entries: readonly HistoryEntry[] }) {
  if (entries.length === 0) return <p className="text-xs text-gray-500">This profile has never been saved.</p>
  return (
    <ol className="space-y-3">
      {entries.map((entry, i) => (
        <li key={`${entry.changed_at}-${i}`} className="text-xs text-graphite">
          <p className="text-gray-600">
            <span className="font-medium">{entry.action}</span> by {entry.changed_by ?? 'the system'} on {when(entry.changed_at)}
          </p>
          <div className="mt-1 space-y-0.5 pl-3">
            {/* A key starting with an underscore is bookkeeping beside the paths
                (_actor, _route, #2133), never a field that changed. */}
            {Object.entries(entry.changes ?? {}).filter(([path]) => !path.startsWith('_')).map(([path, change]) => (
              <p key={path}>{profileFieldLabel(path)}: {formatProfileValue(path, change.old)} to {formatProfileValue(path, change.new)}</p>
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}
