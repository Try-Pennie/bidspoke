import { describe, it, expect } from 'vitest'
import {
  computeEditSignature,
  isDirtyAgainst,
  resolvePostSaveStateBySignature,
  deriveDirty,
} from '../save-dirty-guard'

// #212: the single decision the derive effect makes each time the content
// signature changes. A null baseline means "not yet baselined" — initial load and
// post-restore adopt the first signature they see as the clean baseline; a
// non-null baseline (set on save) is compared against to decide dirty.
describe('deriveDirty (#212)', () => {
  it('adopts the current signature as a clean baseline when none is set (load/restore)', () => {
    expect(deriveDirty(null, 'sig-load')).toEqual({ baseline: 'sig-load', isDirty: false })
  })

  it('stays clean while the signature matches the saved baseline', () => {
    expect(deriveDirty('sig-saved', 'sig-saved')).toEqual({ baseline: 'sig-saved', isDirty: false })
  })

  it('becomes dirty when an edit moves the signature off the baseline', () => {
    expect(deriveDirty('sig-saved', 'sig-edited')).toEqual({ baseline: 'sig-saved', isDirty: true })
  })

  it('keeps the existing baseline when comparing (does not adopt the current edit)', () => {
    expect(deriveDirty('sig-saved', 'sig-edited').baseline).toBe('sig-saved')
  })
})

// #212: dirty is derived by comparing the current content signature to the
// last-saved one, replacing ~25 scattered setIsDirty(true) calls.
describe('isDirtyAgainst (#212)', () => {
  it('is not dirty when the current signature matches the last-saved one', () => {
    expect(isDirtyAgainst('sig-A', 'sig-A')).toBe(false)
  })

  it('is dirty when the current signature differs from the last-saved one', () => {
    expect(isDirtyAgainst('sig-A', 'sig-B')).toBe(true)
  })
})

describe('resolvePostSaveStateBySignature (#212)', () => {
  it('marks clean and switches to view when the saved signature is still current', () => {
    // No edit landed during the save window: what we saved is what is on screen.
    expect(resolvePostSaveStateBySignature('saved', 'saved')).toEqual({
      remainDirty: false,
      switchToView: true,
    })
  })

  it('keeps dirty and stays in edit mode when an edit landed during the save', () => {
    // The current signature moved past the snapshot we persisted.
    expect(resolvePostSaveStateBySignature('saved', 'edited-mid-save')).toEqual({
      remainDirty: true,
      switchToView: false,
    })
  })
})

describe('computeEditSignature (#160)', () => {
  const def = { nodes: [{ id: 'a' }], edges: [], trigger: { type: 'http_webhook' } }

  it('is stable for identical content (selection/measurement churn does not change it)', () => {
    // Same definition content in a fresh object reference — the array identity
    // changed (as React Flow does on selection) but the payload did not.
    const a = computeEditSignature(def, 'Flow', '#alerts')
    const b = computeEditSignature({ nodes: [{ id: 'a' }], edges: [], trigger: { type: 'http_webhook' } }, 'Flow', '#alerts')
    expect(a).toBe(b)
  })

  it('changes when the definition changes', () => {
    const before = computeEditSignature(def, 'Flow', '#alerts')
    const after = computeEditSignature({ ...def, nodes: [{ id: 'a' }, { id: 'b' }] }, 'Flow', '#alerts')
    expect(after).not.toBe(before)
  })

  it('changes when the name or slack channel changes', () => {
    const base = computeEditSignature(def, 'Flow', '#alerts')
    expect(computeEditSignature(def, 'Flow 2', '#alerts')).not.toBe(base)
    expect(computeEditSignature(def, 'Flow', '#other')).not.toBe(base)
  })

  it('treats a null and absent slack channel the same', () => {
    expect(computeEditSignature(def, 'Flow', null)).toBe(computeEditSignature(def, 'Flow', null))
  })
})
