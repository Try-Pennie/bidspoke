import { SlidersHorizontal } from 'lucide-react'

const GENERIC = 'Open the node and fill in its required fields.'

/**
 * Badge in the bottom-right corner of a node that is attached but not
 * configured: a code node with no script, a branch arm with no conditions (#563).
 *
 * The pulsing glow alone can't say this: it's `aria-hidden` and
 * `pointer-events-none` (so it never eats a click on the node), which leaves it
 * unable to carry a tooltip, and until now the unconfigured case had no badge at
 * all, only the timeout case did. A user dragged in an empty Code node, saw it
 * pulse, opened it, and reasonably read the prominent Timeout section as the
 * problem. Now the reason is on the node itself.
 *
 * Sits opposite the TimeoutWarningBadge (bottom-left) so a node with both
 * problems shows both, and the icon is deliberately not that badge's alert
 * triangle. Parent must be `relative`.
 */
export function ConfigWarningBadge({ hasError, message }: { hasError?: boolean; message?: string }) {
  if (!hasError) return null
  const title = `Not configured: ${message ? `${message}. ` : ''}${GENERIC}`
  return (
    <div
      role="img"
      aria-label={title}
      title={title}
      className="absolute -bottom-2 -right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-600 shadow-sm"
    >
      <SlidersHorizontal className="h-3 w-3" />
    </div>
  )
}
