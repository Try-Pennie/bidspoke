import type { ActionRun } from '../../../runtime/types'

/** TEST ONLY. Version 2 of the fixture echo: upper cases the text and says which version answered. */
export const run: ActionRun = (_ctx, args) =>
  Promise.resolve({ echo: typeof args.text === 'string' ? args.text.toUpperCase() : null, version: 2 })
