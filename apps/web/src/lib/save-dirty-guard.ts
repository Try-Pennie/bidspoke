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
