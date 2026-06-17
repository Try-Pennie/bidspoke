// React Flow's built-in Backspace delete generates raw `remove` changes that
// bypass the curated delete path (snapshot/undo, branch+parallel pair
// expansion, and the container-contents confirm). Wired into <ReactFlow
// onBeforeDelete>, this reroutes any NODE deletion through the curated handler
// and cancels RF's own delete; edge-only deletions fall through to RF.
//
// Returns true to let React Flow proceed (no nodes targeted — e.g. deleting a
// selected edge), or false to cancel it (nodes were rerouted to routeDelete).
// routeDelete is handleNodesDelete, which itself drops the trigger and no-ops
// on an empty set, so callers don't need to pre-filter.
//
// When nodes ARE targeted, cancelling RF's delete also cancels any edges it was
// about to remove in the same gesture — so a node co-selected with an unrelated
// edge would leave that edge behind (#130). We thread the targeted edge ids into
// routeDelete so the curated handler removes them too.
export function onBeforeNodeDelete(
  toDelete: ReadonlyArray<{ id: string }>,
  toDeleteEdges: ReadonlyArray<{ id: string }>,
  routeDelete: (ids: string[], edgeIds: string[]) => void,
): boolean {
  if (toDelete.length === 0) return true
  routeDelete(toDelete.map((n) => n.id), toDeleteEdges.map((e) => e.id))
  return false
}
