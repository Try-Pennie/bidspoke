import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Serves the kept Engine canvas scripts as text (#1472).
 *
 * apps/worker/src/engine/scripts/engine-bidding/*.js and liberty1-click/*.js
 * (#1545) are pasted into code nodes byte for byte, so they are script BODIES (top level returns) and not
 * modules; imported as modules they fail to parse. In the deployed worker a
 * wrangler Text rule (wrangler.toml [[rules]]) gives the same import a string,
 * and the sibling .d.ts files type it. This is the Node side of that one import.
 */
function keptCanvasScriptsAsText(): Plugin {
  return {
    name: 'kept-canvas-scripts-as-text',
    enforce: 'pre',
    load(id) {
      if (!/\/engine\/scripts\/(?:engine-bidding|liberty1-click)\/[^/?]+\.js$/.test(id)) return null
      return { code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`, map: null }
    },
  }
}

export default defineConfig({
  plugins: [keptCanvasScriptsAsText()],
  test: {
    include: ['src/**/*.test.ts'],
    // The Workers test project (vitest.do.config.mts, `pnpm run test:do`) owns
    // these: they import cloudflare:test and cannot run on Node (#1410).
    exclude: ['**/node_modules/**', 'src/durable-objects/__tests__/*.workers.test.ts'],
    environment: 'node',
    // Worker threads rather than forked child processes (#973). Measured on this
    // suite: 4.14 to 5.45s on forks, 3.16 to 3.36s on threads, over three runs
    // each, with identical results (236 files, 3338 tests). A thread starts far
    // cheaper than a process, and this suite is 236 small files, so startup
    // dominates.
    //
    // `isolate` stays at its default of true, deliberately and permanently.
    // Turning it off is the bigger lever and it is a WEAKENING: tests sharing
    // module state start passing or failing for reasons unrelated to the code
    // under test. Threads keep a fresh module registry per file, so this is
    // faster without giving that up.
    pool: 'threads',
  },
})
