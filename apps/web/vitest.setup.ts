// Setup for the jsdom "components" vitest project (issue #157). Registers the
// jest-dom matchers (toBeInTheDocument, etc.) and unmounts rendered trees after
// each test so DOM state never leaks between cases.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Node 25 and later define a global `localStorage` (and `sessionStorage`) that is
// `undefined` unless Node was started with `--localstorage-file`, and vitest's
// jsdom environment does not replace a global that already exists. So on those
// versions every component test that stores anything failed locally while CI on
// Node 22 passed (#1375). Put jsdom's own storage back wherever Node's shadows it.
// component-test-storage.test.tsx proves the result on whatever Node runs it.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (!dom) {
  throw new Error('vitest.setup.ts expected the jsdom environment to expose `jsdom`, so storage cannot be restored')
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (globalThis[name] === undefined) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  }
}

afterEach(() => {
  cleanup()
})
