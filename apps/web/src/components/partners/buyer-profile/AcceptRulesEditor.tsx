'use client'

/**
 * The accept rules editor (#1412): the buyer_select accept signals on the
 * partner record. A sale is accepted only when the answer is 2xx and EVERY
 * rule here matches, so with no rule no answer is ever an accept (L72). The
 * operator is a picker over the shared vocabulary (L611) and the enable
 * refusal renders beside this control (L111).
 *
 * Drawn as the settled design draws the outcome rules (#2325, PM-22, frame
 * 19): a set titled by what a match does, the column names Field, Operator and
 * Value said once over its rows, one row per rule, Add rule, and a grey
 * sentence when the set is empty. RuleSet and RULE_ROW are shared with the
 * decline rules, so the three sets of the section read alike.
 */
import { useId } from 'react'
import { Plus } from 'lucide-react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS, type Signal, type SignalOperator } from '@bidspoke/buyer-profile'
import { Button, FieldError, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import { LIST_OPERATORS, operatorOf, signalFrom, valueTextOf } from '@/lib/signal-text'
import { RemoveButton } from '@/components/partners/RemoveButton'
import { SECTION_LABELS } from './labels'

/**
 * The same rows edit the duplicate rules (#1416): the decline answers that mean
 * the buyer already holds the lead. The kind names every row and the add
 * button, and the empty state says what an empty list means for THAT list.
 */
export type RuleKind = 'accept' | 'duplicate'

const EMPTY_NOTE: Record<RuleKind, string> = {
  accept: 'No rules. No answer counts as a sale.',
  duplicate: 'No rules. Every decline is recorded as Fail.',
}

const TITLE: Record<RuleKind, string> = {
  accept: SECTION_LABELS.accept_signals,
  duplicate: SECTION_LABELS.duplicate_signals,
}

/** One rule's columns: field, operator, value, the remove mark (the design's rows). */
export const RULE_ROW = 'grid grid-cols-[minmax(0,1fr)_9.5rem_minmax(0,1fr)_1.75rem] items-center gap-2'

/** A set of rules: its title, the column names once over its rows, the rows, then what it adds. */
export function RuleSet({ title, empty, count, children, after }: { title: string; empty: string; count: number; children: React.ReactNode; after: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} className="space-y-1.5">
      <p className="text-[13px] font-semibold text-graphite">{title}</p>
      {count === 0 ? (
        <p className="text-xs text-hint">{empty}</p>
      ) : (
        <>
          {/* Each box carries its own name for a screen reader, so the column names are for the eye. */}
          <div aria-hidden="true" className={`${RULE_ROW} text-[11.5px] text-hint`}>
            <span>Field</span>
            <span>Operator</span>
            <span>Value</span>
            <span />
          </div>
          {children}
        </>
      )}
      {after}
    </div>
  )
}

export function AcceptRulesEditor({ value, onChange, refusal, kind = 'accept' }: { value: readonly Signal[]; onChange: (rules: Signal[]) => void; refusal?: string | null; kind?: RuleKind }) {
  const base = useId()
  const update = (i: number, next: Signal) => onChange(value.map((r, j) => (j === i ? next : r)))
  const Kind = kind.charAt(0).toUpperCase() + kind.slice(1)

  return (
    <RuleSet
      title={TITLE[kind]}
      empty={EMPTY_NOTE[kind]}
      count={value.length}
      after={
        <>
          {refusal && <FieldError alert size="xs">{refusal}</FieldError>}
          <div>
            <Button variant="quiet" aria-label={`Add ${kind} rule`} onClick={() => onChange([...value, { field: '', equals: '' }])}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add rule
            </Button>
          </div>
        </>
      }
    >
      {value.map((rule, i) => {
        const op = operatorOf(rule)
        const text = valueTextOf(rule)
        const rowId = `${base}-${i}`
        const name = `${Kind} rule ${i + 1}`
        return (
          <div key={i} role="group" aria-label={name} className={RULE_ROW}>
            <TextInput id={`${rowId}-field`} value={rule.field} onChange={(v) => update(i, signalFrom(v, op, text))} placeholder="data.createLead.resultCode" mono aria-label={`${name} field`} />
            <Select id={`${rowId}-op`} aria-label={`${name} operator`} value={op} onChange={(v) => update(i, signalFrom(rule.field, v as SignalOperator, text))} options={SIGNAL_OPERATORS.map((o) => ({ value: o, label: SIGNAL_OPERATOR_LABELS[o] }))} />
            {op === 'present' ? (
              <span className="text-xs text-hint">any value</span>
            ) : (
              <TextInput id={`${rowId}-value`} value={text} onChange={(v) => update(i, signalFrom(rule.field, op, v))} placeholder={LIST_OPERATORS.has(op) ? '1000,1001' : 'true'} mono aria-label={`${name} value`} />
            )}
            <RemoveButton label={`Remove ${kind} rule ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
        )
      })}
    </RuleSet>
  )
}
