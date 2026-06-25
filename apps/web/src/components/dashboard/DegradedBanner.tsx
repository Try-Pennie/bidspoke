import { isDegradedElevated, degradedPct } from '@/lib/health'

// #356: a dedicated dashboard warning for an elevated share of 'degraded' runs.
// Degraded = the lead was served but the post-response Salesforce writeback
// failed, so it is neutral in the success rate and a writeback outage can hide
// behind a green dashboard. Amber (not red): the lead WAS served.
export function DegradedBanner({ degraded, total }: { degraded: number; total: number }) {
  if (!isDegradedElevated(degraded, total)) return null
  const pct = degradedPct(degraded, total)
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      <p className="font-medium">
        {degraded} of {total} runs ({pct}%) are degraded.
      </p>
      <p className="mt-1 text-amber-700">
        The lead was served, but the post-response Salesforce writeback failed, so those records are
        out of sync in Salesforce. <span className="font-medium">How to fix:</span> find the affected
        workflow in the per-workflow breakdown below, open its recent executions, and check the
        writeback step for the error (commonly a Salesforce field, permission, or auth issue).
      </p>
    </div>
  )
}
