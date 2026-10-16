'use client'

/**
 * Leaving a partner with something unsaved (#2138, PM-5): the page's own
 * dialog, on the one Dialog shell, in place of the browser's confirm. It names
 * the change and where the person was going: Keep editing, Discard and open it,
 * Save and open it. Escape, a click outside and a back gesture are Keep
 * editing; only a press on Discard discards. While a save is not yet
 * confirmed, Discard waits for it, saying why.
 */
import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui/form'
import type { LeaveDestination } from '@/lib/leave-guard'
import type { MergeUnit } from '@/lib/partner-page-merge'
import { leaveActionWords, leaveDescription, leaveTitle } from '@/app/(app)/partners/save-bar-text'

export function LeaveDialog({ who, units, unconfirmed, destination, onKeepEditing, onDiscard, onSave }: {
  /** The partner being left, as named on screen. */
  who: string
  /** What is unsaved, named by the registry. */
  units: readonly MergeUnit[]
  /** A save whose outcome is not known yet: Discard waits for it. */
  unconfirmed: boolean
  destination: LeaveDestination
  onKeepEditing: () => void
  onDiscard: () => void
  onSave: () => void
}) {
  const words = leaveActionWords(destination)
  return (
    <Dialog
      warning
      // Wide enough for its three answers on one line, as the settled design draws it (540px there).
      size="md"
      title={leaveTitle(who, units, unconfirmed)}
      description={leaveDescription(units, unconfirmed)}
      onDismiss={onKeepEditing}
      actions={
        <>
          <Button variant="secondary" onClick={onKeepEditing}>Keep editing</Button>
          <Button variant="secondary" onClick={onDiscard} disabled={unconfirmed}>{words.discard}</Button>
          <Button variant="primary" onClick={onSave}>{words.save}</Button>
        </>
      }
    />
  )
}
