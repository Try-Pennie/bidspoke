import '@eslint/js'
import type { ActionRun } from '../../../runtime/types'

/**
 * TEST ONLY. Version 2 of the fixture echo: upper cases the text and says which
 * version answered.
 *
 * It imports an npm package only so that it reaches one, which lets the fixture
 * prove a dependency's resolved version is part of the fingerprint (#2337).
 * `@eslint/js` is used because it is already installed for this package and
 * loads nothing but a few config objects.
 */
export const run: ActionRun = (_ctx, args) =>
  Promise.resolve({ echo: typeof args.text === 'string' ? args.text.toUpperCase() : null, version: 2 })
