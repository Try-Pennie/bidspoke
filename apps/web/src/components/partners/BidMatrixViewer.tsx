'use client'

import { useEffect, useState } from 'react'
import type { PartnerBidConfig, BidMatrixRow, BidConfigDimension, MatrixProblem } from '@/lib/api'
import { api } from '@/lib/api'
import { Loader2, RefreshCw, Plus, Check, AlertTriangle, Trash2 } from 'lucide-react'

interface Props {
  partnerId: string
  partnerSlug: string
  configs: PartnerBidConfig[]
  onConfigsChange: (configs: PartnerBidConfig[]) => void
  selectedConfigId?: string
  onSelectConfig?: (id: string) => void
}

type SyncState = 'idle' | 'syncing' | 'synced' | 'error'

export function BidMatrixViewer(p: Props) {
  const [activeId, setActiveId] = useState<string | null>(p.selectedConfigId ?? p.configs[0]?.id ?? null)
  const [rows, setRows] = useState<BidMatrixRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)
  // Structural problems (overlaps/gaps) from the last manual sync (#208). Surfaced
  // inline so an editor who clicks Sync now to validate a Salesforce change sees
  // the break immediately, instead of waiting for the next hourly Slack alert.
  const [problems, setProblems] = useState<MatrixProblem[]>([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (p.selectedConfigId && p.selectedConfigId !== activeId) {
      setActiveId(p.selectedConfigId)
    }
  }, [p.selectedConfigId, activeId])

  useEffect(() => {
    if (!activeId) { setRows([]); return }
    let cancelled = false
    // A different matrix is now in view — its problems (if any) come from its own
    // sync, not the one we may have just shown.
    setProblems([])
    setLoadingRows(true)
    api.partnerBidConfigs.get(activeId)
      .then((res) => { if (!cancelled) setRows(res.rows) })
      .catch(() => { if (!cancelled) setRows([]) })
      .finally(() => { if (!cancelled) setLoadingRows(false) })
    return () => { cancelled = true }
  }, [activeId])

  const activeConfig = p.configs.find((c) => c.id === activeId) ?? null

  async function handleSync() {
    if (!activeConfig) return
    setSyncState('syncing')
    setSyncError(null)
    setProblems([])
    try {
      const result = await api.partnerBidConfigs.sync(activeConfig.id)
      const refreshed = await api.partnerBidConfigs.get(activeConfig.id)
      setRows(refreshed.rows)
      setProblems(result.problems ?? [])
      p.onConfigsChange(p.configs.map((c) => c.id === activeConfig.id ? refreshed.config : c))
      setSyncState('synced')
      setTimeout(() => setSyncState('idle'), 2000)
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed')
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
      p.onConfigsChange([...p.configs, created])
      setActiveId(created.id)
      p.onSelectConfig?.(created.id)
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    if (!activeConfig) return
    if (!confirm(`Delete matrix "${activeConfig.name}"?`)) return
    await api.partnerBidConfigs.delete(activeConfig.id)
    const remaining = p.configs.filter((c) => c.id !== activeConfig.id)
    p.onConfigsChange(remaining)
    setActiveId(remaining[0]?.id ?? null)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {p.configs.length === 0 ? (
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:border-gray-400 hover:text-graphite disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add matrix
          </button>
        ) : (
          <>
            <select
              value={activeId ?? ''}
              onChange={(e) => { setActiveId(e.target.value); p.onSelectConfig?.(e.target.value) }}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-graphite focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            >
              {p.configs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-1 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-graphite"
              title="Add another matrix"
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={handleSync}
              disabled={syncState === 'syncing' || !activeConfig}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              {syncState === 'syncing'
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing…</>
                : syncState === 'synced'
                ? <><Check className="h-3.5 w-3.5 text-green-600" /> Synced</>
                : syncState === 'error'
                ? <><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Retry sync</>
                : <><RefreshCw className="h-3.5 w-3.5" /> Sync now</>}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600"
              title="Delete this matrix"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {activeConfig && (
        <div className="space-y-2">
          <ConfigBadge config={activeConfig} />
          {syncError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {syncError}
            </div>
          )}
          {problems.length > 0 && <MatrixProblems problems={problems} />}
          <MatrixTable rows={rows} dimensions={activeConfig.dimensions} loading={loadingRows} />
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
  const synced = config.last_synced_at ? new Date(config.last_synced_at).toLocaleString() : null
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

function MatrixTable({ rows, dimensions, loading }: { rows: BidMatrixRow[]; dimensions: BidConfigDimension[]; loading: boolean }) {
  if (loading) {
    return <div className="rounded-lg border border-gray-200 px-3 py-6 text-center text-sm text-gray-500">Loading matrix…</div>
  }
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
