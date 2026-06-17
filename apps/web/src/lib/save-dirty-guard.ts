// Issue #92: the canvas save captured the definition at save start, then after
// the 1-3s await ran setIsDirty(false) unconditionally and switched to view mode.
// Any edit made during the save window stayed in canvas state but was flagged
// clean — Save disarmed, the beforeunload guard turned off, and navigating away
// or reloading silently dropped the edit.
//
// handleSave now snapshots a monotonic edit counter before its awaits and passes
// before/after values here. If the counter moved, an edit landed mid-save and the
// just-persisted snapshot is already stale, so the workflow stays dirty and in
// edit mode instead of being marked clean.

export interface PostSaveState {
  /** Keep isDirty true: an edit landed during the save window. */
  remainDirty: boolean
  /** Only switch to view mode when the saved snapshot is still current. */
  switchToView: boolean
}

export function resolvePostSaveState(
  editCountAtSaveStart: number,
  editCountNow: number,
): PostSaveState {
  const editsLandedDuringSave = editCountNow !== editCountAtSaveStart
  return {
    remainDirty: editsLandedDuringSave,
    switchToView: !editsLandedDuringSave,
  }
}

// Issue #160: the edit counter that powers the #92 mid-save check used to bump on
// any React Flow node/edge array change, including selection and dimension
// measurement — non-content churn. Clicking Save can deselect a node, bumping
// the counter during the save's await, so a clean save was wrongly judged
// "edited mid-save" and stayed dirty, firing the unsaved-changes warning right
// after saving. The counter now bumps only when this signature — the exact
// serialized payload that gets saved — actually changes.
export function computeEditSignature(
  definition: unknown,
  name: string,
  slackChannel: string | null,
): string {
  return JSON.stringify({ definition, name, slackChannel: slackChannel ?? null })
}
