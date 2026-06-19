// Issue #92: the canvas save captured the definition at save start, then after
// the 1-3s await ran setIsDirty(false) unconditionally and switched to view mode.
// Any edit made during the save window stayed in canvas state but was flagged
// clean — Save disarmed, the beforeunload guard turned off, and navigating away
// or reloading silently dropped the edit. The post-save state is now resolved by
// comparing content signatures (resolvePostSaveStateBySignature, #212).

export interface PostSaveState {
  /** Keep isDirty true: an edit landed during the save window. */
  remainDirty: boolean
  /** Only switch to view mode when the saved snapshot is still current. */
  switchToView: boolean
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

// Issue #212: `isDirty` used to be a boolean that ~25 separate edit handlers each
// had to remember to set true — a new edit path that forgot its setIsDirty(true)
// would silently not mark the work unsaved (data loss). Dirty is now derived: the
// canvas compares the current content signature (computeEditSignature) to the
// signature captured at load and after each successful save. This is the single
// source of truth — impossible to forget.
export function isDirtyAgainst(savedSignature: string, currentSignature: string): boolean {
  return currentSignature !== savedSignature
}

// The whole decision the canvas's derive effect makes when the content signature
// changes (#212). `baseline` is the last-saved signature, or null when not yet
// baselined — on initial load and after a version restore the first signature
// seen becomes the clean baseline. Otherwise dirty is the signature mismatch.
// Returned `baseline` is written back so the caller never has to special-case the
// null bootstrap.
export function deriveDirty(
  baseline: string | null,
  currentSignature: string,
): { baseline: string; isDirty: boolean } {
  if (baseline === null) return { baseline: currentSignature, isDirty: false }
  return { baseline, isDirty: isDirtyAgainst(baseline, currentSignature) }
}

// Signature-based replacement for resolvePostSaveState: after a save completes,
// compare the signature we persisted against what's on screen now. If an edit
// landed during the save window the current signature already moved, so stay
// dirty and in edit mode; otherwise mark clean and switch to view.
export function resolvePostSaveStateBySignature(
  savedSignature: string,
  currentSignature: string,
): PostSaveState {
  const dirty = isDirtyAgainst(savedSignature, currentSignature)
  return { remainDirty: dirty, switchToView: !dirty }
}
