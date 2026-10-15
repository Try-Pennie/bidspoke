'use client'

/**
 * The one Dialog shell of the app (#2134, L613). Every dialog in apps/web is
 * built on it, and a guard (lib/__guards__/dialog-shell-guard.test.ts) fails on
 * any other dialog markup, focus trap or import of the primitive underneath.
 *
 * Built on @radix-ui/react-dialog (Dan, 2026-10-15: Radix is the base for the
 * app's design system controls), which supplies what a hand rolled overlay had
 * to remember: focus moved in, held in and given back; the rest of the page
 * hidden from a screen reader and inert to the pointer; scrolling behind the
 * dialog locked; and the dialog rendered at the end of the body, above every
 * stacking context. Callers never import Radix: this component is the API.
 *
 * Dismissal (L628) is part of the contract. Escape, a click outside and a back
 * gesture are incidental: each calls `onDismiss`, the dialog's declared safe
 * action, which is required and has no default, so no incidental gesture can
 * ever commit, discard or delete. The page cannot scroll behind an open dialog,
 * so a scroll never dismisses it either.
 *
 * Mounted means open: a caller renders the dialog when it should show and stops
 * rendering it to close it.
 */
import * as RadixDialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface DialogProps {
  /** The question or the thing the dialog is about; the dialog's accessible name. */
  title: ReactNode
  /** One sentence under the title, read as the dialog's description. */
  description?: ReactNode
  /** The safe action. Escape, a click outside and a back gesture call it; it must never commit or destroy. */
  onDismiss: () => void
  /** The buttons, safe one first, so it is the one that has focus when the dialog opens. */
  actions: ReactNode
  /** A warning whose answer can destroy or discard something: read to a screen reader as an alert dialog. */
  warning?: boolean
  /** sm for a question, md for a short list, lg for a comparison such as the merge dialog. */
  size?: 'sm' | 'md' | 'lg'
  children?: ReactNode
}

export function Dialog({ title, description, onDismiss, actions, warning = false, size = 'sm', children }: DialogProps) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  // What had focus before the dialog took it. Radix gives focus back to a
  // Dialog.Trigger, and these dialogs open from code rather than a trigger, so
  // the shell remembers the element itself and returns focus to it on close.
  const [returnFocusTo] = useState<HTMLElement | null>(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)))

  // A back gesture is incidental too: it lands on the safe action, and the
  // navigation it makes goes ahead.
  useEffect(() => {
    const onPop = () => onDismissRef.current()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onDismissRef.current() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content
          role={warning ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          className={`dialog dialog-${size}`}
          onCloseAutoFocus={(e) => { e.preventDefault(); if (returnFocusTo?.isConnected) returnFocusTo.focus() }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="dialog-description">{description}</RadixDialog.Description>}
          {children && <div className="dialog-body">{children}</div>}
          <div className="dialog-actions">{actions}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
