'use client'

import type { ConditionGroup, EdgeCondition } from '@/types/workflow'
import { Plus, Trash2 } from 'lucide-react'
import FieldAutocomplete from './FieldAutocomplete'

const OPERATORS: { value: EdgeCondition['operator']; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'not contains' },
  { value: 'in_array', label: 'in list' },
  { value: 'not_in_array', label: 'not in list' },
  { value: 'is_true', label: 'is true' },
  { value: 'is_false', label: 'is false' },
  { value: 'is_null', label: 'is null' },
  { value: 'is_not_null', label: 'is not null' },
  { value: 'exists', label: 'exists' },
  { value: 'not_exists', label: 'not exists' },
]

const VALUE_LESS_OPERATORS = new Set<EdgeCondition['operator']>(['exists', 'not_exists', 'is_true', 'is_false', 'is_null', 'is_not_null'])
const NUMERIC_OPERATORS = new Set<EdgeCondition['operator']>(['gt', 'gte', 'lt', 'lte'])
const EQUALITY_OPERATORS = new Set<EdgeCondition['operator']>(['eq', 'neq'])

// Coerce raw input to the right JS type for the given operator, so the engine's
// strict-equality (`===`) and numeric comparison operators behave correctly.
// Numeric operators (gt/gte/lt/lte) always store as number. Equality operators
// (eq/neq) auto-detect numeric strings and store as number; otherwise stay as
// string. Other operators (contains, in_array, …) stay raw.
function parseValueForOperator(raw: string, operator: EdgeCondition['operator']): unknown {
  if (raw === '') return ''
  if (NUMERIC_OPERATORS.has(operator)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (EQUALITY_OPERATORS.has(operator) && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
    return Number(raw)
  }
  return raw
}

interface Props {
  groups: ConditionGroup[]
  logic: 'AND' | 'OR'
  onChange: (groups: ConditionGroup[], logic: 'AND' | 'OR') => void
  fieldSuggestions?: string[]
}

export default function RuleBuilder({ groups, logic, onChange, fieldSuggestions = [] }: Props) {
  function addGroup() {
    onChange(
      [...groups, { conditions: [emptyCondition()], logic: 'AND' }],
      logic
    )
  }

  function removeGroup(gi: number) {
    onChange(groups.filter((_, i) => i !== gi), logic)
  }

  function updateGroup(gi: number, group: ConditionGroup) {
    const next = groups.map((g, i) => (i === gi ? group : g))
    onChange(next, logic)
  }

  function addCondition(gi: number) {
    const g = groups[gi]
    updateGroup(gi, { ...g, conditions: [...g.conditions, emptyCondition()] })
  }

  function removeCondition(gi: number, ci: number) {
    const g = groups[gi]
    const conditions = g.conditions.filter((_, i) => i !== ci)
    if (conditions.length === 0) {
      removeGroup(gi)
    } else {
      updateGroup(gi, { ...g, conditions })
    }
  }

  function updateCondition(gi: number, ci: number, c: EdgeCondition) {
    const g = groups[gi]
    const conditions = g.conditions.map((cond, i) => (i === ci ? c : cond))
    updateGroup(gi, { ...g, conditions })
  }

  return (
    <div className="space-y-3">
      {groups.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">Groups match:</span>
          {(['AND', 'OR'] as const).map((l) => (
            <button
              key={l}
              onClick={() => onChange(groups, l)}
              className={`rounded px-2 py-0.5 font-medium ${
                logic === l ? 'bg-gray-100 font-semibold text-graphite' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      )}

      {groups.map((group, gi) => (
        <div key={gi} className="rounded-lg border border-gray-200 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">Match:</span>
              {(['AND', 'OR'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => updateGroup(gi, { ...group, logic: l })}
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    group.logic === l ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
            {groups.length > 1 && (
              <button onClick={() => removeGroup(gi)} className="text-gray-300 hover:text-red-400">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            {group.conditions.map((cond, ci) => (
              <div key={ci} className="flex items-center gap-1.5">
                <FieldAutocomplete
                  wrapperClassName="min-w-0 flex-1"
                  className="rounded border border-gray-200 px-2 py-1 text-xs focus:border-p-blue-dark focus:outline-none"
                  placeholder="field.path"
                  value={cond.field}
                  onChange={(val) => updateCondition(gi, ci, { ...cond, field: val })}
                  suggestions={fieldSuggestions}
                />
                <select
                  className="shrink-0 rounded border border-gray-200 px-1.5 py-1 text-xs focus:border-p-blue-dark focus:outline-none"
                  value={cond.operator}
                  onChange={(e) => {
                    const nextOp = e.target.value as EdgeCondition['operator']
                    // Re-coerce the existing value for the new operator's semantics.
                    // Avoids stale string values surviving an op change to a numeric op.
                    const nextValue = cond.value !== undefined
                      ? parseValueForOperator(String(cond.value), nextOp)
                      : cond.value
                    updateCondition(gi, ci, { ...cond, operator: nextOp, value: nextValue })
                  }}
                >
                  {OPERATORS.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>
                {!VALUE_LESS_OPERATORS.has(cond.operator) && (
                  <input
                    className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-xs focus:border-p-blue-dark focus:outline-none"
                    placeholder="value"
                    value={cond.value !== undefined ? String(cond.value) : ''}
                    onChange={(e) =>
                      updateCondition(gi, ci, {
                        ...cond,
                        value: parseValueForOperator(e.target.value, cond.operator),
                      })
                    }
                  />
                )}
                <button
                  onClick={() => removeCondition(gi, ci)}
                  className="shrink-0 text-gray-300 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={() => addCondition(gi)}
            className="mt-2 flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
          >
            <Plus className="h-3 w-3" />
            Add condition
          </button>
        </div>
      ))}

      <button
        onClick={addGroup}
        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
      >
        <Plus className="h-3 w-3" />
        Add group
      </button>
    </div>
  )
}

function emptyCondition(): EdgeCondition {
  return { field: '', operator: 'eq', value: '' }
}
