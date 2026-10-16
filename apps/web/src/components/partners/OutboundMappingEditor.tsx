'use client'

import { useId } from 'react'
import { ArrowRight, Plus, Trash2 } from 'lucide-react'
import { Button, TextInput } from '@/components/ui/form'

interface MappingRule {
  source: string
  target: string
}

interface Props {
  value: Record<string, unknown> | null
  onChange: (next: Record<string, unknown> | null) => void
}

export function OutboundMappingEditor({ value, onChange }: Props) {
  const base = useId()
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
      <p className="text-xs text-hint">
        Reshape the lead payload before posting to this partner. Source is a payload field path (dot-notation supported, e.g. <code className="rounded bg-gray-100 px-1 font-mono">lead.debt_amount</code>). Target is the wire-format field name (e.g. <code className="rounded bg-gray-100 px-1 font-mono">DebtAmount__c</code>). Missing fields become null. Leave empty to send the payload unchanged.
      </p>

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <TextInput id={`${base}-${i}-source`} aria-label={`Source field, mapping ${i + 1}`} value={row.source} onChange={(v) => updateRow(i, { source: v })} placeholder="debt_amount" mono className="min-w-0 flex-1" />
              <ArrowRight className="h-3 w-3 flex-shrink-0 text-gray-300" aria-hidden="true" />
              <TextInput id={`${base}-${i}-target`} aria-label={`Target field, mapping ${i + 1}`} value={row.target} onChange={(v) => updateRow(i, { target: v })} placeholder="DebtAmount" mono className="min-w-0 flex-1" />
              <Button variant="ghost" onClick={() => removeRow(i)} aria-label={`Remove mapping ${i + 1}`} title="Remove" className="shrink-0">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Button variant="ghost" onClick={addRow}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add field
      </Button>
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
