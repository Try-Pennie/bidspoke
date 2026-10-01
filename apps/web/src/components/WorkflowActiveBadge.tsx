// Whether a workflow takes traffic, shown the same way on the Workflows list and
// in the canvas header (#1706). New and duplicated workflows start inactive, and
// creating one opens the canvas, so the canvas has to say so too.
const INACTIVE_MEANING = 'Takes no traffic until it is enabled from the Workflows list'

export default function WorkflowActiveBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      title={isActive ? undefined : INACTIVE_MEANING}
      // gray-700 on gray-100 is 9.37:1; gray-500 was 4.39:1, under the 4.5:1 small text needs.
      className={`inline-flex flex-shrink-0 items-center rounded px-2 py-0.5 text-xs font-medium ${
        isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-700'
      }`}
    >
      {isActive ? 'Active' : 'Inactive'}
      {/* The title is a mouse only tooltip; this carries the meaning to a screen reader. */}
      {!isActive && <span className="sr-only">: {INACTIVE_MEANING.toLowerCase()}</span>}
    </span>
  )
}
