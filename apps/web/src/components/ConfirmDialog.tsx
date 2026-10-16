'use client'

import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui/form'

interface Props {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A yes or no question for a one click action that should not fire without an
 * explicit yes (#492), on the app's one Dialog shell (#2134): Cancel is the safe
 * action every incidental dismissal lands on.
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      title={title}
      description={body}
      onDismiss={onCancel}
      warning={destructive}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={destructive ? 'destructive' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    />
  )
}
