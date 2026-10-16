// Setup for every jsdom vitest project: "components" (issue #157) and the "tz"
// zone projects (#2137), which run the *.tz.test files in forked processes and
// depend on the storage guard and Radix stubs below too. Registers the jest-dom
// matchers (toBeInTheDocument, etc.) and unmounts rendered trees after each test
// so DOM state never leaks between cases.
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

// Browser APIs the Radix controls call that jsdom does not implement (#2137).
// Each stands in for the browser only where jsdom lacks it, so a jsdom that
// gains the real one is used instead, and each was seen needed by
// primitives.test.tsx, which renders Select and Toggle inside a <form>:
// without ResizeObserver a Toggle in a form and an opened Select throw,
// without scrollIntoView opening a Select throws, and without
// hasPointerCapture a mouse press on a Select throws. releasePointerCapture is
// not stubbed: Radix calls it only when hasPointerCapture answers true.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStandIn {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStandIn as unknown as typeof ResizeObserver
}
const elementProto = globalThis.Element.prototype as Element & {
  hasPointerCapture?: (id: number) => boolean
  scrollIntoView?: (arg?: boolean | ScrollIntoViewOptions) => void
}
if (typeof elementProto.hasPointerCapture !== 'function') elementProto.hasPointerCapture = () => false
if (typeof elementProto.scrollIntoView !== 'function') elementProto.scrollIntoView = () => {}

afterEach(() => {
  cleanup()
})
