'use client'

/**
 * The Delete / Cancel pair shown while an inline delete awaits confirmation
 * (#546). Pairs with useInlineDeleteConfirm.
 *
 * It floats over the row's overflow button, which stays in the DOM but invisible
 * so the cell does not change size when the confirm appears.
 *
 * The buttons carry no aria-label on purpose. Their accessible name is their
 * visible text, and only one confirm is ever open at a time (the hook holds a
 * single id), so "Delete" is already unambiguous. An aria-label here would
 * override the visible text and put the two out of step.
 */
export function InlineDeleteConfirm({
  onDelete,
  onCancel,
  offset = 'right-0',
  className = '',
}: {
  onDelete: () => void
  onCancel: () => void
  /**
   * Horizontal offset class. A real prop rather than an appended class, because
   * two `right-*` utilities on one element are decided by CSS order rather than
   * by which was listed last, so an override could silently lose.
   */
  offset?: string
  /** Extra classes on the floating container. The folder rows sit on a tinted
   *  background and add their own backing so the buttons stay readable. */
  className?: string
}) {
  return (
    <div className={`absolute ${offset} top-1/2 -translate-y-1/2 flex items-center gap-1.5 whitespace-nowrap ${className}`.trim()}>
      <button
        onClick={onDelete}
        className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark"
      >
        Delete
      </button>
      <button
        onClick={onCancel}
        className="text-xs text-gray-500 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark"
      >
        Cancel
      </button>
    </div>
  )
}
