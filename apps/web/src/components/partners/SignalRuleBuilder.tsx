'use client'

/**
 * The response classification rule builder, extracted from PartnerForm (#1412,
 * L613) so it renders once per group wherever a group belongs: the partner
 * form's Response classification section shows transient and permanent, the
 * Buyer profile section shows the decline rules (rejection) beside the accept
 * rules. `sections` says which groups this instance renders; the state is one
 * object owned by the form, so a rule is never held in two places.
 */
import { useId, useRef, useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS } from '@bidspoke/buyer-profile'
import {
  type Rule, type BodyRule, type StatusRule, type BodyCondition, type StatusCondition, type SignalCategory, type SignalRules,
} from '@/app/(app)/partners/partner-draft'
import { LIST_OPERATORS } from '@/lib/signal-text'
import { Button, NumberInput, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'

type RuleKind = 'body' | 'status'

/** The conditions an HTTP status rule can carry, labelled with the same words as the body rules (L118). */
const STATUS_CONDITIONS: readonly StatusCondition[] = ['contains', 'in', 'not_in', 'present']

function uid() { return Math.random().toString(36).slice(2) }
export function emptyBody(): BodyRule { return { id: uid(), kind: 'body', field: '', condition: 'equals', value: '' } }
export function emptyStatus(): StatusRule { return { id: uid(), kind: 'status', code: '', bodyField: '', condition: 'contains', value: '' } }

export interface SignalSection {
  cat: SignalCategory
  label: string
  desc: string
}

/** The three legacy groups with their long standing copy. */
export const SIGNAL_SECTIONS: readonly SignalSection[] = [
  { cat: 'rejection', label: 'Rejection',      desc: 'Partner declined the lead. Logged as a business rejection, never retried.' },
  { cat: 'transient', label: 'Transient error', desc: 'Temporary failure. Will be retried according to the workflow retry policy.' },
  { cat: 'permanent', label: 'Permanent error', desc: 'Unrecoverable failure. No retry, triggers alerts.' },
]

const KIND_OPTIONS: ReadonlyArray<{ value: RuleKind; label: string }> = [
  { value: 'body', label: 'Body field' },
  { value: 'status', label: 'HTTP status' },
]
const BODY_CONDITION_OPTIONS = SIGNAL_OPERATORS.map((op) => ({ value: op, label: SIGNAL_OPERATOR_LABELS[op] }))
const STATUS_CONDITION_OPTIONS = STATUS_CONDITIONS.map((op) => ({ value: op, label: SIGNAL_OPERATOR_LABELS[op] }))

/** One rule, on the shared controls (#1458): the same Select, boxes and button as the Buyer profile beside it. */
function RuleRow({ rule, onChange, onRemove, removing }: {
  rule: Rule
  onChange: (r: Rule) => void
  onRemove: () => void
  removing?: boolean
}) {
  const id = useId()
  return (
    <div className={`rule-row flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2${removing ? ' rule-row-exiting' : ''}`}>
      <Select
        id={`${id}-kind`}
        aria-label="Rule kind"
        value={rule.kind}
        options={KIND_OPTIONS}
        onChange={(k) => onChange(k === 'body' ? { ...emptyBody(), id: rule.id } : { ...emptyStatus(), id: rule.id })}
        className="w-32 shrink-0"
      />

      {rule.kind === 'body' ? (
        <>
          <TextInput id={`${id}-field`} aria-label="Field" value={rule.field} onChange={(v) => onChange({ ...rule, field: v })} placeholder="field" className="w-44 shrink-0" />
          <Select
            id={`${id}-condition`}
            aria-label="Condition"
            value={rule.condition}
            options={BODY_CONDITION_OPTIONS}
            onChange={(c) => onChange({ ...rule, condition: c as BodyCondition })}
            className="w-56 shrink-0"
          />
          {rule.condition !== 'present' && (
            <TextInput
              id={`${id}-value`}
              aria-label="Value"
              value={rule.value}
              onChange={(v) => onChange({ ...rule, value: v })}
              placeholder={LIST_OPERATORS.has(rule.condition) ? 'value1,value2,value3' : 'value'}
              className="min-w-[16rem] flex-1"
            />
          )}
        </>
      ) : (
        <>
          <NumberInput
            id={`${id}-code`}
            aria-label="Status code"
            value={rule.code === '' ? null : Number(rule.code)}
            onChange={(v) => onChange({ ...rule, code: v === null ? '' : String(v) })}
            step={1}
            placeholder="status"
            className="w-24"
          />
          <TextInput id={`${id}-body-field`} aria-label="Body field" value={rule.bodyField} onChange={(v) => onChange({ ...rule, bodyField: v })} placeholder="body field" className="w-32" />
          <Select
            id={`${id}-condition`}
            aria-label="Condition"
            value={rule.condition}
            options={STATUS_CONDITION_OPTIONS}
            onChange={(c) => onChange({ ...rule, condition: c as StatusCondition })}
            className="w-40 shrink-0"
          />
          {rule.condition !== 'present' && (
            <TextInput
              id={`${id}-value`}
              aria-label="Value"
              value={rule.value}
              onChange={(v) => onChange({ ...rule, value: v })}
              placeholder={rule.condition === 'in' || rule.condition === 'not_in' ? 'value1,value2,value3' : 'value'}
              className="min-w-0 flex-1"
            />
          )}
        </>
      )}
      <Button variant="ghost" onClick={onRemove} aria-label="Remove rule" className="ml-auto shrink-0">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

/**
 * What a group carries beyond its rules, for the Retry and Never retry lists
 * (#2143, PM-11): a control beside the heading (the list's Alert switch), and
 * the fixed rows the person's rules are checked before (the defaults). A group
 * with these is a labelled group, its rules first, then the fixed rows, then
 * Add rule, so a new rule lands above the defaults it is checked before.
 */
export interface SignalSectionExtras {
  aside: ReactNode
  after: ReactNode
}

export function SignalRuleBuilder({ value, onChange, sections = SIGNAL_SECTIONS, extras }: {
  value: SignalRules
  onChange: (v: SignalRules) => void
  /** Which groups this instance renders. Defaults to all three. */
  sections?: readonly SignalSection[]
  extras?: Partial<Record<SignalCategory, SignalSectionExtras>>
}) {
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const valueRef = useRef(value)
  valueRef.current = value

  function update(cat: SignalCategory, id: string, rule: Rule) {
    onChange({ ...value, [cat]: value[cat].map((r) => (r.id === id ? rule : r)) })
  }
  function remove(cat: SignalCategory, id: string) {
    setRemovingIds((prev) => new Set([...prev, id]))
    setTimeout(() => {
      const cur = valueRef.current
      onChange({ ...cur, [cat]: cur[cat].filter((r) => r.id !== id) })
      setRemovingIds((prev) => { const s = new Set(prev); s.delete(id); return s })
    }, 150)
  }
  function add(cat: SignalCategory) {
    onChange({ ...value, [cat]: [...value[cat], emptyBody()] })
  }

  const ruleRows = (cat: SignalCategory) => (
    <div className="space-y-1.5">
      {value[cat].map((rule) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          removing={removingIds.has(rule.id)}
          onChange={(r) => update(cat, rule.id, r)}
          onRemove={() => remove(cat, rule.id)}
        />
      ))}
    </div>
  )
  const addButton = (cat: SignalCategory) => (
    <Button variant="ghost" onClick={() => add(cat)} className="shrink-0">
      <Plus className="h-3 w-3" aria-hidden="true" />
      Add rule
    </Button>
  )

  return (
    <div className="space-y-5">
      {sections.map(({ cat, label, desc }) => extras?.[cat] ? (
        <div key={cat} role="group" aria-label={label} className="space-y-1.5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium text-gray-700">{label}</p>
            {extras[cat].aside}
          </div>
          {value[cat].length > 0 && ruleRows(cat)}
          {extras[cat].after}
          <div>{addButton(cat)}</div>
        </div>
      ) : (
        <div key={cat}>
          <div className="mb-2 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-700">{label}</p>
              <p className="text-xs text-hint">{desc}</p>
            </div>
            {addButton(cat)}
          </div>
          {value[cat].length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-hint">
              No rules. Uses default HTTP status classification.
            </p>
          ) : ruleRows(cat)}
        </div>
      ))}
    </div>
  )
}
