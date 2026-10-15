/**
 * An in-memory stand-in for the SALESFORCE_BULKHEAD Durable Object namespace
 * (#2170): one lease set per key, honouring the limit each acquire carries,
 * exactly as `BulkheadObject` does, so a test can fill one key and watch what
 * the other does. A key named in `broken` throws on every call, as the object
 * did in the 2026-10-12 and 10-13 incidents.
 */
export interface FakeBulkheads {
  namespace: DurableObjectNamespace
  /** Leases held now, by key. */
  inflight(key: string): number
  /** Every acquire asked for, by key, in order. */
  readonly acquires: string[]
  /** Every release, by key, in order. */
  readonly releases: string[]
}

export function fakeBulkheads(opts: { seed?: Record<string, number>; broken?: string[] } = {}): FakeBulkheads {
  const leases = new Map<string, Set<string>>()
  const acquires: string[] = []
  const releases: string[] = []
  let issued = 0
  const setFor = (key: string) => {
    let set = leases.get(key)
    if (!set) {
      set = new Set()
      leases.set(key, set)
    }
    return set
  }
  for (const [key, n] of Object.entries(opts.seed ?? {})) {
    for (let i = 0; i < n; i++) setFor(key).add(`seed-${key}-${i}`)
  }
  const json = (body: unknown) => new Response(JSON.stringify(body))

  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const key = id.replace(/^bulkhead-/, '')
        if (opts.broken?.includes(key)) throw new Error('Durable Object reset because its code was updated.')
        const path = new URL(url).pathname
        const body = JSON.parse(String(init?.body ?? '{}')) as { limit?: number; token?: string }
        const set = setFor(key)
        if (path === '/acquire') {
          acquires.push(key)
          const limit = body.limit ?? 20
          if (set.size >= limit) return json({ allowed: false, inflight: set.size, limit })
          const token = `${key}-${issued++}`
          set.add(token)
          return json({ allowed: true, token, inflight: set.size, limit })
        }
        if (path === '/release') {
          releases.push(key)
          set.delete(body.token ?? '')
          return json({ ok: true })
        }
        return json({ inflight: set.size })
      },
    }),
  } as unknown as DurableObjectNamespace

  return { namespace, inflight: (key) => leases.get(key)?.size ?? 0, acquires, releases }
}
