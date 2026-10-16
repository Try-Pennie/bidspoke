/**
 * The Node test project's stand in for `cloudflare:workers` (#1946), which only
 * workerd can resolve. vitest.config.ts aliases the module here so a Node test
 * can import a file that declares a WorkerEntrypoint (src/ops/internal.ts). It
 * carries the shape only, never behaviour: what a real binding does is proven in
 * workerd (src/ops/__tests__/self-dispatch.workers.test.ts).
 */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: ExecutionContext,
    readonly env: Env,
  ) {}
}
