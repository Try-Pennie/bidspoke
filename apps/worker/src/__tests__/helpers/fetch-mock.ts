import { vi, type Mock } from 'vitest'

/**
 * A typed mock for the global `fetch` (issue #297).
 *
 * The point is the *return* type: implementations and resolved values are typed
 * to produce a Promise, so eslint's `no-misused-promises` doesn't misread an
 * async mock impl as a void callback. An untyped `vi.fn()` returns `any`, which
 * the rule treats as a void-return context — that's why the two abort-signal
 * tests previously needed `eslint-disable` comments.
 *
 * Call args stay loose (`any[]`) on purpose: tests inspect recorded calls like
 * `mock.calls[0][1].headers['X-Trace-Id']`, which strict `RequestInit`/
 * `HeadersInit` types don't allow by index. The resolved type is `unknown` so
 * the partial `mockResponse(...)` fakes (not real `Response` objects) still
 * assign without casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose call-arg types so tests inspect mock.calls without casts
export type FetchMock = Mock<(...args: any[]) => Promise<unknown>>

/** Create a typed fetch mock and install it as the global `fetch`. */
export function stubFetch(): FetchMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see FetchMock
  const mock = vi.fn<(...args: any[]) => Promise<unknown>>()
  vi.stubGlobal('fetch', mock)
  return mock
}
