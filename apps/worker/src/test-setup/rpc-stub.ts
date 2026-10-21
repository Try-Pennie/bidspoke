/**
 * A binding double shaped like a real Cloudflare RPC stub (#2338): EVERY
 * property read, on the stub or on one of its methods, is another remote
 * method, so `.call`, `.apply` or `.bind` read off a method names a method the
 * far side does not export, and calling it throws the way the deployed binding
 * does ("internal error; reference = <id>"). A plain object double lets `.call`
 * work, which is how build PR 5 (#2569) shipped a client that threw on every
 * call through the real OPS_CONNECTIONS binding (fixed by #2570).
 *
 * Tests of a route that calls through OPS_CONNECTIONS hand this to the env, so
 * a route whose call shape a real stub would refuse fails its own tests.
 */
import type { OpsConnectionsBinding } from '../lib/ops-connections-contract'

export type RpcHandlers = Readonly<Record<string, (request: unknown) => Promise<unknown>>>

export function rpcStub(handlers: RpcHandlers): OpsConnectionsBinding {
  const remote = (name: string): unknown => new Proxy(() => {}, {
    apply: (_target, _this, args: unknown[]) => {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined
      return handler ? handler(args[0]) : Promise.reject(new Error('internal error; reference = 0a1b2c3d4e5f'))
    },
    get: (_target, sub) => remote(`${name}.${String(sub)}`),
  })
  return new Proxy({}, { get: (_target, name) => remote(String(name)) }) as unknown as OpsConnectionsBinding
}
