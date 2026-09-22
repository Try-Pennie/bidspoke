'use client'

/**
 * The accept rules editor (#1412): the buyer_select accept signals on the
 * partner record. A sale is accepted only when the answer is 2xx and EVERY
 * rule here matches, so with no rule no answer is ever an accept (L72). The
 * operator is a picker over the shared vocabulary (L611) and the enable
 * refusal renders beside this control (L111).
 */
import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { SIGNAL_OPERATORS, type Signal, type SignalOperator } from '@bidspoke/buyer-profile'
import { Button, Select, TextInput } from '@/components/ui/form'

const OPERATOR_LABELS: Record<SignalOperator, string> = {
  present: 'is present',
  equals: 'equals',
  contains: 'contains',
  in: 'is one of',
  not_in: 'is none of',
  any_item_contains: 'any item contains',
  any_item_word_prefix_ci: 'any item has a word starting with',
}

const LIST_OPERATORS: ReadonlySet<SignalOperator> = new Set(['in', 'not_in'])

/** The operator a signal carries, or equals when it carries none yet. */
export function operatorOf(sig: Signal): SignalOperator {
  for (const op of SIGNAL_OPERATORS) if (sig[op] !== undefined) return op
  return 'equals'
}

/** The value a signal carries, as the text the box shows. */
export function valueTextOf(sig: Signal): string {
  const op = operatorOf(sig)
  const v = sig[op]
  if (op === 'present') return ''
  if (Array.isArray(v)) return v.map((x) => String(x)).join(',')
  return v === undefined || v === null ? '' : String(v)
}

/** A comma separated list, numeric tokens kept numeric, everything else text (the legacy rule builder's reading). */
function parseList(text: string): unknown[] {
  return text.split(',').map((t) => t.trim()).filter(Boolean).map((t) => (/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t))
}

function scalar(text: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

/** Rebuild a signal from its field, operator and text. */
export function signalFrom(field: string, op: SignalOperator, text: string): Signal {
  if (op === 'present') return { field, present: true }
  if (LIST_OPERATORS.has(op)) return { field, [op]: parseList(text) } as Signal
  if (op === 'equals') return { field, equals: scalar(text) }
  return { field, [op]: text } as Signal
}

export function AcceptRulesEditor({ value, onChange, refusal }: { value: readonly Signal[]; onChange: (rules: Signal[]) => void; refusal?: string | null }) {
  const base = useId()
  const update = (i: number, next: Signal) => onChange(value.map((r, j) => (j === i ? next : r)))

  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-xs text-amber-800">Without a rule, no answer is an accept: every sale would be refused.</p>}
      {value.map((rule, i) => {
        const op = operatorOf(rule)
        const text = valueTextOf(rule)
        const rowId = `${base}-${i}`
        return (
          <fieldset key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-end gap-2 rounded-md bg-gray-50 p-2" aria-label={`Accept rule ${i + 1}`}>
            <div>
              <label htmlFor={`${rowId}-field`} className="mb-1 block text-xs text-gray-600">Field</label>
              <TextInput id={`${rowId}-field`} value={rule.field} onChange={(v) => update(i, signalFrom(v, op, text))} placeholder="data.createLead.resultCode" mono />
            </div>
            <div>
              <label htmlFor={`${rowId}-op`} className="mb-1 block text-xs text-gray-600">Operator</label>
              <Select id={`${rowId}-op`} value={op} onChange={(v) => update(i, signalFrom(rule.field, v as SignalOperator, text))} options={SIGNAL_OPERATORS.map((o) => ({ value: o, label: OPERATOR_LABELS[o] }))} />
            </div>
            {op === 'present' ? (
              <span className="text-xs text-gray-500">any value</span>
            ) : (
              <div>
                <label htmlFor={`${rowId}-value`} className="mb-1 block text-xs text-gray-600">Value</label>
                <TextInput id={`${rowId}-value`} value={text} onChange={(v) => update(i, signalFrom(rule.field, op, v))} placeholder={LIST_OPERATORS.has(op) ? '1000,1001' : 'true'} mono />
              </div>
            )}
            <Button variant="ghost" aria-label={`Remove accept rule ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </fieldset>
        )
      })}
      {refusal && <p role="alert" className="text-xs text-red-700">{refusal}</p>}
      <Button variant="ghost" aria-label="Add accept rule" onClick={() => onChange([...value, { field: '', equals: '' }])}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add rule
      </Button>
    </div>
  )
}
