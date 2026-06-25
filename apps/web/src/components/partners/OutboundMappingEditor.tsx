'use client'

import { ArrowRight, Plus, Trash2 } from 'lucide-react'

interface MappingRule {
  source: string
  target: string
}

interface Props {
  value: Record<string, unknown> | null
  onChange: (next: Record<string, unknown> | null) => void
}

export function OutboundMappingEditor({ value, onChange }: Props) {
  const rules = readRules(value)

  function update(next: MappingRule[]) {
    if (next.length === 0) {
      onChange(null)
    } else {
      onChange({ mappings: next })
    }
  }

  function addRow() {
    update([...rules, { source: '', target: '' }])
  }

  function updateRow(i: number, patch: Partial<MappingRule>) {
    update(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function removeRow(i: number) {
    update(rules.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Reshape the lead payload before posting to this partner. Source is a payload field path (dot-notation supported, e.g. <code className="rounded bg-gray-100 px-1 font-mono">lead.debt_amount</code>). Target is the wire-format field name (e.g. <code className="rounded bg-gray-100 px-1 font-mono">DebtAmount__c</code>). Missing fields become null. Leave empty to send the payload unchanged.
      </p>

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={row.source}
                onChange={(e) => updateRow(i, { source: e.target.value })}
                placeholder="debt_amount"
                className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
              />
              <ArrowRight className="h-3 w-3 flex-shrink-0 text-gray-300" />
              <input
                value={row.target}
                onChange={(e) => updateRow(i, { target: e.target.value })}
                placeholder="DebtAmount"
                className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="flex-shrink-0 text-gray-300 hover:text-red-400"
                aria-label="Remove mapping"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
      >
        <Plus className="h-3.5 w-3.5" />
        Add field
      </button>
    </div>
  )
}

function readRules(value: Record<string, unknown> | null): MappingRule[] {
  if (!value || typeof value !== 'object') return []
  const raw = (value as { mappings?: unknown }).mappings
  if (!Array.isArray(raw)) return []
  return raw
    .map((r): MappingRule | null => {
      if (!r || typeof r !== 'object') return null
      const obj = r as Record<string, unknown>
      const source = typeof obj.source === 'string' ? obj.source : ''
      const target = typeof obj.target === 'string' ? obj.target : ''
      return { source, target }
    })
    .filter((r): r is MappingRule => r !== null)
}
