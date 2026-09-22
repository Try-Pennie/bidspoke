'use client'

/**
 * The response classification rule builder, extracted from PartnerForm (#1412,
 * L613) so it renders once per group wherever a group belongs: the partner
 * form's Response classification section shows transient and permanent, the
 * Buyer profile section shows the decline rules (rejection) beside the accept
 * rules. `sections` says which groups this instance renders; the state is one
 * object owned by the form, so a rule is never held in two places.
 */
import { useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { SIGNAL_OPERATORS, SIGNAL_OPERATOR_LABELS } from '@bidspoke/buyer-profile'
import {
  type Rule, type BodyRule, type StatusRule, type BodyCondition, type StatusCondition, type SignalCategory, type SignalRules,
} from '@/app/(app)/partners/partner-body'
import { LIST_OPERATORS } from '@/lib/signal-text'

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

const inputCls = 'rounded border border-gray-200 bg-white px-2 py-1 text-sm text-graphite placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-p-blue-dark'

function RuleRow({ rule, onChange, onRemove, removing }: {
  rule: Rule
  onChange: (r: Rule) => void
  onRemove: () => void
  removing?: boolean
}) {
  return (
    <div className={`rule-row flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2${removing ? ' rule-row-exiting' : ''}`}>
      <select
        value={rule.kind}
        aria-label="Rule kind"
        onChange={(e) => {
          const k = e.target.value as RuleKind
          onChange(k === 'body' ? { ...emptyBody(), id: rule.id } : { ...emptyStatus(), id: rule.id })
        }}
        className={`${inputCls} flex-shrink-0`}
      >
        <option value="body">Body field</option>
        <option value="status">HTTP status</option>
      </select>

      {rule.kind === 'body' ? (
        <>
          <input
            value={rule.field}
            onChange={(e) => onChange({ ...rule, field: e.target.value })}
            placeholder="field"
            aria-label="Field"
            className={`${inputCls} w-44 flex-shrink-0`}
          />
          <select
            value={rule.condition}
            aria-label="Condition"
            onChange={(e) => onChange({ ...rule, condition: e.target.value as BodyCondition })}
            className={`${inputCls} flex-shrink-0`}
          >
            {SIGNAL_OPERATORS.map((op) => (
              <option key={op} value={op}>{SIGNAL_OPERATOR_LABELS[op]}</option>
            ))}
          </select>
          {rule.condition !== 'present' && (
            <input
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder={LIST_OPERATORS.has(rule.condition) ? 'value1,value2,value3' : 'value'}
              aria-label="Value"
              className={`${inputCls} min-w-[16rem] flex-1`}
            />
          )}
        </>
      ) : (
        <>
          <input
            value={rule.code}
            onChange={(e) => onChange({ ...rule, code: e.target.value })}
            placeholder="status"
            type="number"
            aria-label="Status code"
            className={`${inputCls} w-20`}
          />
          <input
            value={rule.bodyField}
            onChange={(e) => onChange({ ...rule, bodyField: e.target.value })}
            placeholder="body field"
            aria-label="Body field"
            className={`${inputCls} w-28`}
          />
          <select
            value={rule.condition}
            aria-label="Condition"
            onChange={(e) => onChange({ ...rule, condition: e.target.value as StatusCondition })}
            className={`${inputCls} flex-shrink-0`}
          >
            {STATUS_CONDITIONS.map((op) => (
              <option key={op} value={op}>{SIGNAL_OPERATOR_LABELS[op]}</option>
            ))}
          </select>
          {rule.condition !== 'present' && (
            <input
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder={rule.condition === 'in' || rule.condition === 'not_in' ? 'value1,value2,value3' : 'value'}
              aria-label="Value"
              className={`${inputCls} min-w-0 flex-1`}
            />
          )}
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove rule"
        className="ml-auto flex-shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-600"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function SignalRuleBuilder({ value, onChange, sections = SIGNAL_SECTIONS }: {
  value: SignalRules
  onChange: (v: SignalRules) => void
  /** Which groups this instance renders. Defaults to all three. */
  sections?: readonly SignalSection[]
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

  return (
    <div className="space-y-5">
      {sections.map(({ cat, label, desc }) => (
        <div key={cat}>
          <div className="mb-2 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-700">{label}</p>
              <p className="text-xs text-gray-500">{desc}</p>
            </div>
            <button
              type="button"
              onClick={() => add(cat)}
              className="flex flex-shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-p-blue-dark hover:bg-p-blue-light"
            >
              <Plus className="h-3 w-3" />
              Add rule
            </button>
          </div>
          {value[cat].length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-500">
              No rules. Uses default HTTP status classification.
            </p>
          ) : (
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
          )}
        </div>
      ))}
    </div>
  )
}
