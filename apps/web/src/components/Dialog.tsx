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
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

interface DialogBase {
  /** The question or the thing the dialog is about; the dialog's accessible name. */
  title: ReactNode
  /** The safe action. Escape, a click outside and a back gesture call it; it must never commit or destroy. */
  onDismiss: () => void
  /** The buttons, safe one first, so it is the one that has focus when the dialog opens. */
  actions: ReactNode
  /**
   * sm for a question, md for a short list, wide (600px) for the partners page
   * merge and leave dialogs, whose rows and three buttons sit on one line
   * (#2322), lg for a wider comparison.
   */
  size?: 'sm' | 'md' | 'wide' | 'lg'
  /**
   * A page's own class on the panel, beside the shell's, for a page whose
   * settled design draws its dialogs to its own geometry (the Connections
   * page's 20px titles, #2338 round 26). Never a second dialog: the shell's
   * semantics, focus and dismissal stay the same.
   */
  className?: string
  children?: ReactNode
}

/**
 * A warning (an answer that can destroy or discard something) is read to a
 * screen reader as an alert dialog, which is announced by its description, so
 * a warning must carry one; any other dialog may.
 */
export type DialogProps = DialogBase & (
  | { warning?: false; /** One sentence under the title, read as the dialog's description. */ description?: ReactNode }
  | { warning: true; /** What answering does, read as the alert dialog's description. */ description: ReactNode }
)

export function Dialog(props: DialogProps) {
  const { title, description, onDismiss, actions, warning = false, size = 'sm', className, children } = props
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  // What had focus before the dialog took it. Radix gives focus back to a
  // Dialog.Trigger, and these dialogs open from code rather than a trigger, so
  // the shell remembers the element itself and returns focus to it on close.
  // Read once the dialog is committed, never during a render React may repeat
  // or throw away; Radix moves focus in a later, passive effect.
  const returnFocusTo = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // Kept across strict mode's rerun of effects, by which time focus is inside the dialog.
    if (returnFocusTo.current === null) returnFocusTo.current = document.activeElement as HTMLElement | null
  }, [])

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
          className={`dialog dialog-${size} ${className ?? ''}`.trim()}
          onCloseAutoFocus={(e) => { e.preventDefault(); if (returnFocusTo.current?.isConnected) returnFocusTo.current.focus() }}
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
