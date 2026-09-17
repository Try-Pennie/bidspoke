import { describe, expect, it } from 'vitest'

/**
 * Browser storage works in the component test environment on every Node
 * version (#1375).
 *
 * Node 25 and later define a global `localStorage` of their own, which is
 * `undefined` unless Node was started with `--localstorage-file`. Vitest's jsdom
 * environment does not replace a global that already exists, so on those
 * versions `window.localStorage` stayed Node's empty one and every component test
 * that stores something failed, while CI on Node 22 passed. A local suite that is
 * always red trains people to skim failures, and a real one sat in the same list
 * on 2026-09-16. `vitest.setup.ts` restores jsdom's storage; this proves it.
 */
describe('storage in component tests (#1375)', () => {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    it(`gives window.${name} a working store`, () => {
      const storage = window[name]
      expect(storage, `window.${name} is not a Storage object`).toBeDefined()
      storage.setItem('component-test-storage', 'kept')
      expect(storage.getItem('component-test-storage')).toBe('kept')
      storage.clear()
      expect(storage.getItem('component-test-storage')).toBeNull()
    })
  }

  it('is the same store through window and the bare global, as app code reads either', () => {
    expect(globalThis.localStorage).toBe(window.localStorage)
  })
})
