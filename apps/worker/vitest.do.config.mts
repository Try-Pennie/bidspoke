import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * The Workers test projects (#1410), run by `pnpm run test:do`.
 *
 * do: the Durable Object suites that need REAL SQLite storage run inside workerd
 * through Cloudflare's Vitest plugin, against the bindings declared in
 * wrangler.toml. A hand written Map double cannot prove a SQLite backed object
 * (L52), so these files are excluded from the Node project in vitest.config.ts
 * and run only here. Storage is isolated per test file.
 *
 * ops (#1946): the ops Worker's suites that need a REAL service binding, against
 * wrangler.ops.toml, so its SELF binding to its own OpsInternal entrypoint is the
 * one that deploys. A second project rather than a second command, so the CI
 * steps that run test:do run it without being edited.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
        test: { name: 'do', include: ['src/durable-objects/__tests__/*.workers.test.ts'] },
      },
      {
        // enable_ctx_exports here only: the plugin discovers a Worker's named
        // entrypoints (and so can serve the SELF binding's OpsInternal) only with
        // it on. Production needs no flag for a binding to a named entrypoint
        // (RPC is default from 2024-04-03, and the ops Worker is on 2024-09-23);
        // whether Cloudflare accepts the self binding is a Stage 2 measurement.
        // PORTING_CAPTURE_MASTER is a test value: the dispatch key derives from it
        // (#1949). OPS_GATEWAY names the bidding Worker, which this project does
        // not run, so it is stood in for by a stub that answers nothing (the
        // tick's use of it is proven in Node, tick-live.test.ts).
        plugins: [cloudflareTest({
          wrangler: { configPath: './wrangler.ops.toml' },
          miniflare: {
            compatibilityFlags: ['enable_ctx_exports'],
            bindings: { PORTING_CAPTURE_MASTER: 'workerd-test-master' },
            serviceBindings: { OPS_GATEWAY: () => new Response('the bidding Worker is not run in this project', { status: 503 }) },
          },
        })],
        test: { name: 'ops', include: ['src/ops/__tests__/*.workers.test.ts'] },
      },
    ],
  },
})
