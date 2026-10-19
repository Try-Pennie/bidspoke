/**
 * A refusing stand in for every service binding the engine under test's
 * wrangler.toml declares (#2335). workerd will not start a Worker whose binding
 * names a service it does not run, and the replay runs no other Worker, so
 * without these the gate could not start at all once the bidding Worker binds
 * the ops Worker's OpsConnections entrypoint. Derived from the config, as the
 * dispatch namespaces are (#1730), so a binding added later is covered without
 * this changing. Each answers 503 to a fetch, and an RPC method call on it
 * throws: the engine must never reach one (Hard Rule 1), so a replay that did
 * would show a difference.
 */
export function refusingServiceStubs(services: ReadonlyArray<{ binding: string; service?: string }> | undefined): Record<string, () => Response> {
  return Object.fromEntries((services ?? []).map(({ binding, service }) => [
    binding,
    () => new Response(`the money gate runs no other Worker, so ${binding} (${service ?? 'unnamed service'}) answers nothing`, { status: 503 }),
  ]))
}
