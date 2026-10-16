'use client'

import { useId } from 'react'
import type { BidResolverType, BidComparisonSource } from '@/lib/api'
import { TieredMultiplierEditor } from './TieredMultiplierEditor'
import { Checkbox, ChoiceGroup, TextArea, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'

type BidValueMode = 'response' | 'tiered' | 'formula'

const RESOLVER_OPTIONS: ReadonlyArray<{ value: BidResolverType; label: string }> = [
  { value: 'api', label: 'Partner API' },
  { value: 'matrix', label: 'Matrix lookup' },
  { value: 'formula', label: 'Formula' },
]

const BID_VALUE_OPTIONS: ReadonlyArray<{ value: BidValueMode; label: string; hint: string }> = [
  { value: 'response', label: 'The API response', hint: "Bidspoke reads the bid from the partner's response." },
  { value: 'tiered', label: 'A tier-based multiplier', hint: 'The API call is for eligibility only. The bid for ranking is a field × a multiplier picked by tier.' },
  { value: 'formula', label: 'A custom formula', hint: "The API call is for eligibility only. The bid is whatever your expression evaluates to. Use this only if the tier-based form doesn't fit." },
]

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
  /** A problem with the secret, drawn red under its field (#2137): the missing credential. */
  cfSecretKeyError?: string | null
}

export function BidResolverEditor(p: Props) {
  const apiEndpointId = useId()
  const cfSecretId = useId()
  const formulaId = useId()
  const resolverId = useId()
  return (
    <div className="space-y-4">
      <div>
        <ChoiceGroup
          id={resolverId}
          label="Resolver"
          value={p.resolverType}
          options={RESOLVER_OPTIONS}
          onChange={p.onTypeChange}
          describedBy={`${resolverId}-hint`}
        />
        <p id={`${resolverId}-hint`} className="mt-1 text-xs text-gray-500">How Bidspoke determines the bid amount for this partner.</p>
      </div>

      {p.resolverType === 'api' && (
        <div className="space-y-3">
          <div>
            <label htmlFor={apiEndpointId} className="mb-1 block text-xs font-medium text-gray-600">API endpoint</label>
            <p className="mb-1.5 text-xs text-gray-500">POSTed with the trigger payload on every bid.</p>
            <TextInput id={apiEndpointId} value={p.apiEndpoint} onChange={p.onApiEndpointChange} placeholder="https://partner.example/bid" mono />
          </div>
          <div>
            <label htmlFor={cfSecretId} className="mb-1 block text-xs font-medium text-gray-600">Auth secret name</label>
            <p className="mb-1.5 text-xs text-gray-500">Cloudflare worker secret containing the bearer token. Optional.</p>
            <TextInput id={cfSecretId} value={p.cfSecretKey} onChange={p.onCfSecretKeyChange} placeholder="PARTNER_TOKEN" mono describedBy={p.cfSecretKeyError ? `${cfSecretId}-problem` : undefined} />
            {p.cfSecretKeyError && <p id={`${cfSecretId}-problem`} className="mt-1 text-xs text-red-700">{p.cfSecretKeyError}</p>}
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
          <TextArea id={formulaId} value={p.bidFormula} onChange={p.onFormulaChange} placeholder="debt_amount * 0.65" rows={2} mono />
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
  const sourceId = useId()
  const bidFormulaId = useId()
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-beige p-3">
        <ChoiceGroup id={sourceId} label="Where does the bid value come from?" value={mode} options={BID_VALUE_OPTIONS} onChange={onSelectMode} stacked />
      </div>

      {mode === 'response' && (
        <div>
          <label htmlFor={bidPathId} className="mb-1 block text-xs font-medium text-gray-600">Bid response path (optional)</label>
          <p className="mb-1.5 text-xs text-gray-500">Where the bid value lives in the response. Leave blank if it&apos;s at the top level under one of: <code className="rounded bg-gray-100 px-1 font-mono">bid</code>, <code className="rounded bg-gray-100 px-1 font-mono">bid_amount</code>, <code className="rounded bg-gray-100 px-1 font-mono">amount</code>, <code className="rounded bg-gray-100 px-1 font-mono">price</code>, <code className="rounded bg-gray-100 px-1 font-mono">offer</code>.</p>
          <TextInput
            id={bidPathId}
            value={typeof resolverConfig.bid_path === 'string' ? resolverConfig.bid_path : ''}
            onChange={(v) => {
              const next = { ...resolverConfig }
              if (v) next.bid_path = v
              else delete next.bid_path
              onConfigChange(next)
            }}
            placeholder="data.bid"
            mono
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
          <TextArea
            id={bidFormulaId}
            value={typeof resolverConfig.formula === 'string' ? resolverConfig.formula : ''}
            onChange={(v) => {
              const next = { ...resolverConfig }
              if (v) next.formula = v
              else delete next.formula
              onConfigChange(next)
            }}
            placeholder="steps.eligibility.output.final * 0.12"
            rows={3}
            mono
          />
        </div>
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
  const bidMatrixId = useId()
  const sellOffId = useId()
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
          // '' is a real answer here (#2137): no matrix chosen, stored as null.
          <Select
            id={bidMatrixId}
            value={selectedId}
            options={[{ value: '', label: 'No matrix' }, ...options.map((o) => ({ value: o.id, label: o.name }))]}
            onChange={(v) => onChange({ ...config, bid_config_id: v || null })}
          />
        )}
      </div>
      <Checkbox id={sellOffId} checked={useSellOff} onChange={(v) => onChange({ ...config, use_sell_off: v })} label="Use sell-off rows" />
    </div>
  )
}
