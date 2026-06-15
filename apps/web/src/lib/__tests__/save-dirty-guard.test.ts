import { describe, it, expect } from 'vitest'
import { resolvePostSaveState } from '../save-dirty-guard'

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
