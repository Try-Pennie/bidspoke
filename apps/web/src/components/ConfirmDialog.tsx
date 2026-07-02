'use client'

import { useId } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'

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
 * Generic confirm/cancel modal for one-click actions that shouldn't fire without
 * an explicit yes (#492). Reuses useFocusTrap for focus containment + Escape.
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
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onCancel)
  const titleId = useId()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[440px] max-w-full rounded-lg bg-white shadow-xl"
      >
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-graphite">
            {title}
          </h2>
        </div>
        <div className="px-5 py-4 text-sm text-gray-700">{body}</div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={
              destructive
                ? 'rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700'
                : 'rounded bg-p-blue-dark px-3 py-1.5 text-sm font-medium text-white hover:bg-[#155E99]'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
