import { MessageSquare } from 'lucide-react'

/**
 * Badge rendered in the top-left corner of a node when `data.note` is set.
 * Hover shows a tooltip with the note text. Parent must be `relative`.
 */
export function NoteBadge({ note }: { note: string | undefined }) {
  if (!note) return null
  return (
    <div
      title={note}
      className="absolute -top-2 -left-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-600 shadow-sm"
    >
      <MessageSquare className="h-3 w-3" />
    </div>
  )
}
