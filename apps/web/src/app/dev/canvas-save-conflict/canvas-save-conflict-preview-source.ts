/**
 * The development preview's data for the canvas save conflict (#2599): the
 * settled design's own fixture (docs/design/canvas-save-conflict.fixture.json)
 * turned into the refusal each frame shows. No network. Not served in a
 * production build.
 */
import type { StaleSave } from '@/lib/workflow-save-conflict'
import fixture from '../../../../../../docs/design/canvas-save-conflict.fixture.json'

/** The settled frames (docs/design/canvas-save-conflict/settled.json): the design score's built side. */
export const SETTLED_FRAMES = ['refused', 'save-over', 'load-theirs', 'refused-outside'] as const

export type PreviewFrame = (typeof SETTLED_FRAMES)[number]

export function previewFrameOf(frame: string | undefined): PreviewFrame {
  return ((SETTLED_FRAMES as readonly string[]).includes(frame ?? '') ? frame : 'refused') as PreviewFrame
}

/** The refusal a frame shows: Maria Lopez's save, or on refused-outside a change nobody is named for. */
export function staleOf(frame: PreviewFrame): StaleSave {
  return {
    version: fixture.currentVersion,
    changedByName: frame === 'refused-outside' ? null : fixture.savedBy,
    changedAt: fixture.changedAt,
  }
}

/** The strip button a frame presses, as a person would, to open its dialog; null for none. */
export function askOf(frame: PreviewFrame): string | null {
  if (frame === 'save-over') return 'Save mine over theirs'
  if (frame === 'load-theirs') return 'Load their version'
  return null
}
