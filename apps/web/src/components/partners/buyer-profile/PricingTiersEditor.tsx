'use client'

/**
 * The pricing tiers editor (#1412): a ladder per WIRED population, each rung a
 * debt range and a multiplier. Populations not yet wired to a buyer_select node
 * get no inputs (L46, L703), so the form cannot store pricing nothing reads.
 *
 * Drawn as the settled design draws it (#2325, PM-22, frame 19): each wired
 * population headed by its leads ("Engine leads"), one table whose column names
 * are said once over its rungs (L579), debt as money boxes with "$" beside
 * them, a short hint, then one line naming the populations not priced here yet.
 * The worked example and the band arithmetic the earlier option carried are
 * gone; the save's validator still refuses a gap, an overlap or a multiplier
 * above the ceiling, beside the tier it names.
 */
import { useId } from 'react'
import { MULTIPLIER_CEILING, POPULATIONS, WIRED_POPULATIONS, type Population, type ProfileTierDocument } from '@bidspoke/buyer-profile'
import { Plus } from 'lucide-react'
import { Button, FieldError, MoneyInput, NumberInput } from '@/components/ui/form'
import { POPULATION_LABELS, formatWhole } from './labels'
import { RemoveButton } from '@/components/partners/RemoveButton'
import { joinAnd } from '../delete-copy'

const WIRED: ReadonlySet<string> = new Set(WIRED_POPULATIONS)
const UNWIRED = POPULATIONS.filter((p) => !WIRED.has(p)).map((p) => POPULATION_LABELS[p])

export function PricingTiersEditor({ value, onChange, errors = {} }: { value: readonly ProfileTierDocument[]; onChange: (tiers: ProfileTierDocument[]) => void; errors?: Record<string, string> }) {
  const base = useId()

  const forPopulation = (population: string) => value.filter((t) => t.population === population).sort((a, b) => Number(a.debt_from) - Number(b.debt_from))
  const replacePopulation = (population: string, tiers: ProfileTierDocument[]) => onChange([...value.filter((t) => t.population !== population), ...tiers])

  return (
    <div className="space-y-2">
      {WIRED_POPULATIONS.map((population: Population) => {
        const tiers = forPopulation(population)
        const label = POPULATION_LABELS[population]
        const headingId = `${base}-${population}-title`
        return (
          <div key={population} role="group" aria-labelledby={headingId} data-population={population} className="space-y-1.5">
            <p id={headingId} className="text-[13px] font-semibold text-graphite">{label} leads</p>
            {tiers.length === 0 ? (
              <p className="text-xs text-amber-800">No tiers: this buyer cannot be offered {label} leads.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11.5px] text-hint">
                    <th scope="col" className="pb-1 pr-2 font-normal">Debt from</th>
                    <th scope="col" className="pb-1 pr-2 font-normal">Debt to</th>
                    <th scope="col" className="w-24 pb-1 pr-2 font-normal">Multiplier</th>
                    <th scope="col" className="w-8 pb-1"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier, i) => {
                    const key = `tiers[${population}:${Number(tier.debt_from)}]`
                    const error = errors[key]
                    const rowId = `${base}-${population}-${i}`
                    const update = (change: Partial<ProfileTierDocument>) => replacePopulation(population, tiers.map((t, j) => (j === i ? { ...t, ...change } : t)))
                    const from = formatWhole(Number(tier.debt_from))
                    const upperLabel = tier.debt_to === null ? 'no upper bound' : formatWhole(Number(tier.debt_to))
                    const name = `tier ${from} to ${upperLabel}`
                    return (
                      <tr key={i} className="align-top">
                        <td className="py-0.5 pr-2">
                          <MoneyInput id={`${rowId}-from`} value={Number(tier.debt_from)} onChange={(v) => update({ debt_from: v ?? 0 })} aria-label={`Debt from, ${name}`} />
                          {error && <FieldError alert size="xs" className="mt-1">{error}</FieldError>}
                        </td>
                        <td className="py-0.5 pr-2">
                          <MoneyInput id={`${rowId}-to`} value={tier.debt_to === null ? null : Number(tier.debt_to)} onChange={(v) => update({ debt_to: v })} placeholder="No upper bound" aria-label={`Debt to, ${name}`} />
                        </td>
                        <td className="py-0.5 pr-2">
                          <NumberInput id={`${rowId}-mult`} value={Number(tier.multiplier)} onChange={(v) => update({ multiplier: v ?? 0 })} min={0} max={MULTIPLIER_CEILING} step={0.0001} mono aria-label={`Multiplier, ${name}`} />
                        </td>
                        <td className="py-0.5 pt-1">
                          <RemoveButton label={`Remove ${name}`} onClick={() => replacePopulation(population, tiers.filter((_, j) => j !== i))} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <div>
              <Button
                variant="quiet"
                aria-label={`Add tier for ${label}`}
                onClick={() => {
                  const last = tiers[tiers.length - 1]
                  const from = last ? (last.debt_to === null ? Number(last.debt_from) : Number(last.debt_to)) : 0
                  replacePopulation(population, [...tiers, { population, debt_from: from, debt_to: null, multiplier: 0 }])
                }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add tier
              </Button>
            </div>
          </div>
        )
      })}
      <p className="text-xs text-hint">A lead pays its debt times the multiplier. Debt to is not included, so the next tier starts there.</p>
      {UNWIRED.length > 0 && (
        <p className="text-xs text-hint">{joinAnd(UNWIRED)} {UNWIRED.length === 1 ? 'is' : 'are'} not priced here yet: no workflow sells those leads through buyer selection.</p>
      )}
    </div>
  )
}
