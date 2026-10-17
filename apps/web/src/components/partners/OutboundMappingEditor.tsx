'use client'

import { useId } from 'react'
import { Plus } from 'lucide-react'
import { Button, TextInput } from '@/components/ui/form'
import { RemoveButton } from '@/components/partners/RemoveButton'

interface MappingRule {
  source: string
  target: string
}

interface Props {
  value: Record<string, unknown> | null
  onChange: (next: Record<string, unknown> | null) => void
  /** Named in the empty line, as the design says it (PM-23). */
  partnerName: string
}

/**
 * The Request row's field mapping (PM-23, #2326): which lead fields are renamed
 * before the request goes to the partner. Empty sends the lead unchanged, said
 * in one plain line.
 */
export function OutboundMappingEditor({ value, onChange, partnerName }: Props) {
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
    <div className="space-y-2">
      {rules.length === 0 ? (
        <p className="text-[13px] text-hint">No field is renamed before it is sent to {partnerName}.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-gray-600">
              <th scope="col" className="pb-1 pr-2 font-medium">Field in the lead</th>
              <th scope="col" className="pb-1 pr-2 font-medium">Sent as</th>
              <th scope="col" className="w-8 pb-1"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((row, i) => (
              <tr key={i} className="align-middle">
                <td className="py-0.5 pr-2">
                  <TextInput id={`${base}-${i}-source`} aria-label={`Field in the lead, mapping ${i + 1}`} value={row.source} onChange={(v) => updateRow(i, { source: v })} placeholder="debt_amount" mono />
                </td>
                <td className="py-0.5 pr-2">
                  <TextInput id={`${base}-${i}-target`} aria-label={`Sent as, mapping ${i + 1}`} value={row.target} onChange={(v) => updateRow(i, { target: v })} placeholder="DebtAmount" mono />
                </td>
                <td className="py-0.5">
                  <RemoveButton label={`Remove mapping ${i + 1}`} onClick={() => removeRow(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Button variant="quiet" onClick={addRow}>
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
