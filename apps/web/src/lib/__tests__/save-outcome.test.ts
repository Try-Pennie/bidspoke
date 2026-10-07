import { describe, expect, it } from 'vitest'
import { saveOutcomeMessage, saveFinished } from '../save-outcome'

/**
 * What the canvas tells the person after a save the server accepted (#1845):
 * nothing when it all landed, otherwise what landed and what did not.
 */
describe('saveOutcomeMessage', () => {
  it('is null for a save that fully landed', () => {
    expect(saveOutcomeMessage({})).toBeNull()
    expect(saveOutcomeMessage({ deploy_errors: [] })).toBeNull()
  })

  it('names each code node that failed to deploy', () => {
    expect(saveOutcomeMessage({ deploy_errors: [{ namespace: 'score', error: 'boom' }] })).toBe('Saved, but one code node failed to deploy:\nscore: boom')
    expect(saveOutcomeMessage({ deploy_errors: [{ namespace: 'a', error: 'x' }, { namespace: 'b', error: 'y' }] })).toBe('Saved, but 2 code nodes failed to deploy:\na: x\nb: y')
  })

  it('shows the stored copy warning the server sent', () => {
    expect(saveOutcomeMessage({ stored_copy_warning: 'The change was saved and recorded, but a stored copy could not be refreshed.' })).toBe('The change was saved and recorded, but a stored copy could not be refreshed.')
  })

  it('shows both when both happened', () => {
    const msg = saveOutcomeMessage({ deploy_errors: [{ namespace: 'a', error: 'x' }], stored_copy_warning: 'Copy not refreshed.' })
    expect(msg).toBe('Saved, but one code node failed to deploy:\na: x\n\nCopy not refreshed.')
  })
})

describe('saveFinished', () => {
  // A stored copy warning is about the copy, not the save: the save landed, so
  // the canvas leaves edit mode as for any clean save and shows the warning
  // beside it. Only a code node that failed to deploy keeps the person editing.
  it('is true for a clean save and for one carrying only the stored copy warning', () => {
    expect(saveFinished({})).toBe(true)
    expect(saveFinished({ stored_copy_warning: 'x' })).toBe(true)
  })

  it('is false while a code node failed to deploy', () => {
    expect(saveFinished({ deploy_errors: [{ namespace: 'a', error: 'x' }] })).toBe(false)
  })
})
