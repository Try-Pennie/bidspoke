import type { ActionRun } from '../../../runtime/types'

/** TEST ONLY. Version 1 of the fixture echo: returns the text as given. */
export const run: ActionRun = (_ctx, args) => Promise.resolve({ echo: args.text ?? null })
