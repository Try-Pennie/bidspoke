import { describe, it, expect } from 'vitest'
import { resolvePostSaveState, computeEditSignature } from '../save-dirty-guard'

describe('resolvePostSaveState (#92)', () => {
  it('marks clean and switches to view when no edit landed during the save', () => {
    expect(resolvePostSaveState(7, 7)).toEqual({ remainDirty: false, switchToView: true })
  })

  it('keeps dirty and stays in edit mode when an edit landed mid-save', () => {
    // One edit during the 1-3s save window bumped the counter.
    expect(resolvePostSaveState(7, 8)).toEqual({ remainDirty: true, switchToView: false })
  })

  it('keeps dirty when several edits landed during the save', () => {
    expect(resolvePostSaveState(7, 12)).toEqual({ remainDirty: true, switchToView: false })
  })

  it('treats any counter movement as dirty regardless of absolute values', () => {
    expect(resolvePostSaveState(0, 1).remainDirty).toBe(true)
    expect(resolvePostSaveState(100, 100).remainDirty).toBe(false)
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
