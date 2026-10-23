import { describe, expect, it } from 'vitest'
import {
  canvasSaveReducer,
  classifySaveRefusal,
  initialCanvasSave,
  loadTheirsDialog,
  loadTheirsFailure,
  pressKeys,
  saveFailureOutcome,
  saveOverDialog,
  staleWorkflowSentence,
  type CanvasSaveState,
} from '../workflow-save-conflict'
import type { WorkflowSaveBody } from '../api'
import type { WorkflowDef } from '@/types/workflow'

// The settled design's fixture (Maria Lopez, saved 2026-10-23T02:41:00Z), as
// the design's frames read it.
const fixture = { savedBy: 'Maria Lopez', savedAt: 'Oct 22, 10:41 PM ET', changedAt: '2026-10-23T02:41:00Z' }

// The canvas's reading of a refused save (#1947, #2599), in the settled design's
// words (docs/design/canvas-save-conflict.html, R1 to R4). The Worker refuses a
// save made from a version that is no longer stored with 409, code
// stale_version, carrying the current row, the press that last saved it and who
// made it and when.

const refused = (status: number | undefined, body: unknown) => Object.assign(new Error('refused'), { status, body })
const MARIA = { changedByName: fixture.savedBy, changedAt: fixture.changedAt }
const NOBODY = { changedByName: null, changedAt: fixture.changedAt }

describe('the settled words (R1, R3, R4)', () => {
  it('R1 names who saved and when, in ET, and says the edits are still on the canvas', () => {
    expect(staleWorkflowSentence(MARIA)).toBe(`Not saved. Maria Lopez saved this workflow at ${fixture.savedAt}, after you opened it. Your changes are still on the canvas.`)
  })

  it('R1 says the change came from outside the canvas when nobody is named', () => {
    expect(staleWorkflowSentence(NOBODY)).toBe(`Not saved. This workflow was changed at ${fixture.savedAt}, outside the canvas, after you opened it. Your changes are still on the canvas.`)
  })

  it('says an unknown time rather than throwing on a time it cannot read', () => {
    expect(staleWorkflowSentence({ changedByName: 'Maria Lopez', changedAt: 'not a time' })).toBe('Not saved. Maria Lopez saved this workflow at an unknown time, after you opened it. Your changes are still on the canvas.')
    expect(staleWorkflowSentence({ changedByName: 'Maria Lopez', changedAt: null })).toContain('at an unknown time,')
  })

  it('R3 asks before saving over theirs, naming whose save is replaced and when', () => {
    expect(saveOverDialog(MARIA)).toEqual({
      title: "Save over Maria Lopez's version?",
      description: `Their save at ${fixture.savedAt} is replaced by your changes. It stays in Version history.`,
      action: 'Save over theirs',
    })
  })

  // A change nobody is named for was made outside the canvas, by a hand write
  // that keeps no snapshot, so the dialog never claims Version history holds it.
  it('R3 names the change made outside the canvas without promising it is in Version history', () => {
    expect(saveOverDialog(NOBODY)).toEqual({
      title: 'Save over the newer version?',
      description: `The change made at ${fixture.savedAt}, outside the canvas, is replaced by your changes.`,
      action: 'Save over theirs',
    })
  })

  it('R4 asks before loading theirs, naming what is lost', () => {
    expect(loadTheirsDialog(MARIA)).toEqual({
      title: "Load Maria Lopez's version?",
      description: 'Your unsaved changes on the canvas are discarded and cannot be brought back.',
      action: 'Load theirs',
    })
    expect(loadTheirsDialog(NOBODY).title).toBe('Load the newer version?')
  })
})

describe('classifySaveRefusal', () => {
  const body = {
    code: 'stale_version',
    error: 'Not saved. This workflow was saved by someone else after you opened it.',
    current: { id: 'wf-1', version: 7, name: 'Achieve report import' },
    last_save_id: 'press-1',
    changed_by_name: 'Maria Lopez',
    changed_at: '2026-10-23T02:41:00Z',
  }

  it("reads a stale refusal of someone else's save as stale, with the version to save over", () => {
    expect(classifySaveRefusal(refused(409, body), 'press-2')).toEqual({
      kind: 'stale',
      stale: { version: 7, changedByName: 'Maria Lopez', changedAt: '2026-10-23T02:41:00Z' },
    })
  })

  it('reads a blank name as nobody named', () => {
    expect(classifySaveRefusal(refused(409, { ...body, changed_by_name: '' }), 'press-2')).toMatchObject({ kind: 'stale', stale: { changedByName: null } })
  })

  it('reads a stale refusal whose last press is this one as this press having landed', () => {
    expect(classifySaveRefusal(refused(409, body), 'press-1')).toEqual({ kind: 'own_save_landed', version: 7 })
  })

  // Without the current version there is nothing to save over, so the refusal
  // is shown as the Worker worded it, never with a guessed version.
  it('leaves a stale refusal with no readable version to the caller', () => {
    expect(classifySaveRefusal(refused(409, { ...body, current: null }), 'press-2')).toBeNull()
    expect(classifySaveRefusal(refused(409, { ...body, current: { version: '7' } }), 'press-2')).toBeNull()
    expect(classifySaveRefusal(refused(409, { ...body, current: { version: 7.5 } }), 'press-2')).toBeNull()
  })

  it('reads a failure with no answer at all (a timeout, a dropped connection) as unanswered', () => {
    expect(classifySaveRefusal(new TypeError('Failed to fetch'), 'press-3')).toEqual({ kind: 'unanswered', saveId: 'press-3' })
    expect(classifySaveRefusal(Object.assign(new Error('timed out'), { timedOut: true }), 'press-3')).toEqual({ kind: 'unanswered', saveId: 'press-3' })
  })

  it('leaves every answered failure that is not a stale save to the caller, 428 included', () => {
    expect(classifySaveRefusal(refused(428, { code: 'reload_required', error: 'Reload.' }), 'p')).toBeNull()
    expect(classifySaveRefusal(refused(409, { error: 'x', code: 'workflow_connection_missing' }), 'p')).toBeNull()
    expect(classifySaveRefusal(refused(409, { error: 'stale_version' }), 'p')).toBeNull()
    expect(classifySaveRefusal(refused(500, { error: 'Internal error' }), 'p')).toBeNull()
    expect(classifySaveRefusal(refused(401, undefined), 'p')).toBeNull()
  })
})

describe('canvasSaveReducer and pressKeys', () => {
  const ids = (...list: string[]) => { const left = [...list]; return () => left.shift() ?? 'exhausted' }
  const loaded = (version: number): CanvasSaveState => initialCanvasSave(version)

  it('a press names the version the canvas was loaded from and a new press id', () => {
    expect(pressKeys(loaded(4), ids('a'))).toEqual({ expected_version: 4, save_id: 'a' })
  })

  it('a save that landed moves the version the next press names, and clears a shown refusal', () => {
    let s = canvasSaveReducer(loaded(4), { type: 'refused', refusal: { kind: 'stale', stale: { version: 7, changedByName: 'Maria Lopez', changedAt: null } } })
    s = canvasSaveReducer(s, { type: 'saved', version: 8 })
    expect(s).toEqual({ baseVersion: 8, unansweredSaveId: null, conflict: null })
    expect(pressKeys(s, ids('b'))).toEqual({ expected_version: 8, save_id: 'b' })
  })

  it("a refusal of someone else's save is shown and leaves the version the canvas was loaded from", () => {
    const stale = { version: 7, changedByName: 'Maria Lopez', changedAt: fixture.changedAt }
    const s = canvasSaveReducer(loaded(4), { type: 'refused', refusal: { kind: 'stale', stale } })
    expect(s).toEqual({ baseVersion: 4, unansweredSaveId: null, conflict: stale })
  })

  it('Save mine over theirs names the version the refusal showed, and closes the refusal', () => {
    const stale = { version: 7, changedByName: 'Maria Lopez', changedAt: null }
    let s = canvasSaveReducer(loaded(4), { type: 'refused', refusal: { kind: 'stale', stale } })
    s = canvasSaveReducer(s, { type: 'save_over' })
    expect(s.conflict).toBeNull()
    expect(pressKeys(s, ids('c'))).toEqual({ expected_version: 7, save_id: 'c' })
  })

  it('Save mine over theirs with no refusal shown changes nothing', () => {
    expect(canvasSaveReducer(loaded(4), { type: 'save_over' })).toEqual(loaded(4))
  })

  it('Load their version re-bases the canvas on the version it loaded, and closes the refusal', () => {
    let s = canvasSaveReducer(loaded(4), { type: 'refused', refusal: { kind: 'stale', stale: { version: 7, changedByName: null, changedAt: null } } })
    s = canvasSaveReducer(s, { type: 'loaded', version: 9 })
    expect(s).toEqual({ baseVersion: 9, unansweredSaveId: null, conflict: null })
  })

  // A press whose answer never came may have landed. The next press reuses its
  // id, so a refusal whose last press is that id says it was this canvas's own
  // save, never someone else's. A refusal made before anything is written (a
  // loop, a missing connection) says nothing about it, so no event forgets it
  // but an answer that settles it.
  it('a press whose answer never came lends its id to the next press, which then recognises its own save', () => {
    let s = canvasSaveReducer(loaded(4), { type: 'refused', refusal: { kind: 'unanswered', saveId: 'lost' } })
    expect(pressKeys(s, ids('fresh'))).toEqual({ expected_version: 4, save_id: 'lost' })
    expect(classifySaveRefusal(refused(409, { code: 'stale_version', current: { version: 5 }, last_save_id: 'lost', changed_by_name: 'Me', changed_at: null }), 'lost')).toEqual({ kind: 'own_save_landed', version: 5 })
    s = canvasSaveReducer(s, { type: 'refused', refusal: { kind: 'own_save_landed', version: 5 } })
    expect(s).toEqual({ baseVersion: 5, unansweredSaveId: null, conflict: null })
    expect(pressKeys(s, ids('next'))).toEqual({ expected_version: 5, save_id: 'next' })
  })
})

// What the canvas does when a save fails (#2599): WorkflowCanvas cannot be
// mounted in jsdom (#737), so the decision is made here and the canvas only
// applies it.
describe('saveFailureOutcome', () => {
  const from = initialCanvasSave(4)
  const stale409 = (lastSaveId: string) => refused(409, { code: 'stale_version', error: 'Not saved. Someone else saved.', current: { version: 7 }, last_save_id: lastSaveId, changed_by_name: 'Maria Lopez', changed_at: fixture.changedAt })

  it("someone else's save: the strip shows it, no sentence beside it, no second save", () => {
    expect(saveFailureOutcome(stale409('theirs'), 'mine', from, false)).toEqual({
      event: { type: 'refused', refusal: { kind: 'stale', stale: { version: 7, changedByName: 'Maria Lopez', changedAt: fixture.changedAt } } },
      message: null,
      saveAgainFrom: null,
    })
  })

  it("this canvas's own lost press landed: saves once more on top of it, naming its version and a new press", () => {
    const out = saveFailureOutcome(stale409('mine'), 'mine', { ...from, unansweredSaveId: 'mine' }, false)
    expect(out.message).toBeNull()
    expect(out.saveAgainFrom).toEqual({ baseVersion: 7, unansweredSaveId: null, conflict: null })
    expect(out.event).toEqual({ type: 'refused', refusal: { kind: 'own_save_landed', version: 7 } })
  })

  it('never saves a third time: a second own landed answer is shown as the Worker worded it', () => {
    // The client copies the Worker's sentence into the error's message; this test's error carries 'refused'.
    expect(saveFailureOutcome(stale409('mine'), 'mine', from, true)).toMatchObject({ message: 'refused', saveAgainFrom: null })
  })

  it('no answer at all: shows the failure and keeps the press for the next one', () => {
    expect(saveFailureOutcome(new TypeError('Failed to fetch'), 'lost', from, false)).toEqual({
      event: { type: 'refused', refusal: { kind: 'unanswered', saveId: 'lost' } },
      message: 'Failed to fetch',
      saveAgainFrom: null,
    })
  })

  it('any other refusal, 428 included: shows the Worker\'s sentence and changes no save state', () => {
    expect(saveFailureOutcome(refused(428, { code: 'reload_required', error: 'Not saved. Reload.' }), 'p', from, false)).toEqual({ event: null, message: 'refused', saveAgainFrom: null })
    expect(saveFailureOutcome('a thrown string', 'p', from, false)).toMatchObject({ message: 'Save failed' })
  })
})

describe('loadTheirsFailure', () => {
  it('says their version was not loaded and the changes are still on the canvas', () => {
    expect(loadTheirsFailure(new Error('API 500'))).toBe('Their version was not loaded: API 500. Your changes are still on the canvas.')
    expect(loadTheirsFailure('x')).toBe('Their version was not loaded: the request failed. Your changes are still on the canvas.')
  })
})

// Every canvas save sends both keys because the save body's type will not
// compile a definition without them (#2599). Typechecked, not run: if the type
// ever allows it, the expected errors below go unused and the typecheck fails.
describe('WorkflowSaveBody', () => {
  const definition: WorkflowDef = { nodes: [], edges: [], trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } }
  it('will not take a definition without the version and the press, and takes a rename without either', () => {
    // @ts-expect-error a definition save names the version it was edited from and its press
    const neither: WorkflowSaveBody = { definition }
    // @ts-expect-error a definition save names its press too
    const noPress: WorkflowSaveBody = { definition, expected_version: 4 }
    const both: WorkflowSaveBody = { definition, expected_version: 4, save_id: 'press' }
    const rename: WorkflowSaveBody = { name: 'Renamed' }
    expect([neither, noPress, both, rename]).toHaveLength(4)
  })
})

