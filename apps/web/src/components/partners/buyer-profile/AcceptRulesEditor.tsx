'use client'

/**
 * The accept rules editor (#1412): the buyer_select accept signals on the
 * partner record. A sale is accepted only when the answer is 2xx and EVERY
 * rule here matches, so with no rule no answer is ever an accept (L72). The
 * operator is a picker over the shared vocabulary (L611) and the enable
 * refusal renders beside this control (L111).
 */
import { useId } from 'react'
import { Plus } from 'lucide-react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS, type Signal, type SignalOperator } from '@bidspoke/buyer-profile'
import { Button, FieldError, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import { LIST_OPERATORS, operatorOf, signalFrom, valueTextOf } from '@/lib/signal-text'
import { RemoveButton } from '@/components/partners/RemoveButton'

/**
 * The same rows edit the duplicate rules (#1416): the decline answers that mean
 * the buyer already holds the lead. The kind names every row and the add
 * button, and the empty state says what an empty list means for THAT list.
 */
export type RuleKind = 'accept' | 'duplicate'

const EMPTY_NOTE: Record<RuleKind, string> = {
  accept: 'Without a rule, no answer is an accept: every sale would be refused.',
  duplicate: 'Without a rule, every decline is recorded as Fail; add one for the answers that mean the buyer already holds the lead.',
}

export function AcceptRulesEditor({ value, onChange, refusal, kind = 'accept' }: { value: readonly Signal[]; onChange: (rules: Signal[]) => void; refusal?: string | null; kind?: RuleKind }) {
  const base = useId()
  const update = (i: number, next: Signal) => onChange(value.map((r, j) => (j === i ? next : r)))
  const Kind = kind.charAt(0).toUpperCase() + kind.slice(1)

  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-xs text-amber-800">{EMPTY_NOTE[kind]}</p>}
      {value.map((rule, i) => {
        const op = operatorOf(rule)
        const text = valueTextOf(rule)
        const rowId = `${base}-${i}`
        return (
          // The row wraps rather than cutting a long field or value short (#1458, L76):
          // Tripoint's accept list read '1000,1001,1013,1' in a fixed grid.
          <fieldset key={i} className="flex flex-wrap items-end gap-2 rounded-md bg-gray-50 p-2" aria-label={`${Kind} rule ${i + 1}`}>
            <div className="min-w-[14rem] flex-1">
              <label htmlFor={`${rowId}-field`} className="mb-1 block text-xs text-gray-600">Field</label>
              <TextInput id={`${rowId}-field`} value={rule.field} onChange={(v) => update(i, signalFrom(v, op, text))} placeholder="data.createLead.resultCode" mono />
            </div>
            <div className="w-44">
              <label htmlFor={`${rowId}-op`} className="mb-1 block text-xs text-gray-600">Operator</label>
              <Select id={`${rowId}-op`} value={op} onChange={(v) => update(i, signalFrom(rule.field, v as SignalOperator, text))} options={SIGNAL_OPERATORS.map((o) => ({ value: o, label: SIGNAL_OPERATOR_LABELS[o] }))} />
            </div>
            {op === 'present' ? (
              <span className="pb-2 text-xs text-hint">any value</span>
            ) : (
              <div className="min-w-[16rem] flex-1">
                <label htmlFor={`${rowId}-value`} className="mb-1 block text-xs text-gray-600">Value</label>
                <TextInput id={`${rowId}-value`} value={text} onChange={(v) => update(i, signalFrom(rule.field, op, v))} placeholder={LIST_OPERATORS.has(op) ? '1000,1001' : 'true'} mono />
              </div>
            )}
            <RemoveButton label={`Remove ${kind} rule ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </fieldset>
        )
      })}
      {refusal && <FieldError alert size="xs">{refusal}</FieldError>}
      <Button variant="quiet" aria-label={`Add ${kind} rule`} onClick={() => onChange([...value, { field: '', equals: '' }])}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add rule
      </Button>
    </div>
  )
}
