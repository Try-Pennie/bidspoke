/**
 * A stand in for fetch that records every call and answers through a function,
 * shared by the inventory's store and decision tests (#1710, #2979).
 */
export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

export function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { f, calls }
}
