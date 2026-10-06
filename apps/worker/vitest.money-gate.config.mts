import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { unstable_readConfig } from 'wrangler'
import { createGateIo, refuseRunnerOutbound } from './money-gate/harness/gate-io'
import { FIXED_TIME_MS } from './money-gate/harness/replay-env'
import { parseDispatchDelay } from './money-gate/lib/dispatch-delay'

/**
 * The money gate replay (#1704). Runs the harness in this checkout against the
 * bidding engine of the checkout named by MONEY_GATE_ENGINE_ROOT (a repository
 * root; this one by default), so the merge base and the head are driven by the
 * same fixtures, stubs and recorder and differ only in the engine under test.
 *
 *   MONEY_GATE_ENGINE_ROOT  repository root of the side under test
 *   MONEY_GATE_OUT          where the transcript is written
 *   MONEY_GATE_SIDE         base or head, recorded in the transcript
 *   MONEY_GATE_DISPATCH_DELAY_MS  holds every code dispatch this long (default 0),
 *                           to prove a replay does not depend on how fast it runs (#1796)
 *
 * .github/scripts/money-gate.sh runs it twice and compares; see money-gate/README.md.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..')
const engineRoot = resolve(process.env.MONEY_GATE_ENGINE_ROOT ?? repoRoot)
const engineWorker = resolve(engineRoot, 'apps', 'worker')

/**
 * Every dispatch namespace the engine under test's wrangler.toml declares, read
 * with wrangler's own reader (#1730). The replay puts a recording fake on each of
 * these bindings, so each dispatch records the namespace it went through, and a
 * namespace added later (the compare namespace of #1708 part B) is faked and
 * recorded without this file changing.
 */
const dispatchNamespaces = (unstable_readConfig({ config: resolve(engineWorker, 'wrangler.toml') }, { hideWarnings: true }).dispatch_namespaces ?? [])
  // The outbound Worker a namespace names (#1708 part B), so the gate answers its
  // bundles' requests the way that Worker does, not from the stub rules.
  .map((d) => ({ binding: d.binding, namespace: d.namespace, outbound: d.outbound?.service ?? null }))
if (dispatchNamespaces.length === 0) {
  throw new Error(`money gate: ${resolve(engineWorker, 'wrangler.toml')} declares no dispatch namespace, so there is nothing for code nodes to dispatch through`)
}

const dispatchDelayMs = parseDispatchDelay(process.env.MONEY_GATE_DISPATCH_DELAY_MS)

const io = createGateIo({ outPath: process.env.MONEY_GATE_OUT ? resolve(process.env.MONEY_GATE_OUT) : undefined, fixedTimeMs: FIXED_TIME_MS, dispatchNamespaces, dispatchDelayMs })

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: resolve(engineWorker, 'wrangler.toml') },
      miniflare: {
        outboundService: refuseRunnerOutbound,
        serviceBindings: { GATE_IO: io.handler },
        // A plain text binding: the replay's buildEnv passes no text binding on to
        // the engine except the public vars, so the engine never sees it.
        bindings: { MONEY_GATE_DISPATCH_NAMESPACES: JSON.stringify(dispatchNamespaces) },
      },
    }),
  ],
  resolve: {
    alias: { '@money-gate-engine': resolve(engineWorker, 'src') },
  },
  define: {
    'import.meta.env.MONEY_GATE_SIDE': JSON.stringify(process.env.MONEY_GATE_SIDE ?? 'head'),
  },
  server: { fs: { allow: [repoRoot, engineRoot] } },
  test: {
    include: ['money-gate/harness/*.workers.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    env: { TZ: 'UTC', LANG: 'en_US.UTF-8' },
  },
})
