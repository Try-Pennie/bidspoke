'use client'

/**
 * The lead validation step's settings (#2590), as Dan settled them on
 * 2026-10-21 in docs/design/lead-validation-node.html:
 *
 * - D12: the lead id field first, saying what the value is for.
 * - D1, D2, D3: the checks as a short numbered list under "Checks, in order",
 *   each row the check's name and the short form of its condition, the chosen
 *   row marked in navy; the chosen check edited in one editor below.
 * - D8: "Add check" between the list and the editor.
 * - D4, D5, D6: the editor's first line says "Check N of M" and holds the name
 *   box, Move up, Move down and Remove check.
 * - D7: the condition is the existing rule builder, as Branch draws it.
 * - D13: the reason is picked from LEAD_REJECTION_REASONS, never typed.
 * - D14: what a lead missing a value does, in the settled words.
 *
 * Advanced (D15) is ConfigPanel's own section, collapsed for this step there.
 * The list edits are the pure ones in lib/lead-validation-checks.ts.
 */
import { useId, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import RuleBuilder from '@/components/rule-builder/RuleBuilder'
import { Button, Field, TextInput } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import type { ConditionGroup } from '@/types/workflow'
import {
  LEAD_REJECTION_REASONS,
  LEAD_VALIDATION_ON_MISSING,
  LEAD_VALIDATION_ON_MISSING_LABELS,
  leadValidationCheckSummary,
} from '@bidspoke/workflow-definition'
import { addCheck, chosenIndex, moveCheck, removeCheck, type ChecksEdit } from '@/lib/lead-validation-checks'

const REASON_OPTIONS = LEAD_REJECTION_REASONS.map((r) => ({ value: r, label: r }))
const MISSING_OPTIONS = LEAD_VALIDATION_ON_MISSING.map((v) => ({ value: v, label: LEAD_VALIDATION_ON_MISSING_LABELS[v] }))

type Check = Record<string, unknown>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

function conditionOf(check: Check): { groups: ConditionGroup[]; logic: 'AND' | 'OR' } {
  const c = isRecord(check.condition) ? check.condition : {}
  return {
    groups: Array.isArray(c.groups) ? (c.groups as ConditionGroup[]) : [],
    logic: c.logic === 'OR' ? 'OR' : 'AND',
  }
}

export default function LeadValidationConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const id = useId()
  // A stored entry that is not a record is drawn as an empty check, never dropped:
  // a write from this panel carries every entry it read.
  const checks: Check[] = Array.isArray(config.checks) ? config.checks.map((c: unknown) => (isRecord(c) ? c : {})) : []
  const [picked, setPicked] = useState(0)
  const chosen = chosenIndex(picked, checks.length)
  const check = checks[chosen] as Check | undefined

  function apply(edit: ChecksEdit) {
    onChange({ checks: edit.checks })
    setPicked(edit.chosen)
  }
  function updateChosen(patch: Check) {
    onChange({ checks: checks.map((c, i) => (i === chosen ? { ...c, ...patch } : c)) })
  }

  const headingId = `${id}-checks`
  const editorLabelId = `${id}-editor`
  const leadId = `${id}-lead-id`

  return (
    <>
      <Field id={leadId} label="Lead id field" hint="Sent back as lead_id when a lead is rejected.">
        <TextInput
          id={leadId}
          value={text(config.lead_id_field)}
          onChange={(v) => onChange({ lead_id_field: v })}
          placeholder="trigger.payload.leadUuid"
          describedBy={`${leadId}-hint`}
        />
      </Field>

      <section className="space-y-3">
        <h3 id={headingId} className="text-xs font-medium uppercase tracking-wide text-gray-500">Checks, in order</h3>
        {checks.length > 0 ? (
          <ol aria-labelledby={headingId} className="overflow-hidden rounded-lg border border-gray-200">
            {checks.map((c, i) => {
              const selected = i === chosen
              const name = text(c.label).trim()
              const summary = leadValidationCheckSummary(c)
              return (
                <li key={typeof c.id === 'string' && c.id ? c.id : `row-${i}`} className={i > 0 ? 'border-t border-gray-100' : ''}>
                  <button
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => setPicked(i)}
                    className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-xs ${
                      selected ? 'border-l-navy bg-gray-50 font-medium text-navy' : 'border-l-transparent text-gray-800 hover:bg-gray-50'
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                        selected ? 'bg-navy text-white' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className={`min-w-0 flex-1 truncate ${name ? '' : 'font-normal text-hint'}`}>{name || 'Unnamed check'}</span>
                    <span className="min-w-0 max-w-[55%] shrink truncate font-normal text-hint">{summary ?? 'no condition yet'}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="text-xs text-hint">No checks yet.</p>
        )}

        <Button variant="ghost" onClick={() => apply(addCheck(checks))}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          Add check
        </Button>

        {check && (
          <div role="group" aria-labelledby={editorLabelId} className="space-y-3 rounded-lg border border-gray-200 p-3">
            <div className="flex items-center gap-2">
              <span id={editorLabelId} className="shrink-0 text-xs text-hint">
                Check {chosen + 1} of {checks.length}
              </span>
              <TextInput
                id={`${id}-name`}
                aria-label="Check name"
                value={text(check.label)}
                onChange={(v) => updateChosen({ label: v })}
                placeholder="Check name"
                className="min-w-0 flex-1"
              />
              <div className="flex shrink-0 items-center gap-0.5">
                <Button variant="remove" aria-label="Move up" title="Move up" disabled={chosen === 0} onClick={() => apply(moveCheck(checks, chosen, -1))}>
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="remove"
                  aria-label="Move down"
                  title="Move down"
                  disabled={chosen === checks.length - 1}
                  onClick={() => apply(moveCheck(checks, chosen, 1))}
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button variant="remove" aria-label="Remove check" title="Remove check" onClick={() => apply(removeCheck(checks, chosen))}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <RuleBuilder
              groups={conditionOf(check).groups}
              logic={conditionOf(check).logic}
              fieldSuggestions={refs}
              onChange={(groups, logic) => updateChosen({ condition: { groups, logic } })}
            />

            <div className="grid grid-cols-2 gap-2">
              <Field id={`${id}-reason`} label="Rejects with">
                <Select
                  id={`${id}-reason`}
                  value={text(check.reason)}
                  onChange={(v) => updateChosen({ reason: v })}
                  options={REASON_OPTIONS}
                  placeholder="Choose a reason"
                />
              </Field>
              <Field id={`${id}-missing`} label="If the lead has no value">
                <Select
                  id={`${id}-missing`}
                  value={text(check.on_missing)}
                  onChange={(v) => updateChosen({ on_missing: v })}
                  options={MISSING_OPTIONS}
                  placeholder="Choose what happens"
                />
              </Field>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
