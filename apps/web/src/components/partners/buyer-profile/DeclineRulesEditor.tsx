'use client'

/**
 * The decline rules of a buyer's outcome rules (#2325, PM-22): the rejection
 * group of the partner's response classification, which buyer selection and
 * Main Flow's Bid Group both read. Drawn in the same rows as the accept and
 * duplicate sets beside it (RuleSet, RULE_ROW), so the section has one row
 * style and says Field, Operator and Value once per set.
 *
 * A decline rule can also be judged on the HTTP status, which only the Bid
 * Group reads; such a rule keeps its row, its status and body field sharing the
 * Field column, and Add HTTP status rule keeps the way to make one (L677).
 */
import { useId } from 'react'
import { Plus } from 'lucide-react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS } from '@bidspoke/buyer-profile'
import type { BodyCondition, Rule, SignalRules, StatusCondition } from '@/app/(app)/partners/partner-draft'
import { LIST_OPERATORS } from '@/lib/signal-text'
import { Button, NumberInput, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import { RemoveButton } from '@/components/partners/RemoveButton'
import { emptyBody, emptyStatus, STATUS_CONDITIONS } from '@/components/partners/SignalRuleBuilder'
import { RULE_ROW, RuleSet } from './AcceptRulesEditor'

export const DECLINE_TITLE = 'Decline when any of'

const BODY_OPTIONS = SIGNAL_OPERATORS.map((op) => ({ value: op, label: SIGNAL_OPERATOR_LABELS[op] }))
const STATUS_OPTIONS = STATUS_CONDITIONS.map((op) => ({ value: op, label: SIGNAL_OPERATOR_LABELS[op] }))

export function DeclineRulesEditor({ value, onChange }: { value: SignalRules; onChange: (next: SignalRules) => void }) {
  const base = useId()
  const rules = value.rejection
  const set = (next: Rule[]) => onChange({ ...value, rejection: next })
  const update = (id: string, rule: Rule) => set(rules.map((r) => (r.id === id ? rule : r)))

  return (
    <RuleSet
      title={DECLINE_TITLE}
      empty="No rules."
      count={rules.length}
      after={
        <div className="flex flex-wrap gap-x-3">
          <Button variant="quiet" aria-label="Add decline rule" onClick={() => set([...rules, emptyBody()])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add rule
          </Button>
          <Button variant="quiet" aria-label="Add decline rule on the HTTP status" onClick={() => set([...rules, emptyStatus()])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add HTTP status rule
          </Button>
        </div>
      }
    >
      {rules.map((rule, i) => {
        // Each box's id follows its rule, so removing one leaves the others' ids where they were.
        const rowId = `${base}-${rule.id}`
        const name = `Decline rule ${i + 1}`
        const valueBox = (placeholder: string) => rule.condition === 'present'
          ? <span className="text-xs text-hint">any value</span>
          : <TextInput id={`${rowId}-value`} value={rule.value} onChange={(v) => update(rule.id, { ...rule, value: v })} placeholder={placeholder} mono aria-label={`${name} value`} />
        return (
          <div key={rule.id} role="group" aria-label={name} className={RULE_ROW}>
            {rule.kind === 'body' ? (
              <>
                <TextInput id={`${rowId}-field`} value={rule.field} onChange={(v) => update(rule.id, { ...rule, field: v })} placeholder="data.createLead.resultCode" mono aria-label={`${name} field`} />
                <Select id={`${rowId}-op`} aria-label={`${name} operator`} value={rule.condition} options={BODY_OPTIONS} onChange={(c) => update(rule.id, { ...rule, condition: c as BodyCondition })} />
                {valueBox(LIST_OPERATORS.has(rule.condition) ? '1000,1001' : 'value')}
              </>
            ) : (
              <>
                <div className="flex min-w-0 gap-1.5">
                  <NumberInput id={`${rowId}-code`} value={rule.code === '' ? null : Number(rule.code)} onChange={(v) => update(rule.id, { ...rule, code: v === null ? '' : String(v) })} step={1} placeholder="Status" aria-label={`${name} HTTP status`} className="w-20 shrink-0" />
                  <TextInput id={`${rowId}-body-field`} value={rule.bodyField} onChange={(v) => update(rule.id, { ...rule, bodyField: v })} placeholder="body field" mono aria-label={`${name} body field`} className="min-w-0 flex-1" />
                </div>
                <Select id={`${rowId}-op`} aria-label={`${name} operator`} value={rule.condition} options={STATUS_OPTIONS} onChange={(c) => update(rule.id, { ...rule, condition: c as StatusCondition })} />
                {valueBox(rule.condition === 'in' || rule.condition === 'not_in' ? '1000,1001' : 'value')}
              </>
            )}
            <RemoveButton label={`Remove decline rule ${i + 1}`} onClick={() => set(rules.filter((r) => r.id !== rule.id))} />
          </div>
        )
      })}
    </RuleSet>
  )
}
