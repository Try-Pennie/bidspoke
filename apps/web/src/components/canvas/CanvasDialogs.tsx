'use client'

/**
 * The canvas's dialogs, on the one Dialog shell (#2134). Their own components
 * because WorkflowCanvas cannot be mounted in jsdom (#737); the canvas only
 * decides when each shows.
 */
import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui/form'

/** Deleting a parallel or branch container that has nodes inside it (#288). */
export function ContainerDeleteDialog({ containerLabel, innerCount, onCancel, onLeaveThem, onDeleteInside }: {
  containerLabel: string
  innerCount: number
  onCancel: () => void
  onLeaveThem: () => void
  onDeleteInside: () => void
}) {
  const nodes = innerCount === 1 ? '1 node sits' : `${innerCount} nodes sit`
  return (
    <Dialog
      warning
      title={`Delete ${containerLabel}?`}
      description={`${nodes} inside this container. Should they be deleted with it, or left disconnected on the canvas?`}
      onDismiss={onCancel}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="secondary" onClick={onLeaveThem}>Leave them</Button>
          <Button variant="destructive" onClick={onDeleteInside}>Delete inside too</Button>
        </>
      }
    />
  )
}

/**
 * Leaving a canvas with unsaved edits by an in app link (#478). It was the
 * browser's own confirm; this is the page's own dialog, whose safe action is
 * Keep editing. A refresh or a closed tab still gets the browser's leave
 * warning, because browsers allow no page dialog there.
 */
export function LeaveCanvasDialog({ workflowName, onKeepEditing, onDiscard }: {
  workflowName: string
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  const name = workflowName.trim() || 'this workflow'
  return (
    <Dialog
      warning
      title={`Leave ${name} with unsaved changes?`}
      description="Your changes to this workflow are not saved. Leaving discards them."
      onDismiss={onKeepEditing}
      actions={
        <>
          <Button variant="secondary" onClick={onKeepEditing}>Keep editing</Button>
          <Button variant="destructive" onClick={onDiscard}>Discard and leave</Button>
        </>
      }
    />
  )
}
