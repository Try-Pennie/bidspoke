'use client'

import { useId } from 'react'
import type { BidResolverType, BidComparisonSource } from '@/lib/api'
import { TieredMultiplierEditor } from './TieredMultiplierEditor'

type BidValueMode = 'response' | 'tiered' | 'formula'

function readBidValueMode(comparison: BidComparisonSource, cfg: Record<string, unknown>): BidValueMode {
  if (comparison !== 'formula') return 'response'
  if (cfg.pricing_mode === 'tiered_multiplier') return 'tiered'
  return 'formula'
}

interface Props {
  resolverType: BidResolverType
  resolverConfig: Record<string, unknown>
  bidFormula: string
  apiEndpoint: string
  cfSecretKey: string
  bidComparisonSource: BidComparisonSource
  bidConfigOptions: Array<{ id: string; name: string; slug: string }>
  onTypeChange: (t: BidResolverType) => void
  onFormulaChange: (v: string) => void
  onApiEndpointChange: (v: string) => void
  onCfSecretKeyChange: (v: string) => void
  onBidComparisonSourceChange: (v: BidComparisonSource) => void
  onConfigChange: (cfg: Record<string, unknown>) => void
}

export function BidResolverEditor(p: Props) {
  const apiEndpointId = useId()
  const cfSecretId = useId()
  const formulaId = useId()
  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1 block text-xs font-medium text-gray-600">Resolver</span>
        <p className="mb-2 text-xs text-gray-500">How Bidspoke determines the bid amount for this partner.</p>
        <div role="group" aria-label="Resolver" className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
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
            <label htmlFor={apiEndpointId} className="mb-1 block text-xs font-medium text-gray-600">API endpoint</label>
            <p className="mb-1.5 text-xs text-gray-500">POSTed with the trigger payload on every bid.</p>
            <input
              id={apiEndpointId}
              value={p.apiEndpoint}
              onChange={(e) => p.onApiEndpointChange(e.target.value)}
              placeholder="https://partner.example/bid"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
            />
          </div>
          <div>
            <label htmlFor={cfSecretId} className="mb-1 block text-xs font-medium text-gray-600">Auth secret name</label>
            <p className="mb-1.5 text-xs text-gray-500">Cloudflare worker secret containing the bearer token. Optional.</p>
            <input
              id={cfSecretId}
              value={p.cfSecretKey}
              onChange={(e) => p.onCfSecretKeyChange(e.target.value)}
              placeholder="PARTNER_TOKEN"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
            />
          </div>

          <BidValueSourceRadio
            mode={readBidValueMode(p.bidComparisonSource, p.resolverConfig)}
            resolverConfig={p.resolverConfig}
            onSelectMode={(mode) => {
              if (mode === 'response') {
                p.onBidComparisonSourceChange('auto')
                const next = { ...p.resolverConfig }
                delete next.formula
                delete next.pricing_mode
                delete next.source_field
                delete next.tiers
                delete next.default_multiplier
                p.onConfigChange(next)
              } else if (mode === 'tiered') {
                p.onBidComparisonSourceChange('formula')
                const next = { ...p.resolverConfig }
                delete next.bid_path
                delete next.formula
                next.pricing_mode = 'tiered_multiplier'
                if (next.source_field === undefined) next.source_field = ''
                if (next.tiers === undefined) next.tiers = []
                if (next.default_multiplier === undefined) next.default_multiplier = null
                p.onConfigChange(next)
              } else {
                p.onBidComparisonSourceChange('formula')
                const next = { ...p.resolverConfig }
                delete next.bid_path
                delete next.pricing_mode
                delete next.source_field
                delete next.tiers
                delete next.default_multiplier
                p.onConfigChange(next)
              }
            }}
            onConfigChange={p.onConfigChange}
          />
        </div>
      )}

      {p.resolverType === 'formula' && (
        <div>
          <label htmlFor={formulaId} className="mb-1 block text-xs font-medium text-gray-600">Formula</label>
          <p className="mb-1.5 text-xs text-gray-500">Arithmetic expression. Use any numeric trigger.payload field by name. Supports +, -, *, /, ** and Math.floor / min / max / round / abs / sqrt.</p>
          <textarea
            id={formulaId}
            value={p.bidFormula}
            onChange={(e) => p.onFormulaChange(e.target.value)}
            placeholder="debt_amount * 0.65"
            rows={2}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
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

function BidValueSourceRadio({
  mode,
  resolverConfig,
  onSelectMode,
  onConfigChange,
}: {
  mode: BidValueMode
  resolverConfig: Record<string, unknown>
  onSelectMode: (mode: BidValueMode) => void
  onConfigChange: (cfg: Record<string, unknown>) => void
}) {
  const bidPathId = useId()
  const bidFormulaId = useId()
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-beige p-3">
        <span className="mb-1.5 block text-xs font-medium text-gray-600">Where does the bid value come from?</span>
        <div role="group" aria-label="Where does the bid value come from?" className="space-y-1.5">
          <RadioOption
            checked={mode === 'response'}
            onSelect={() => onSelectMode('response')}
            label="The API response"
            hint="Bidspoke reads the bid from the partner's response."
          />
          <RadioOption
            checked={mode === 'tiered'}
            onSelect={() => onSelectMode('tiered')}
            label="A tier-based multiplier"
            hint="The API call is for eligibility only. The bid for ranking is a field × a multiplier picked by tier."
          />
          <RadioOption
            checked={mode === 'formula'}
            onSelect={() => onSelectMode('formula')}
            label="A custom formula"
            hint="The API call is for eligibility only. The bid is whatever your expression evaluates to. Use this only if the tier-based form doesn't fit."
          />
        </div>
      </div>

      {mode === 'response' && (
        <div>
          <label htmlFor={bidPathId} className="mb-1 block text-xs font-medium text-gray-600">Bid response path (optional)</label>
          <p className="mb-1.5 text-xs text-gray-500">Where the bid value lives in the response. Leave blank if it&apos;s at the top level under one of: <code className="rounded bg-gray-100 px-1 font-mono">bid</code>, <code className="rounded bg-gray-100 px-1 font-mono">bid_amount</code>, <code className="rounded bg-gray-100 px-1 font-mono">amount</code>, <code className="rounded bg-gray-100 px-1 font-mono">price</code>, <code className="rounded bg-gray-100 px-1 font-mono">offer</code>.</p>
          <input
            id={bidPathId}
            value={typeof resolverConfig.bid_path === 'string' ? resolverConfig.bid_path : ''}
            onChange={(e) => {
              const next = { ...resolverConfig }
              if (e.target.value) next.bid_path = e.target.value
              else delete next.bid_path
              onConfigChange(next)
            }}
            placeholder="data.bid"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
          />
        </div>
      )}

      {mode === 'tiered' && (
        <TieredMultiplierEditor config={resolverConfig} onChange={onConfigChange} />
      )}

      {mode === 'formula' && (
        <div>
          <label htmlFor={bidFormulaId} className="mb-1 block text-xs font-medium text-gray-600">Bid formula</label>
          <p className="mb-1.5 text-xs text-gray-500">Arithmetic that produces a number. References: <code className="rounded bg-gray-100 px-1 font-mono">trigger.*</code>, <code className="rounded bg-gray-100 px-1 font-mono">steps.&lt;name&gt;.output.*</code>, <code className="rounded bg-gray-100 px-1 font-mono">env.*</code>, or a bare payload field name.</p>
          <textarea
            id={bidFormulaId}
            value={typeof resolverConfig.formula === 'string' ? resolverConfig.formula : ''}
            onChange={(e) => {
              const next = { ...resolverConfig }
              if (e.target.value) next.formula = e.target.value
              else delete next.formula
              onConfigChange(next)
            }}
            placeholder="steps.eligibility.output.final * 0.12"
            rows={3}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
          />
        </div>
      )}
    </div>
  )
}

function RadioOption({
  checked,
  onSelect,
  label,
  hint,
}: {
  checked: boolean
  onSelect: () => void
  label: string
  hint: string
}) {
  return (
    <label aria-label={label} className="flex cursor-pointer items-start gap-2">
      <input
        type="radio"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <div className="text-xs">
        <div className="font-medium text-graphite">{label}</div>
        <div className="text-gray-500">{hint}</div>
      </div>
    </label>
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
  const bidMatrixId = useId()
  const selectedId = typeof config.bid_config_id === 'string' ? config.bid_config_id : ''
  const useSellOff = config.use_sell_off === true

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={bidMatrixId} className="mb-1 block text-xs font-medium text-gray-600">Bid matrix</label>
        <p className="mb-1.5 text-xs text-gray-500">Pick a matrix to look up bids from. Matrices are managed below.</p>
        {options.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-sm text-gray-500">
            No matrices configured for this partner yet.
          </p>
        ) : (
          <select
            id={bidMatrixId}
            value={selectedId}
            onChange={(e) => onChange({ ...config, bid_config_id: e.target.value || null })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
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
          className="h-4 w-4 rounded border-gray-300 text-graphite focus:ring-2 focus:ring-p-blue-dark"
        />
        Use sell-off rows
      </label>
    </div>
  )
}
