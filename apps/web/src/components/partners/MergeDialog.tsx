'use client'

/**
 * The field level merge dialog (#2134, PM-3): the partners page's one conflict
 * surface (a guard fails on any other). It replaces the 409 side by side, whose
 * Take theirs discarded every edit.
 *
 * As the settled design draws it (#2322, PM-19): what only you changed and what
 * only they changed, each with its value before and after and what happens to
 * it (kept, added), then what you both changed, one line each, yours then
 * theirs, with Keep yours chosen to start so Save both is ready. A combination
 * the save would refuse is never chosen for the person, and Save both waits on
 * it. Closing (Keep editing, Escape, a click outside, a back gesture) saves
 * nothing and keeps every answer given.
 */
import { useId } from 'react'
import { Dialog } from '@/components/Dialog'
import { Button, ChoiceGroup, FieldError } from '@/components/ui/form'
import { PROFILE_PREFIX } from '@/app/(app)/partners/partner-draft'
import { unansweredCount, type MergeChange, type MergeConflict, type MergeResult, type MergeSide } from '@/lib/partner-page-merge'
import { formatDollars, formatProfileValue } from './buyer-profile/labels'
import { formatTime } from '@/components/ui/date-time'

type Rows = Array<Record<string, unknown>>

/** A row group's side as its rows: anything that is not a list of rows reads as none, so the dialog always renders. */
const rowsOf = (value: unknown): Rows => (Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object') : [])

/** A merge value in the words the page shows it in. */
export function describeMergeValue(key: string, value: unknown): string {
  if (key.startsWith(`${PROFILE_PREFIX}windows@`)) {
    const rows = rowsOf(value)
    return rows.length === 0 ? 'closed' : rows.map((w) => `${formatTime(Number(w.opens_minute))} to ${formatTime(Number(w.closes_minute))}`).join(', ')
  }
  if (key.startsWith(`${PROFILE_PREFIX}tiers@`)) {
    const rows = rowsOf(value)
    return rows.length === 0 ? 'no pricing' : rows.map((t) => `from ${formatDollars(Number(t.debt_from))}${t.debt_to === null ? '' : ` to ${formatDollars(Number(t.debt_to))}`} at ${Number(t.multiplier)}`).join('; ')
  }
  if (key === `${PROFILE_PREFIX}blackout_dates`) {
    const rows = rowsOf(value)
    return rows.length === 0 ? 'none' : rows.map((b) => (b.note ? `${String(b.date)} (${String(b.note)})` : String(b.date))).join(', ')
  }
  if (key === `${PROFILE_PREFIX}click_delivery.routes`) {
    const rows = rowsOf(value)
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

/** The other editor's first name, as the design says it ("Brian's"), or null when no editor is on record. */
function firstName(theirName: string | null): string | null {
  const first = theirName?.trim().split(/\s+/)[0]
  return first ? first : null
}

/** A change only one side made: the field, its value before and after, and what happens to it. */
function ChangeRow({ change, outcome }: { change: MergeChange; outcome: 'kept' | 'added' }) {
  return (
    <div data-merge-change={change.key} className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-baseline gap-2.5 text-[13px]">
      <span className="text-graphite">{change.label}</span>
      <span className="break-words text-graphite">{describeMergeValue(change.key, change.from)} {'\u2192'} {describeMergeValue(change.key, change.to)}</span>
      <span className="text-xs text-hint">{outcome}</span>
    </div>
  )
}

function ConflictRow({ conflict, theirs, onChoose }: { conflict: MergeConflict; theirs: string; onChoose: (key: string, side: MergeSide) => void }) {
  const id = useId()
  const options: ReadonlyArray<{ value: MergeSide; label: string }> = [
    { value: 'mine', label: 'Keep yours' },
    { value: 'theirs', label: `Use ${theirs}` },
  ]
  return (
    // One question per row: the radio group is its named control (ChoiceGroup),
    // described by the two values beside it and any reason.
    <div data-merge-key={conflict.key} className="space-y-1">
      <div className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-2.5 text-[13px]">
        <span className="text-graphite">{conflict.label}</span>
        <span id={`${id}-values`} className="break-words text-graphite">yours {describeMergeValue(conflict.key, conflict.mine)}, {theirs} {describeMergeValue(conflict.key, conflict.theirs)}</span>
        <span className="merge-choice">
          <ChoiceGroup id={id} label={conflict.label} visibleLabel="" value={conflict.choice} options={options} onChange={(side) => onChoose(conflict.key, side)} describedBy={[`${id}-values`, conflict.reason ? `${id}-reason` : null].filter(Boolean).join(' ')} />
        </span>
      </div>
      {conflict.reason && <FieldError id={`${id}-reason`} size="xs">These cannot be saved together: {conflict.reason}</FieldError>}
    </div>
  )
}

/** One of the dialog's three groups, with the rule above it the design draws. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 border-t border-line-soft py-2">
      <h3 className="text-xs font-semibold text-gray-600">{title}</h3>
      {children}
    </section>
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
  const first = firstName(theirName)
  const theirs = first ? `${first}'s` : 'theirs'
  const conflicts = result.conflicts.flatMap((section) => section.conflicts)
  return (
    <Dialog
      size="wide"
      title={`${who} saved this partner while you were editing`}
      description={`Nothing is lost. Saving keeps your changes and adds ${theirs}. Only where you both changed the same field do you choose.`}
      onDismiss={onKeepEditing}
      actions={
        <>
          <Button variant="secondary" onClick={onKeepEditing}>Keep editing</Button>
          <Button variant="primary" onClick={onSave} disabled={left > 0}>Save both</Button>
        </>
      }
    >
      <div>
        {result.mineKept.length > 0 && (
          <Group title="Only you changed">{result.mineKept.map((c) => <ChangeRow key={c.key} change={c} outcome="kept" />)}</Group>
        )}
        {result.autoTaken.length > 0 && (
          <Group title={`Only ${first ?? 'they'} changed`}>{result.autoTaken.map((c) => <ChangeRow key={c.key} change={c} outcome="added" />)}</Group>
        )}
        {conflicts.length > 0 && (
          <Group title="You both changed">{conflicts.map((c) => <ConflictRow key={c.key} conflict={c} theirs={theirs} onChoose={onChoose} />)}</Group>
        )}
        {left > 0 && <p role="status" className="pt-2 text-xs text-gray-600">Choose for {left} more {left === 1 ? 'field' : 'fields'}.</p>}
      </div>
    </Dialog>
  )
}
