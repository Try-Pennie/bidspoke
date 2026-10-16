/**
 * The one Node module the worker imports at runtime (#2061, lib/outage-notice.ts):
 * AsyncLocalStorage, which workerd provides under the nodejs_compat flag in
 * wrangler.toml. The tsconfig loads only the Workers types, not all of Node's,
 * so this declares just the part used, as workerd implements it (run and
 * getStore; workerd has no enterWith).
 */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}
