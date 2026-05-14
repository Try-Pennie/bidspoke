'use client'

import type { BidResolverType } from '@/lib/api'

interface Props {
  resolverType: BidResolverType
  resolverConfig: Record<string, unknown>
  bidFormula: string
  apiEndpoint: string
  cfSecretKey: string
  bidConfigOptions: Array<{ id: string; name: string; slug: string }>
  onTypeChange: (t: BidResolverType) => void
  onFormulaChange: (v: string) => void
  onApiEndpointChange: (v: string) => void
  onCfSecretKeyChange: (v: string) => void
  onConfigChange: (cfg: Record<string, unknown>) => void
}

export function BidResolverEditor(p: Props) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Resolver</label>
        <p className="mb-2 text-xs text-gray-400">How Bidspoke determines the bid amount for this partner.</p>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {(['api', 'matrix', 'formula'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => p.onTypeChange(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                p.resolverType === t
                  ? 'bg-graphite text-white'
                  : 'text-gray-600 hover:text-graphite'
              }`}
            >
              {t === 'api' ? 'Partner API' : t === 'matrix' ? 'Matrix lookup' : 'Formula'}
            </button>
          ))}
        </div>
      </div>

      {p.resolverType === 'api' && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">API endpoint</label>
            <p className="mb-1.5 text-xs text-gray-400">POSTed with the trigger payload. The bid is read from the response (fields: bid, bid_amount, amount, price, offer) unless a bid path is set below.</p>
            <input
              value={p.apiEndpoint}
              onChange={(e) => p.onApiEndpointChange(e.target.value)}
              placeholder="https://partner.example/bid"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Auth secret name</label>
            <p className="mb-1.5 text-xs text-gray-400">Cloudflare worker secret containing the bearer token. Optional.</p>
            <input
              value={p.cfSecretKey}
              onChange={(e) => p.onCfSecretKeyChange(e.target.value)}
              placeholder="PARTNER_TOKEN"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Bid path (optional)</label>
            <p className="mb-1.5 text-xs text-gray-400">Dot-path into the response when the bid value isn&apos;t at top level. Example: <code className="rounded bg-gray-100 px-1 font-mono">data.bid</code>. Leave blank for the default top-level scan.</p>
            <input
              value={typeof p.resolverConfig.bid_path === 'string' ? p.resolverConfig.bid_path : ''}
              onChange={(e) => {
                const next = { ...p.resolverConfig }
                if (e.target.value) next.bid_path = e.target.value
                else delete next.bid_path
                p.onConfigChange(next)
              }}
              placeholder="data.bid"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            />
          </div>
        </div>
      )}

      {p.resolverType === 'formula' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Formula</label>
          <p className="mb-1.5 text-xs text-gray-400">Arithmetic expression. Use any numeric trigger.payload field by name. Supports +, -, *, /, ** and Math.floor / min / max / round / abs / sqrt.</p>
          <textarea
            value={p.bidFormula}
            onChange={(e) => p.onFormulaChange(e.target.value)}
            placeholder="debt_amount * 0.65"
            rows={2}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
          />
        </div>
      )}

      {p.resolverType === 'matrix' && (
        <MatrixResolverConfig
          config={p.resolverConfig}
          options={p.bidConfigOptions}
          onChange={p.onConfigChange}
        />
      )}
    </div>
  )
}

function MatrixResolverConfig({
  config,
  options,
  onChange,
}: {
  config: Record<string, unknown>
  options: Array<{ id: string; name: string; slug: string }>
  onChange: (cfg: Record<string, unknown>) => void
}) {
  const selectedId = typeof config.bid_config_id === 'string' ? config.bid_config_id : ''
  const useSellOff = config.use_sell_off === true

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Bid matrix</label>
        <p className="mb-1.5 text-xs text-gray-400">Pick a matrix to look up bids from. Matrices are managed below.</p>
        {options.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-sm text-gray-400">
            No matrices configured for this partner yet.
          </p>
        ) : (
          <select
            value={selectedId}
            onChange={(e) => onChange({ ...config, bid_config_id: e.target.value || null })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
          >
            <option value="">Select a matrix…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={useSellOff}
          onChange={(e) => onChange({ ...config, use_sell_off: e.target.checked })}
          className="h-4 w-4 rounded border-gray-300 text-graphite focus:ring-p-blue-light"
        />
        Use sell-off rows
      </label>
    </div>
  )
}
