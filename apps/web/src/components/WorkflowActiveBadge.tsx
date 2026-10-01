// Whether a workflow takes traffic, shown the same way on the Workflows list and
// in the canvas header (#1706). New and duplicated workflows start inactive, and
// creating one opens the canvas, so the canvas has to say so too.
export default function WorkflowActiveBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      title={isActive ? undefined : 'Takes no traffic until it is enabled from the Workflows list'}
      className={`inline-flex flex-shrink-0 items-center rounded px-2 py-0.5 text-xs font-medium ${
        isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
      }`}
    >
      {isActive ? 'Active' : 'Inactive'}
    </span>
  )
}
