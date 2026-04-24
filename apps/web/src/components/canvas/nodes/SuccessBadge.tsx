import { Trophy } from 'lucide-react'

/**
 * Badge rendered in the top-right corner of a node whose namespace is in
 * the trigger's success_node_namespaces. Parent must be `relative`.
 */
export function SuccessBadge({ visible }: { visible: boolean | undefined }) {
  if (!visible) return null
  return (
    <div
      title="Success node — runs that end here are marked Successful"
      className="absolute -top-2 -right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-green-300 bg-green-50 text-green-600 shadow-sm"
    >
      <Trophy className="h-3 w-3" />
    </div>
  )
}
