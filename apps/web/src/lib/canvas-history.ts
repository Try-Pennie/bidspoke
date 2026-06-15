// Undo/redo history for the canvas, as pure reducers so the stack mechanics —
// and the rule that an applied undo/redo marks the workflow dirty (#94) — are
// testable without a DOM. The component holds one HistoryModel and applies the
// returned snapshot to the canvas; a null result means "nothing to do" (so it
// must NOT mark dirty).
//
// Issue #94: undo/redo used to restore a snapshot without touching the dirty
// flag, so after a save a Cmd+Z reverted the canvas but Save stayed disabled, no
// unsaved-changes warning fired, and the revert was never persisted (it
// reappeared on reload). reduceUndo/reduceRedo only return a step when something
// actually changes, and the component marks dirty on every non-null step.
import type { Node, Edge } from '@xyflow/react'

export interface CanvasSnapshot {
  nodes: Node[]
  edges: Edge[]
}

export interface HistoryModel {
  past: CanvasSnapshot[]
  future: CanvasSnapshot[]
}

export interface HistoryStep {
  /** Next history stacks after the undo/redo. */
  model: HistoryModel
  /** Snapshot to apply to the canvas. */
  restored: CanvasSnapshot
}

export const EMPTY_HISTORY: HistoryModel = { past: [], future: [] }

// Cap retained history. Matches the prior `slice(-30)` behavior.
const MAX_HISTORY = 30

/** Record the present as a new undo point and clear the redo stack. */
export function pushSnapshot(model: HistoryModel, present: CanvasSnapshot): HistoryModel {
  return { past: [...model.past.slice(-MAX_HISTORY), present], future: [] }
}

/** Undo: restore the most recent past snapshot, pushing the present onto redo. */
export function reduceUndo(model: HistoryModel, present: CanvasSnapshot): HistoryStep | null {
  if (model.past.length === 0) return null
  const restored = model.past[model.past.length - 1]
  return {
    model: { past: model.past.slice(0, -1), future: [present, ...model.future] },
    restored,
  }
}

/** Redo: restore the next future snapshot, pushing the present onto past. */
export function reduceRedo(model: HistoryModel, present: CanvasSnapshot): HistoryStep | null {
  if (model.future.length === 0) return null
  const restored = model.future[0]
  return {
    model: { past: [...model.past, present], future: model.future.slice(1) },
    restored,
  }
}
