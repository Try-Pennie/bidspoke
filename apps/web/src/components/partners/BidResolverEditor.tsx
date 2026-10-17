'use client'

/**
 * The Bid Group tab's Endpoint, Resolver and Bid amount rows (PM-23, #2326),
 * three sections in the settled design (docs/design/partners-page.html,
 * resolverSections at RES2STYLE "two" and FNAME "nocall"): Endpoint first, then
 * the Resolver, then how the bid amount is set. Resolver and Bid amount stay
 * two separate choices. Was one "Bid resolution" section with the endpoint and
 * secret stacked under the resolver and a boxed "Where does the bid value come
 * from?" radio list.
 */
import { useId } from 'react'
import type { BidResolverType, BidComparisonSource } from '@/lib/api'
import { TieredMultiplierEditor } from './TieredMultiplierEditor'
import { Checkbox, ChoiceGroup, Field, FieldError, TextArea, TextInput, describedBy } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'

type BidValueMode = 'response' | 'tiered' | 'formula'

/** The resolver as the design names it: a resolver that makes no call reads No call (L118, Formula is a Bid amount). */
const RESOLVER_OPTIONS: ReadonlyArray<{ value: BidResolverType; label: string }> = [
  { value: 'api', label: 'Partner API' },
  { value: 'matrix', label: 'Matrix lookup' },
  { value: 'formula', label: 'No call' },
]

const BID_VALUE_OPTIONS: ReadonlyArray<{ value: BidValueMode; label: string }> = [
  { value: 'response', label: 'Response' },
  { value: 'tiered', label: 'Tier multiplier' },
  { value: 'formula', label: 'Formula' },
]

/** One line of meaning under the Bid amount choice, the design's SOURCE_WHY. */
const BID_VALUE_MEANING: Record<BidValueMode, string> = {
  response: "Bidspoke reads the bid from the partner's response.",
  tiered: 'The call checks eligibility only. The bid is a field times a multiplier picked by tier.',
  formula: 'The call checks eligibility only. The bid is whatever the expression works out to.',
}

export const DEDUP_MEANING = 'Before each bid, Bidspoke asks this address whether the lead was already sold to the partner, and skips the bid if it was.'

function readBidValueMode(comparison: BidComparisonSource, cfg: Record<string, unknown>): BidValueMode {
  if (comparison !== 'formula') return 'response'
  if (cfg.pricing_mode === 'tiered_multiplier') return 'tiered'
  return 'formula'
}

/**
 * Endpoint: the address and the secret side by side, the missing credential red
 * under them, then the duplicate check address with its one line of meaning. A
 * resolver that makes no call has no address or secret to show, but keeps the
 * duplicate check, and a missing credential is still said here.
 */
export function EndpointFields(p: {
  resolverType: BidResolverType
  apiEndpoint: string
  cfSecretKey: string
  dedupEndpoint: string
  onApiEndpointChange: (v: string) => void
  onCfSecretKeyChange: (v: string) => void
  onDedupEndpointChange: (v: string) => void
  /** The missing credential (#416, #2137), red under the secret it is about. */
  credentialProblem: string | null
}) {
  const addressId = useId()
  const secretId = useId()
  const dedupId = useId()
  const problemId = `${secretId}-problem`
  return (
    <div className="space-y-3">
      {p.resolverType === 'api' && (
        <div className="endpoint-row grid grid-cols-[minmax(0,1fr)_200px] items-end gap-3">
          <Field id={addressId} label="Address">
            <TextInput id={addressId} value={p.apiEndpoint} onChange={p.onApiEndpointChange} placeholder="https://partner.example/bid" mono />
          </Field>
          <Field id={secretId} label="Secret">
            <TextInput id={secretId} value={p.cfSecretKey} onChange={p.onCfSecretKeyChange} placeholder="PARTNER_TOKEN" mono describedBy={p.credentialProblem ? problemId : undefined} />
          </Field>
        </div>
      )}
      {p.credentialProblem && (
        <FieldError id={p.resolverType === 'api' ? problemId : undefined} size="xs" className="!mt-1">{p.credentialProblem}</FieldError>
      )}
      <Field id={dedupId} label="Duplicate check address" hint={DEDUP_MEANING}>
        <TextInput id={dedupId} value={p.dedupEndpoint} onChange={p.onDedupEndpointChange} placeholder="None. Every lead is bid on." mono describedBy={describedBy(dedupId, true, false)} />
      </Field>
    </div>
  )
}

/** Resolver: the row's heading names the choice, so the group's label is for screen readers only (L605). */
export function ResolverChoice({ value, onChange }: { value: BidResolverType; onChange: (t: BidResolverType) => void }) {
  const id = useId()
  return <ChoiceGroup id={id} label="Resolver" visibleLabel="" value={value} options={RESOLVER_OPTIONS} onChange={onChange} />
}

interface BidAmountProps {
  resolverType: BidResolverType
  resolverConfig: Record<string, unknown>
  bidFormula: string
  bidComparisonSource: BidComparisonSource
  bidConfigOptions: Array<{ id: string; name: string; slug: string }>
  partnerName: string
  onFormulaChange: (v: string) => void
  onBidComparisonSourceChange: (v: BidComparisonSource) => void
  onConfigChange: (cfg: Record<string, unknown>) => void
}

/**
 * Bid amount: for the Partner API, Response, Tier multiplier or Formula with
 * one line of meaning; for a matrix, which matrix; for No call, the expression.
 */
export function BidAmountEditor(p: BidAmountProps) {
  const formulaId = useId()
  if (p.resolverType === 'matrix') {
    return <MatrixResolverConfig config={p.resolverConfig} options={p.bidConfigOptions} onChange={p.onConfigChange} />
  }
  if (p.resolverType === 'formula') {
    return (
      <Field id={formulaId} label="Expression" hint={`The bid is whatever the expression works out to, without calling ${p.partnerName}.`}>
        <TextArea id={formulaId} value={p.bidFormula} onChange={p.onFormulaChange} placeholder="debt_amount * 0.65" rows={2} mono describedBy={describedBy(formulaId, true, false)} />
      </Field>
    )
  }
  return (
    <BidValueSource
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
  )
}

function BidValueSource({
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
      <div>
        <ChoiceGroup id={sourceId} label="Bid amount" visibleLabel="" value={mode} options={BID_VALUE_OPTIONS} onChange={onSelectMode} describedBy={`${sourceId}-meaning`} />
        <p id={`${sourceId}-meaning`} className="mt-1 text-xs text-hint">{BID_VALUE_MEANING[mode]}</p>
      </div>

      {mode === 'response' && (
        <Field id={bidPathId} label="Where the bid is in the response">
          <TextInput
            id={bidPathId}
            value={typeof resolverConfig.bid_path === 'string' ? resolverConfig.bid_path : ''}
            onChange={(v) => {
              const next = { ...resolverConfig }
              if (v) next.bid_path = v
              else delete next.bid_path
              onConfigChange(next)
            }}
            placeholder="bid"
            mono
          />
        </Field>
      )}

      {mode === 'tiered' && (
        <TieredMultiplierEditor config={resolverConfig} onChange={onConfigChange} />
      )}

      {mode === 'formula' && (
        <Field id={bidFormulaId} label="Expression">
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
        </Field>
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
        <p className="mb-1.5 text-xs text-hint">Pick a matrix to look up bids from. Matrices are managed below.</p>
        {options.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-sm text-hint">
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
