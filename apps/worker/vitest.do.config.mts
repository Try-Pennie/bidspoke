import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * The Workers test project (#1410): the Durable Object suites that need REAL
 * SQLite storage run inside workerd through Cloudflare's Vitest plugin, against
 * the bindings declared in wrangler.toml. A hand written Map double cannot prove
 * a SQLite backed object (L52), so these files are excluded from the Node
 * project in vitest.config.ts and run only here, via `pnpm run test:do`.
 * Storage is isolated per test file.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: {
    include: ['src/durable-objects/__tests__/*.workers.test.ts'],
  },
})
