'use client'

/**
 * The partners page save bar (#2138, PM-4), as the settled design draws it: a
 * dark bar across the foot of the form pane, there only while something is
 * edited, saving, unconfirmed, just saved or refused. The bar changes in place
 * through each state, and every time it prints goes through dates.ts.
 *
 * Saving shows the seconds counting. A save with no answer is unconfirmed,
 * never failed (L766): Try again saves what is on screen (the same press, under
 * the same save id, when nothing changed since). Discard waits while the save
 * is still being checked, and is open again once checking stops after two
 * minutes (L665). A failure stays until the person acts on it.
 */
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/form'
import { UNCONFIRMED, UNCONFIRMED_DISCARD_GAVE_UP, UNCONFIRMED_DISCARD_REASON, UNCONFIRMED_GAVE_UP } from '@/app/(app)/partners/save-bar-text'

export type SaveBarState =
  /**
   * Something is edited: named, with Discard changes and Save changes. `note`
   * is a second line, such as another person's live save of fields being
   * edited, which Save will ask about (#2135).
   */
  | { kind: 'dirty'; message: string; note?: string | null }
  /** A new partner, not created yet: Cancel and Create partner. */
  | { kind: 'new'; canCreate: boolean }
  /** Saving (or undoing, or creating): the seconds counting. */
  | { kind: 'working'; label: string; elapsed: string }
  /** The save's answer was lost: checking, then after two minutes, said plainly. */
  | { kind: 'unconfirmed'; gaveUp: boolean }
  /** Saved, undone, or nothing to save: Undo while it is offered, and a stored copy warning beside it. */
  | { kind: 'done'; message: string; undoSeconds: number | null; copyWarning: string | null }
  /**
   * Not saved, saying why. `retry` names the button that saves again (none for
   * a refused Undo with nothing on screen to save); Show me opens the refused
   * field; a held 401 links to signing in again in a new tab.
   */
  | { kind: 'failed'; message: string; retry: 'Try again' | 'Save changes' | null; canDiscard: boolean; showMe: { label: string } | null; signIn: boolean }

export interface SaveBarProps {
  state: SaveBarState
  /** The form the Save and Create buttons submit, so Enter in a field still saves. */
  formId: string
  onDiscard: () => void
  onCancel: () => void
  onTryAgain: () => void
  onUndo: () => void
  onShowMe: () => void
}

export function SaveBar({ state, formId, onDiscard, onCancel, onTryAgain, onUndo, onShowMe }: SaveBarProps) {
  if (state.kind === 'new') {
    return (
      <div className="save-bar" data-save-bar="">
        <p className="save-bar-message">New partner, not created yet</p>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} disabled={!state.canCreate}>Create partner</Button>
      </div>
    )
  }
  if (state.kind === 'dirty') {
    return (
      <div className="save-bar" data-save-bar="">
        <div className="save-bar-message flex-col items-start">
          <p>{state.message}</p>
          {state.note && <p role="status" className="save-bar-note">{state.note}</p>}
        </div>
        <Button variant="secondary" onClick={onDiscard}>Discard changes</Button>
        <Button variant="primary" type="submit" form={formId}>Save changes</Button>
      </div>
    )
  }
  if (state.kind === 'working') {
    return (
      <div className="save-bar" data-save-bar="">
        <p role="status" className="save-bar-message">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {state.label}, {state.elapsed}
        </p>
      </div>
    )
  }
  if (state.kind === 'unconfirmed') {
    return (
      <div className="save-bar" data-save-bar="">
        <div className="save-bar-message flex-col items-start">
          <p role="status">{state.gaveUp ? UNCONFIRMED_GAVE_UP : UNCONFIRMED}</p>
          <p id="save-bar-discard-reason" className="save-bar-note">{state.gaveUp ? UNCONFIRMED_DISCARD_GAVE_UP : UNCONFIRMED_DISCARD_REASON}</p>
        </div>
        {/* Discard waits while the save is checked; once checking stops it is open again (L665). */}
        <Button variant="secondary" disabled={!state.gaveUp} onClick={onDiscard} describedBy="save-bar-discard-reason">Discard changes</Button>
        <Button variant="primary" onClick={onTryAgain}>Try again</Button>
      </div>
    )
  }
  if (state.kind === 'done') {
    return (
      <div className="save-bar" data-save-bar="">
        <div className="save-bar-message flex-col items-start">
          <p role="status">{state.message}</p>
          {/* Saved, but a stored copy could not be refreshed (#1846): beside Saved in its shared words, never as an error. */}
          {state.copyWarning && <p role="status" className="save-bar-note">{state.copyWarning}</p>}
        </div>
        {state.undoSeconds !== null && <Button variant="secondary" onClick={onUndo}>Undo, {state.undoSeconds}</Button>}
      </div>
    )
  }
  return (
    <div className="save-bar save-bar-failed" data-save-bar="">
      <p role="alert" className="save-bar-message">
        <span>
          {state.message}
          {state.signIn && <> <a href="/login" target="_blank" rel="noopener noreferrer">Sign in again</a></>}
        </span>
      </p>
      {state.showMe && <Button variant="secondary" onClick={onShowMe} aria-label={`Show me: the ${state.showMe.label} tab`}>Show me</Button>}
      {state.canDiscard && <Button variant="secondary" onClick={onDiscard}>Discard changes</Button>}
      {state.retry && <Button variant="primary" onClick={onTryAgain}>{state.retry}</Button>}
    </div>
  )
}
