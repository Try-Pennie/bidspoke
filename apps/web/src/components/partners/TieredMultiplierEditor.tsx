'use client'

import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'

interface Tier {
  above: number
  multiplier: number
}

interface Config {
  source_field: string
  tiers: Tier[]
  default_multiplier: number | null
  /**
   * Debt below which the partner does not bid at all (#1199). Null means no
   * floor, which is not the same rule as a floor of zero, so the two must stay
   * distinct all the way to the stored config.
   */
  min_source_value: number | null
}

interface Props {
  config: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

const PLACEHOLDER_FIELD = 'steps.eligibility.output.final'

export function TieredMultiplierEditor({ config, onChange }: Props) {
  const c = readConfig(config)
  const sourceFieldId = useId()
  const defaultMultiplierId = useId()
  const minimumId = useId()

  function patch(next: Partial<Config>) {
    const merged: Config = { ...c, ...next }
    onChange({
      ...config,
      pricing_mode: 'tiered_multiplier',
      source_field: merged.source_field,
      tiers: merged.tiers,
      default_multiplier: merged.default_multiplier,
      // Named here as well as on Config: this object is rebuilt from a list of
      // keys, so a field left off the list is silently dropped by every other
      // edit on the form (L510).
      min_source_value: merged.min_source_value,
    })
  }

  function addTier() {
    patch({ tiers: [...c.tiers, { above: 0, multiplier: 0 }] })
  }

  function updateTier(i: number, change: Partial<Tier>) {
    patch({ tiers: c.tiers.map((t, idx) => (idx === i ? { ...t, ...change } : t)) })
  }

  function removeTier(i: number) {
    patch({ tiers: c.tiers.filter((_, idx) => idx !== i) })
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={sourceFieldId} className="mb-1 block text-xs font-medium text-gray-600">Multiply this field</label>
        <p className="mb-1.5 text-xs text-gray-500">A reference to a value in the workflow. Common pattern: <code className="rounded bg-gray-100 px-1 font-mono">steps.&lt;name&gt;.output.&lt;field&gt;</code> for a step output, or a bare field name on the trigger payload.</p>
        <input
          id={sourceFieldId}
          value={c.source_field}
          onChange={(e) => patch({ source_field: e.target.value })}
          placeholder={PLACEHOLDER_FIELD}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
        />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <p className="mb-2 text-xs font-medium text-gray-600">Tiers</p>
        <p className="mb-3 text-xs text-gray-500">Each tier picks a multiplier when the field is above the threshold. First matching tier wins (highest threshold first). If nothing matches, the default multiplier below is used.</p>
        {c.tiers.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {c.tiers.map((tier, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-500">When &gt;</span>
                <input
                  type="number"
                  value={tier.above}
                  onChange={(e) => updateTier(i, { above: parseFloat(e.target.value) || 0 })}
                  className="w-28 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
                />
                <span className="text-gray-500">multiply by</span>
                <input
                  type="number"
                  step="0.01"
                  value={tier.multiplier}
                  onChange={(e) => updateTier(i, { multiplier: parseFloat(e.target.value) || 0 })}
                  className="w-24 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeTier(i)}
                  className="ml-auto text-gray-300 hover:text-red-400"
                  aria-label="Remove tier"
                  title="Remove tier"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={addTier}
          className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
        >
          <Plus className="h-3.5 w-3.5" />
          Add tier
        </button>
      </div>

      <div>
        <label htmlFor={defaultMultiplierId} className="mb-1 block text-xs font-medium text-gray-600">Default multiplier</label>
        <p className="mb-1.5 text-xs text-gray-500">Used when no tier matches.</p>
        <input
          id={defaultMultiplierId}
          type="number"
          step="0.01"
          value={c.default_multiplier ?? ''}
          onChange={(e) => {
            const v = e.target.value
            patch({ default_multiplier: v === '' ? null : parseFloat(v) })
          }}
          placeholder="0.10"
          className="w-32 rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
        />
      </div>

      <div>
        <label htmlFor={minimumId} className="mb-1 block text-xs font-medium text-gray-600">Minimum value</label>
        <p className="mb-1.5 text-xs text-gray-500">Below this, no bid is made at all. Leave empty to bid at any value.</p>
        <input
          id={minimumId}
          type="number"
          value={c.min_source_value ?? ''}
          onChange={(e) => {
            const v = e.target.value
            // Empty means no floor. Zero is a floor of zero, a different rule,
            // so it must not collapse into the same value (#1199).
            patch({ min_source_value: v === '' ? null : parseFloat(v) })
          }}
          placeholder="none"
          className="w-32 rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-p-blue-dark"
        />
      </div>
    </div>
  )
}

function readConfig(raw: Record<string, unknown>): Config {
  const tiers: Tier[] = Array.isArray(raw.tiers)
    ? (raw.tiers as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          above: typeof t.above === 'number' ? t.above : parseFloat(String(t.above ?? '0')) || 0,
          multiplier: typeof t.multiplier === 'number' ? t.multiplier : parseFloat(String(t.multiplier ?? '0')) || 0,
        }))
    : []
  return {
    source_field: typeof raw.source_field === 'string' ? raw.source_field : '',
    tiers,
    default_multiplier:
      typeof raw.default_multiplier === 'number'
        ? raw.default_multiplier
        : raw.default_multiplier == null
          ? null
          : parseFloat(String(raw.default_multiplier)) || null,
    min_source_value:
      typeof raw.min_source_value === 'number'
        ? raw.min_source_value
        : raw.min_source_value == null
          ? null
          // Number(), not parseFloat() || null: `parseFloat('0') || null` is
          // null, which would read a declared floor of zero as no floor.
          : Number.isFinite(Number(raw.min_source_value))
            ? Number(raw.min_source_value)
            : null,
  }
}
