'use client'

/**
 * The field level merge dialog (#2134, PM-3): the partners page's one conflict
 * surface (a guard fails on any other). It replaces the 409 side by side, whose
 * Take theirs discarded every edit.
 *
 * Only a field or row group both people changed asks a question, grouped by
 * section, with Keep yours or Use theirs and the value as it was, yours and
 * theirs. Everything only one of them changed is named, kept with no question.
 * Save both waits for every answer; closing (Keep editing, Escape, a click
 * outside, a back gesture) saves nothing and keeps every answer given.
 */
import { useId } from 'react'
import { Dialog } from '@/components/Dialog'
import { Button, ChoiceGroup } from '@/components/ui/form'
import { PROFILE_PREFIX } from '@/app/(app)/partners/partner-draft'
import { unansweredCount, type MergeConflict, type MergeResult, type MergeSide, type MergeUnit } from '@/lib/partner-page-merge'
import { formatDollars, formatProfileValue, minutesToTime } from './buyer-profile/labels'

const CHOICES: ReadonlyArray<{ value: MergeSide; label: string }> = [
  { value: 'mine', label: 'Keep yours' },
  { value: 'theirs', label: 'Use theirs' },
]

type Rows = Array<Record<string, unknown>>

/** A merge value in the words the page shows it in. */
export function describeMergeValue(key: string, value: unknown): string {
  if (key.startsWith(`${PROFILE_PREFIX}windows@`)) {
    const rows = value as Rows
    return rows.length === 0 ? 'closed' : rows.map((w) => `${minutesToTime(Number(w.opens_minute))} to ${minutesToTime(Number(w.closes_minute))}`).join(', ')
  }
  if (key.startsWith(`${PROFILE_PREFIX}tiers@`)) {
    const rows = value as Rows
    return rows.length === 0 ? 'no pricing' : rows.map((t) => `from ${formatDollars(Number(t.debt_from))}${t.debt_to === null ? '' : ` to ${formatDollars(Number(t.debt_to))}`} at ${Number(t.multiplier)}`).join('; ')
  }
  if (key === `${PROFILE_PREFIX}blackout_dates`) {
    const rows = value as Rows
    return rows.length === 0 ? 'none' : rows.map((b) => (b.note ? `${String(b.date)} (${String(b.note)})` : String(b.date))).join(', ')
  }
  if (key === `${PROFILE_PREFIX}click_delivery.routes`) {
    const rows = value as Rows
    return rows.length === 0 ? 'no routes' : rows.map((r) => {
      const states = Array.isArray(r.states) && r.states.length > 0 ? (r.states as string[]).join(', ') : 'every other state'
      return `${String(r.name)}: ${String(r.url)} for ${states}`
    }).join('; ')
  }
  if (key.startsWith(PROFILE_PREFIX)) return formatProfileValue(key.slice(PROFILE_PREFIX.length), value)
  if (value === null || value === undefined || value === '') return 'none'
  if (typeof value === 'boolean') return key === 'is_active' ? (value ? 'Active' : 'Inactive') : value ? 'on' : 'off'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

const list = (units: MergeUnit[]): string => {
  const names = units.map((u) => u.label)
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The label under its section heading, without saying the heading again (L605): Hours, Monday under Hours is Monday. */
function visibleLabel(c: MergeConflict): string {
  if (c.label === c.section) return ''
  return c.label.startsWith(`${c.section}, `) ? c.label.slice(c.section.length + 2) : c.label
}

function ConflictRow({ conflict, onChoose }: { conflict: MergeConflict; onChoose: (key: string, side: MergeSide) => void }) {
  const id = useId()
  const lines: Array<[string, unknown]> = [['Was', conflict.base], ['Yours', conflict.mine], ['Theirs', conflict.theirs]]
  return (
    // One question per row: the radio group is its named control (ChoiceGroup),
    // described by the values beside it and any reason, so a screen reader hears
    // them with the choice and no second group repeats its name.
    <div data-merge-key={conflict.key} className="space-y-1.5 border-t border-gray-100 py-3 first:border-t-0">
      <ChoiceGroup id={id} label={conflict.label} visibleLabel={visibleLabel(conflict)} value={conflict.choice} options={CHOICES} onChange={(side) => onChoose(conflict.key, side)} describedBy={[`${id}-values`, conflict.reason ? `${id}-reason` : null].filter(Boolean).join(' ')} />
      <div id={`${id}-values`} className="grid gap-0.5 text-sm">
        {lines.map(([word, value]) => (
          <p key={word} className="grid grid-cols-[3.5rem_1fr] items-baseline"><span className="text-xs font-medium text-gray-600">{word}</span> <span className="break-words">{describeMergeValue(conflict.key, value)}</span></p>
        ))}
      </div>
      {conflict.reason && <p id={`${id}-reason`} className="text-xs text-red-700">These cannot be saved together: {conflict.reason}</p>}
    </div>
  )
}

export function MergeDialog({ result, theirName, onChoose, onSave, onKeepEditing }: {
  result: MergeResult
  /** Who saved first, or null when no editor is on record. */
  theirName: string | null
  onChoose: (key: string, side: MergeSide) => void
  onSave: () => void
  /** Closes the dialog; the save it starts shows its progress beside the page's Save button. */
  onKeepEditing: () => void
}) {
  const left = unansweredCount(result)
  const who = theirName ?? 'Someone else'
  return (
    <Dialog
      size="lg"
      title={`${who} saved this partner while you were editing`}
      description="Nothing is saved yet. Saving keeps your changes and adds theirs. Only where you both changed the same field do you choose."
      onDismiss={onKeepEditing}
      actions={
        <>
          <Button variant="secondary" onClick={onKeepEditing}>Keep editing</Button>
          <Button variant="primary" onClick={onSave} disabled={left > 0}>Save both</Button>
        </>
      }
    >
      <div className="space-y-4">
        {result.conflicts.map((section) => (
          <section key={section.section} aria-label={section.section}>
            <h3 className="text-xs font-semibold text-gray-600">{section.section}</h3>
            {section.conflicts.map((c) => <ConflictRow key={c.key} conflict={c} onChoose={onChoose} />)}
          </section>
        ))}
        {(result.mineKept.length > 0 || result.autoTaken.length > 0) && (
          <div className="space-y-0.5 border-t border-gray-100 pt-3 text-sm text-gray-700">
            {result.mineKept.length > 0 && <p>Your {result.mineKept.length === 1 ? 'change' : 'changes'} to {list(result.mineKept)} {result.mineKept.length === 1 ? 'is' : 'are'} kept.</p>}
            {result.autoTaken.length > 0 && <p>Their {result.autoTaken.length === 1 ? 'change' : 'changes'} to {list(result.autoTaken)} {result.autoTaken.length === 1 ? 'is' : 'are'} added.</p>}
          </div>
        )}
        <p role="status" className="text-xs text-gray-600">
          {left > 0 ? `Choose for ${left} more ${left === 1 ? 'field' : 'fields'}.` : 'Every field is chosen.'}
        </p>
      </div>
    </Dialog>
  )
}
