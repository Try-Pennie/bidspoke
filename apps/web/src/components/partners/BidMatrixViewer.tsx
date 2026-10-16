'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { PartnerBidConfig, BidMatrixRow, BidConfigDimension, MatrixProblem } from '@/lib/api'
import { api } from '@/lib/api'
import { Loader2, RefreshCw, Plus, Check, AlertTriangle, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { errorSentence } from '@/lib/error-sentence'
import { formatDatetime } from '@/lib/dates'

interface Props {
  partnerId: string
  partnerSlug: string
  configs: PartnerBidConfig[]
  onConfigsChange: (configs: PartnerBidConfig[]) => void
  selectedConfigId?: string
  /** Sets the partner's matrix in the page draft; null is "No matrix" (#2217). */
  onSelectConfig?: (id: string | null) => void
}

type SyncState = 'idle' | 'syncing' | 'synced' | 'error'

/**
 * The rows read of the matrix in view (#2217): a failed read is its own state,
 * never the empty one, so a load failure cannot read as a matrix with no rows (L10).
 */
type RowsRead =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'failed'; why: string }
  | { state: 'loaded'; rows: BidMatrixRow[] }

/** Why a rows read failed, in the design's words for a read that ran out of time. */
function readFailure(err: unknown): string {
  if ((err as { timedOut?: unknown } | null)?.timedOut === true) return 'The server did not answer within 30 seconds.'
  return errorSentence(err, 'The read failed.')
}

export function BidMatrixViewer(p: Props) {
  const [activeId, setActiveId] = useState<string | null>(p.selectedConfigId ?? p.configs[0]?.id ?? null)
  const [rowsRead, setRowsRead] = useState<RowsRead>({ state: 'none' })
  /** Bumped by Try again, so the same matrix is read again. */
  const [rowsAttempt, setRowsAttempt] = useState(0)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)
  // Structural problems (overlaps/gaps) from the last manual sync (#208). Surfaced
  // inline so an editor who clicks Sync now to validate a Salesforce change sees
  // the break immediately, instead of waiting for the next hourly Slack alert.
  const [problems, setProblems] = useState<MatrixProblem[]>([])
  const [creating, setCreating] = useState(false)
  /** The delete dialog (#2134): null when closed; otherwise whether it is deleting and why it last failed. */
  const [deleteAsk, setDeleteAsk] = useState<{ deleting: boolean; error: string | null } | null>(null)
  const deletingRef = useRef(false)
  const baseId = useId()

  useEffect(() => {
    if (p.selectedConfigId && p.selectedConfigId !== activeId) {
      setActiveId(p.selectedConfigId)
    }
  }, [p.selectedConfigId, activeId])

  useEffect(() => {
    if (!activeId) { setRowsRead({ state: 'none' }); return }
    let cancelled = false
    // A different matrix is now in view: its problems (if any) come from its own
    // sync, not the one we may have just shown.
    setProblems([])
    setRowsRead({ state: 'loading' })
    api.partnerBidConfigs.get(activeId)
      .then((res) => { if (!cancelled) setRowsRead({ state: 'loaded', rows: res.rows }) })
      .catch((err: unknown) => { if (!cancelled) setRowsRead({ state: 'failed', why: readFailure(err) }) })
    return () => { cancelled = true }
  }, [activeId, rowsAttempt])

  const activeConfig = p.configs.find((c) => c.id === activeId) ?? null

  // What is on screen NOW, for code that runs after an await (sync, create,
  // delete): the props and state a press closed over are the ones from before
  // it, and while it ran the person may have switched matrices, or the list may
  // have changed (a matrix added, one refreshed by a sync). Every use that
  // applies an answer to the screen after an await reads `latest.current`
  // (#2256). A request still names what was pressed on (`p.partnerId` in the
  // delete's re-read, the create's body), because that is what was asked about.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const latest = useRef(p)
  latest.current = p

  async function handleSync() {
    if (!activeConfig) return
    const synced = activeConfig
    setSyncState('syncing')
    setSyncError(null)
    setProblems([])
    try {
      const result = await api.partnerBidConfigs.sync(synced.id)
      const refreshed = await api.partnerBidConfigs.get(synced.id)
      const now = latest.current
      now.onConfigsChange(now.configs.map((c) => c.id === synced.id ? refreshed.config : c))
      // The sync answers for the matrix it started on. If another one is in view
      // now, its rows and problems are its own read's, never this sync's (#2256).
      if (activeIdRef.current !== synced.id) { setSyncState('idle'); return }
      setRowsRead({ state: 'loaded', rows: refreshed.rows })
      setProblems(result.problems ?? [])
      setSyncState('synced')
      setTimeout(() => setSyncState('idle'), 2000)
    } catch (err) {
      const why = err instanceof Error ? err.message : 'Sync failed'
      // A failure is still said, naming the matrix when it is no longer the one shown.
      setSyncError(activeIdRef.current === synced.id ? why : `The sync of "${synced.name}" failed: ${why}`)
      setSyncState('error')
      setTimeout(() => setSyncState('idle'), 4000)
    }
  }

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    try {
      const created = await api.partnerBidConfigs.create({
        partner_id: p.partnerId,
        slug: `${p.partnerSlug}-default`,
        name: `${p.partnerSlug} default`,
        is_default: p.configs.length === 0,
        is_active: true,
        sync_source: 'salesforce',
        sf_object: 'BidRangeRow__c',
        sf_filters: { partner_flag: defaultPartnerFlag(p.partnerSlug) },
        dimensions: defaultDimensions(),
      })
      const now = latest.current
      now.onConfigsChange([...now.configs, created])
      setActiveId(created.id)
      now.onSelectConfig?.(created.id)
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    // A ref, not state: two presses in one render both see the state before the
    // first one's update, and would both send the delete (#495).
    if (!activeConfig || deletingRef.current) return
    deletingRef.current = true
    setDeleteAsk({ deleting: true, error: null })
    try {
      await api.partnerBidConfigs.delete(activeConfig.id)
    } catch (err) {
      // A refusal the server answered did not delete. A request with no answer
      // may have, so the matrices are read again to find out before anything is
      // said or offered (L11, L766).
      const answered = typeof (err as { status?: unknown } | null)?.status === 'number'
      if (answered) {
        setDeleteAsk({ deleting: false, error: `Not deleted: ${errorSentence(err, 'the matrix delete failed')}` })
        deletingRef.current = false
        return
      }
      let stillThere: boolean
      try {
        stillThere = (await api.partnerBidConfigs.list(p.partnerId)).some((c) => c.id === activeConfig.id)
      } catch {
        setDeleteAsk({ deleting: false, error: `The delete got no answer, so the matrix may or may not be deleted. Reload the page to see which. (${errorSentence(err, 'no answer')})` })
        deletingRef.current = false
        return
      }
      if (stillThere) {
        setDeleteAsk({ deleting: false, error: 'The delete got no answer, and the matrix is still there. Delete it again, or keep it.' })
        deletingRef.current = false
        return
      }
    }
    deletingRef.current = false
    setDeleteAsk(null)
    const now = latest.current
    const remaining = now.configs.filter((c) => c.id !== activeConfig.id)
    now.onConfigsChange(remaining)
    // The partner priced from the matrix just deleted (#2217): its draft is
    // cleared to "No matrix", so the page shows an unsaved change and the save
    // sends it. Never another matrix picked for it, which would price leads from
    // a matrix nobody chose. Left as it was, selectedConfigId would also put the
    // deleted id straight back into view.
    if (now.onSelectConfig && now.selectedConfigId === activeConfig.id) {
      now.onSelectConfig(null)
      setActiveId(null)
      return
    }
    setActiveId(remaining[0]?.id ?? null)
  }

  /**
   * What deleting the matrix takes with it, from what is stored (L180): its rows
   * and its change history go with it (both cascade), and only the rows of a
   * matrix synced from Salesforce can come back.
   */
  function deleteConsequence(config: PartnerBidConfig): string {
    const count = rowsRead.state === 'loaded' ? rowsRead.rows.length : null
    const what = count !== null ? `Its ${count} ${count === 1 ? 'row' : 'rows'} and its change history are` : 'Its rows and its change history are'
    const back = config.sync_source === 'salesforce'
      ? 'Salesforce still holds the rows, so adding a matrix and syncing brings them back; the history does not come back.'
      : 'Neither can be brought back.'
    return `${what} deleted with it. ${back}`
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {p.configs.length === 0 ? (
          <Button variant="secondary" onClick={handleCreate} busy={creating}>
            {!creating && <Plus className="h-4 w-4" aria-hidden="true" />}
            Add matrix
          </Button>
        ) : (
          <>
            <Select
              id={`${baseId}-matrix`}
              aria-label="Matrix shown"
              value={activeId ?? ''}
              placeholder="No matrix"
              options={p.configs.map((c) => ({ value: c.id, label: `${c.name}${c.is_default ? ' (default)' : ''}` }))}
              onChange={(id) => { setActiveId(id); p.onSelectConfig?.(id) }}
              className="w-auto min-w-[12rem]"
            />
            <Button variant="ghost" onClick={handleCreate} disabled={creating} aria-label="Add another matrix" title="Add another matrix">
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={handleSync} disabled={syncState === 'syncing' || !activeConfig}>
              {syncState === 'syncing'
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Syncing…</>
                : syncState === 'synced'
                ? <><Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" /> Synced</>
                : syncState === 'error'
                ? <><AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" /> Retry sync</>
                : <><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Sync now</>}
            </Button>
            <Button variant="danger" onClick={() => setDeleteAsk({ deleting: false, error: null })} disabled={!activeConfig} aria-label="Delete this matrix" title="Delete this matrix">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </>
        )}
      </div>

      {deleteAsk && activeConfig && (
        <Dialog
          warning
          title={`Delete matrix "${activeConfig.name}"?`}
          description={deleteConsequence(activeConfig)}
          onDismiss={() => { if (!deleteAsk.deleting) setDeleteAsk(null) }}
          actions={
            <>
              <Button variant="secondary" onClick={() => setDeleteAsk(null)} disabled={deleteAsk.deleting}>Keep matrix</Button>
              <Button variant="destructive" onClick={() => { void handleDelete() }} busy={deleteAsk.deleting}>Delete matrix</Button>
            </>
          }
        >
          {deleteAsk.error && <p role="alert" className="text-sm text-red-700">{deleteAsk.error}</p>}
        </Dialog>
      )}

      {activeConfig && (
        <div className="space-y-2">
          <ConfigBadge config={activeConfig} />
          {syncError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {syncError}
            </div>
          )}
          {problems.length > 0 && <MatrixProblems problems={problems} />}
          <MatrixRows read={rowsRead} dimensions={activeConfig.dimensions} onRetry={() => setRowsAttempt((n) => n + 1)} />
        </div>
      )}
    </div>
  )
}

// Inline overlap/gap warnings from the last manual sync (#208). Mirrors the
// content of the hourly Slack alert so the edit-check loop closes in the UI.
function MatrixProblems({ problems }: { problems: MatrixProblem[] }) {
  const overlaps = problems.filter((p) => p.kind === 'overlap')
  const gaps = problems.filter((p) => p.kind === 'gap')
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" />
        {problems.length} structural problem{problems.length === 1 ? '' : 's'} in this matrix
        {overlaps.length > 0 && gaps.length > 0 && ` (${overlaps.length} overlap${overlaps.length === 1 ? '' : 's'}, ${gaps.length} gap${gaps.length === 1 ? '' : 's'})`}
      </div>
      <ul className="list-disc space-y-0.5 pl-4">
        {problems.map((pr, i) => (
          <li key={i}>
            <span className="font-medium capitalize">{pr.kind}</span>
            {pr.is_sell_off ? ' (sell-off)' : ''}: {pr.detail}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConfigBadge({ config }: { config: PartnerBidConfig }) {
  // In ET with its zone, through dates.ts (#2135); it was the browser's own zone, unlabelled.
  const synced = config.last_synced_at && !Number.isNaN(Date.parse(config.last_synced_at)) ? formatDatetime(config.last_synced_at) : null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-full bg-p-blue-light/10 px-2 py-0.5 font-medium text-p-blue-dark">
        Synced from Salesforce
      </span>
      {synced ? (
        <span className="text-gray-500">Last synced {synced}</span>
      ) : (
        <span className="text-gray-500">Never synced</span>
      )}
      {config.last_sync_error && (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-600">
          <AlertTriangle className="h-3 w-3" />
          Last sync failed
        </span>
      )}
    </div>
  )
}

/** The rows of the matrix in view, in whichever of the read's states it is in (#2217). */
function MatrixRows({ read, dimensions, onRetry }: { read: RowsRead; dimensions: BidConfigDimension[]; onRetry: () => void }) {
  if (read.state === 'none') return null
  if (read.state === 'loading') {
    // The design's loading pattern: grey placeholders while the read is live. The
    // read's own 30 second ceiling turns it into the failed state below.
    return (
      <div role="status" aria-label="Loading the matrix rows" className="space-y-2 rounded-lg border border-gray-200 px-3 py-3">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    )
  }
  if (read.state === 'failed') {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        <span className="flex-1">This matrix&apos;s rows could not be loaded. {read.why} Nothing has changed.</span>
        <Button variant="secondary" onClick={onRetry}>Try again</Button>
      </div>
    )
  }
  return <MatrixTable rows={read.rows} dimensions={dimensions} />
}

function MatrixTable({ rows, dimensions }: { rows: BidMatrixRow[]; dimensions: BidConfigDimension[] }) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-sm text-gray-500">No rows yet. Click <span className="font-medium">Sync now</span> to pull from Salesforce.</div>
  }

  const rowDim = dimensions.find((d) => d.column === 'row')
  const rangeDim = dimensions.find((d) => d.column === 'range')
  const standard = rows.filter((r) => !r.is_sell_off)
  const sellOff = rows.filter((r) => r.is_sell_off)

  return (
    <div className="space-y-3">
      <RowGroup label="Standard rows" rows={standard} rowDim={rowDim} rangeDim={rangeDim} />
      {sellOff.length > 0 && <RowGroup label="Sell-off rows" rows={sellOff} rowDim={rowDim} rangeDim={rangeDim} />}
    </div>
  )
}

function RowGroup({ label, rows, rowDim, rangeDim }: { label: string; rows: BidMatrixRow[]; rowDim?: BidConfigDimension; rangeDim?: BidConfigDimension }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600">{label} ({rows.length})</div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50/50">
          <tr className="text-left text-xs text-gray-500">
            <th className="px-3 py-2 font-medium">{rowDim?.name ?? 'Row'} band</th>
            {rangeDim && <th className="px-3 py-2 font-medium">{rangeDim.name} band</th>}
            <th className="px-3 py-2 text-right font-medium">Bid</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-gray-50/50">
              <td className="px-3 py-1.5 font-mono text-xs text-graphite">{formatBand(r.row_low, r.row_high)}</td>
              {rangeDim && <td className="px-3 py-1.5 font-mono text-xs text-graphite">{formatBand(r.range_low, r.range_high)}</td>}
              <td className="px-3 py-1.5 text-right font-mono text-xs text-graphite">${Number(r.bid_amount).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatBand(low: number | null, high: number | null): string {
  if (low === null && high === null) return '—'
  if (low === null) return `≤ ${high}`
  if (high === null) return `≥ ${low}`
  return `${low} – ${high}`
}

// Best-guess partner flag based on slug; ops can override in the API later.
function defaultPartnerFlag(slug: string): string | undefined {
  const map: Record<string, string> = {
    sofi: 'IsSoFi__c',
    epcvip: 'IsEPCVIP__c',
    dot818: 'IsDot818__c',
    nerdwallet: 'IsNerdWallet__c',
    brainsome: 'IsBrainsome__c',
    tlg: 'IsTLG__c',
    amone: 'IsAmOne__c',
    amonedirect: 'IsAmOneDirect__c',
  }
  return map[slug.toLowerCase()]
}

function defaultDimensions(): BidConfigDimension[] {
  return [
    { name: 'debt_amount', payload_field: 'debt_amount', column: 'row' },
    { name: 'vantage_score', payload_field: 'vantage_score', column: 'range' },
  ]
}
