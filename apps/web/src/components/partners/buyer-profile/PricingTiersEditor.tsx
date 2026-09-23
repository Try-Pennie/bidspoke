'use client'

/**
 * The pricing tiers editor (#1412): a ladder per WIRED population, each rung a
 * debt range and a multiplier. Populations not yet wired to a buyer_select node
 * are named as not yet in use and get no inputs (L46, L703), so the form cannot
 * store pricing nothing reads. The worked example and the ceiling are each
 * stated once (L604, L605), and each ladder is a table whose column headers
 * are said once over its rungs (L579).
 */
import { useId } from 'react'
import { MULTIPLIER_CEILING, POPULATIONS, WIRED_POPULATIONS, type Population, type ProfileTierDocument } from '@bidspoke/buyer-profile'
import { Trash2, Plus } from 'lucide-react'
import { Button, NumberInput } from '@/components/ui/form'
import { POPULATION_LABELS, formatWhole } from './labels'

const WIRED: ReadonlySet<string> = new Set(WIRED_POPULATIONS)

export function PricingTiersEditor({ value, onChange, errors = {} }: { value: readonly ProfileTierDocument[]; onChange: (tiers: ProfileTierDocument[]) => void; errors?: Record<string, string> }) {
  const base = useId()

  const forPopulation = (population: string) => value.filter((t) => t.population === population).sort((a, b) => Number(a.debt_from) - Number(b.debt_from))
  const replacePopulation = (population: string, tiers: ProfileTierDocument[]) => onChange([...value.filter((t) => t.population !== population), ...tiers])

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        A tier prices every lead whose debt falls in its range at debt times the multiplier. $18,250 of debt at 0.0012 pays $21.90. A multiplier is a share of the debt, so it is never above {MULTIPLIER_CEILING}. Tiers must touch with no gap and no overlap, from the debt minimum to the debt maximum. The upper bound is not included: a Salesforce band written 10,000 to 12,499 is entered as 10,000 to 12,500, and the next tier starts at 12,500.
      </p>
      {POPULATIONS.map((population: Population) => {
        const tiers = forPopulation(population)
        const wired = WIRED.has(population)
        const label = POPULATION_LABELS[population]
        return (
          <fieldset key={population} data-population={population} className="rounded-lg border border-gray-200 p-3">
            <legend className="px-1 text-xs font-medium text-gray-600">{label}</legend>
            {!wired ? (
              <p className="text-xs text-gray-500">Not yet in use: no workflow sells these leads through buyer selection.</p>
            ) : (
              <div className="space-y-2">
                {tiers.length === 0 ? (
                  <p className="text-xs text-amber-800">No pricing: this buyer cannot be offered a {label} lead.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs font-medium text-gray-600">
                        <th scope="col" className="pb-1 pr-2 font-medium">Debt from</th>
                        <th scope="col" className="pb-1 pr-2 font-medium">Debt to</th>
                        <th scope="col" className="pb-1 pr-2 font-medium">Multiplier</th>
                        <th scope="col" className="w-10 pb-1"><span className="sr-only">Remove</span></th>
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
                              <NumberInput id={`${rowId}-from`} value={Number(tier.debt_from)} onChange={(v) => update({ debt_from: v ?? 0 })} min={0} step={1} aria-label={`Debt from, ${name}`} />
                              {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
                            </td>
                            <td className="py-0.5 pr-2">
                              <NumberInput id={`${rowId}-to`} value={tier.debt_to === null ? null : Number(tier.debt_to)} onChange={(v) => update({ debt_to: v })} min={0} step={1} placeholder="no upper bound" aria-label={`Debt to, ${name}`} />
                            </td>
                            <td className="py-0.5 pr-2">
                              <NumberInput id={`${rowId}-mult`} value={Number(tier.multiplier)} onChange={(v) => update({ multiplier: v ?? 0 })} min={0} max={MULTIPLIER_CEILING} step={0.0001} aria-label={`Multiplier, ${name}`} />
                            </td>
                            <td className="py-0.5">
                              <Button variant="ghost" aria-label={`Remove ${name}`} onClick={() => replacePopulation(population, tiers.filter((_, j) => j !== i))}>
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                <Button
                  variant="ghost"
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
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
