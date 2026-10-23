import { formatEtDayTime } from '@/lib/dates'

/**
 * A canvas save refused because the workflow moved on after the canvas loaded
 * it (#1947, #2599). The Worker refuses a save made from a version that is no
 * longer stored with 409, code stale_version, carrying the current row, the
 * press that last saved it and who made it and when. Nothing was written and
 * the edits are still on the canvas. The words are the settled design's
 * (R1 to R4 on #2599).
 */

/** Who saved the newer version and when, as the refusal names them. */
export interface StaleSave {
  /** The stored version, which Save mine over theirs names. */
  version: number
  changedByName: string | null
  changedAt: string | null
}

export type SaveRefusal =
  | { kind: 'stale'; stale: StaleSave }
  /** The last press the Worker recorded is this one: a press whose answer was lost had landed. */
  | { kind: 'own_save_landed'; version: number }
  /** No answer came at all (a timeout, a dropped connection): the press may or may not have landed. */
  | { kind: 'unanswered'; saveId: string }

function when(changedAt: string | null): string {
  if (!changedAt || Number.isNaN(Date.parse(changedAt))) return 'an unknown time'
  return `${formatEtDayTime(changedAt)} ET`
}

/** R1: the strip's sentence, naming who saved and when (ET), or that the change came from outside the canvas. */
export function staleWorkflowSentence(stale: Pick<StaleSave, 'changedByName' | 'changedAt'>): string {
  return stale.changedByName
    ? `Not saved. ${stale.changedByName} saved this workflow at ${when(stale.changedAt)}, after you opened it. Your changes are still on the canvas.`
    : `Not saved. This workflow was changed at ${when(stale.changedAt)}, outside the canvas, after you opened it. Your changes are still on the canvas.`
}

/**
 * R3: what Save mine over theirs asks before it saves. A change nobody is
 * named for was made outside the canvas, by a write that keeps no snapshot,
 * so its dialog never says Version history holds it.
 */
export function saveOverDialog(stale: Pick<StaleSave, 'changedByName' | 'changedAt'>): { title: string; description: string; action: string } {
  return stale.changedByName
    ? {
      title: `Save over ${stale.changedByName}'s version?`,
      description: `Their save at ${when(stale.changedAt)} is replaced by your changes. It stays in Version history.`,
      action: 'Save over theirs',
    }
    : {
      title: 'Save over the newer version?',
      description: `The change made at ${when(stale.changedAt)}, outside the canvas, is replaced by your changes.`,
      action: 'Save over theirs',
    }
}

/** R4: what Load their version asks before it replaces the canvas. */
export function loadTheirsDialog(stale: Pick<StaleSave, 'changedByName'>): { title: string; description: string; action: string } {
  return {
    title: stale.changedByName ? `Load ${stale.changedByName}'s version?` : 'Load the newer version?',
    description: 'Your unsaved changes on the canvas are discarded and cannot be brought back.',
    action: 'Load theirs',
  }
}

const versionOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const nameOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/**
 * A failed save the canvas answers itself, or null for every other failure,
 * which is shown as the Worker worded it (a 428 reload_required among them).
 * `saveId` is the press that was sent.
 */
export function classifySaveRefusal(err: unknown, saveId: string): SaveRefusal | null {
  const e = (err ?? {}) as { status?: unknown; body?: unknown }
  if (typeof e.status !== 'number') return { kind: 'unanswered', saveId }
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>
  if (e.status !== 409 || body.code !== 'stale_version') return null
  const current = body.current && typeof body.current === 'object' ? (body.current as Record<string, unknown>) : null
  const version = versionOf(current?.version)
  if (version === null) return null
  if (body.last_save_id === saveId) return { kind: 'own_save_landed', version }
  return { kind: 'stale', stale: { version, changedByName: nameOf(body.changed_by_name), changedAt: nameOf(body.changed_at) } }
}

/**
 * The canvas's save state: the version its definition was loaded from or last
 * saved as, a press whose answer never came, and the refusal the strip shows.
 * Kept in one pure reducer because the canvas cannot be mounted in jsdom (#737).
 */
export interface CanvasSaveState {
  baseVersion: number
  unansweredSaveId: string | null
  conflict: StaleSave | null
}

export type CanvasSaveEvent =
  /** The canvas holds a stored version: the first load, Load their version, a version restore. */
  | { type: 'loaded'; version: number }
  /** A save answered, written or found unchanged, at the stored version. */
  | { type: 'saved'; version: number }
  | { type: 'refused'; refusal: SaveRefusal }
  /** Save mine over theirs confirmed: the next press names the version the refusal showed. */
  | { type: 'save_over' }

export function initialCanvasSave(version: number): CanvasSaveState {
  return { baseVersion: version, unansweredSaveId: null, conflict: null }
}

export function canvasSaveReducer(state: CanvasSaveState, event: CanvasSaveEvent): CanvasSaveState {
  switch (event.type) {
    case 'loaded':
    case 'saved':
      return initialCanvasSave(event.version)
    case 'save_over':
      return state.conflict ? { ...state, baseVersion: state.conflict.version, conflict: null } : state
    case 'refused': {
      const r = event.refusal
      if (r.kind === 'unanswered') return { ...state, unansweredSaveId: r.saveId }
      if (r.kind === 'own_save_landed') return initialCanvasSave(r.version)
      return { ...state, unansweredSaveId: null, conflict: r.stale }
    }
  }
}

/** What a press sends: the version the canvas was edited from, and the lost press's id when there is one. */
export function pressKeys(state: CanvasSaveState, newSaveId: () => string): { expected_version: number; save_id: string } {
  return { expected_version: state.baseVersion, save_id: state.unansweredSaveId ?? newSaveId() }
}

/**
 * What the canvas does with a failed save (#2599), decided here because the
 * canvas cannot be mounted in jsdom (#737): the save state event to apply, the
 * sentence to show in the save error strip (null when the save conflict strip
 * says it), and the state to save once more from when the failure was this
 * canvas's own lost press having landed. That second save is made at most
 * once (`afterOwnSave` on it), so it can never loop.
 */
export function saveFailureOutcome(err: unknown, saveId: string, from: CanvasSaveState, afterOwnSave: boolean): {
  event: CanvasSaveEvent | null
  message: string | null
  saveAgainFrom: CanvasSaveState | null
} {
  const refusal = classifySaveRefusal(err, saveId)
  const event: CanvasSaveEvent | null = refusal ? { type: 'refused', refusal } : null
  const shown = err instanceof Error ? err.message : 'Save failed'
  if (refusal?.kind === 'stale') return { event, message: null, saveAgainFrom: null }
  if (refusal?.kind === 'own_save_landed' && !afterOwnSave) {
    return { event, message: null, saveAgainFrom: canvasSaveReducer(from, { type: 'refused', refusal }) }
  }
  return { event, message: shown, saveAgainFrom: null }
}

/** R4's failure: their version could not be read, and nothing on the canvas changed. */
export function loadTheirsFailure(err: unknown): string {
  return `Their version was not loaded: ${err instanceof Error ? err.message : 'the request failed'}. Your changes are still on the canvas.`
}

