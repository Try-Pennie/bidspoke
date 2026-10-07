import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { unstable_readConfig } from 'wrangler'
import { createGateIo, refuseRunnerOutbound } from './money-gate/harness/gate-io'
import { FIXED_TIME_MS } from './money-gate/harness/replay-env'
import { parseDispatchDelay } from './money-gate/lib/dispatch-delay'
import { OUTAGE_DRILL_TIMEOUT_MS, isOutageNetworkRejection } from './money-gate/lib/outage'

/**
 * The outage drill (#1305), on the money gate's replay harness (#1704). It runs
 * the head only, as its own CI job: MONEY_GATE_ENGINE_ROOT is left unset, so the
 * engine under test is this checkout's.
 *
 *   MONEY_GATE_OUT     where the report is written
 *   OUTAGE_DRILL_ONLY  drill one workflow by name, for local iteration; the
 *                      report says the run was narrowed, and CI never sets it
 *
 * See money-gate/README.md, "The outage drill".
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

// CI drills every flow; a narrowed run there would pass on one flow.
if (process.env.CI && process.env.OUTAGE_DRILL_ONLY) {
  throw new Error(`outage drill: OUTAGE_DRILL_ONLY is set in CI (${process.env.OUTAGE_DRILL_ONLY}), so the run would drill one flow and still pass; unset it`)
}

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
        // OUTAGE_DRILL_ONLY rides in as a binding, as the namespaces do: a define of
        // import.meta.env does not reach the workerd pool.
        bindings: { MONEY_GATE_DISPATCH_NAMESPACES: JSON.stringify(dispatchNamespaces), OUTAGE_DRILL_ONLY: process.env.OUTAGE_DRILL_ONLY ?? '' },
      },
    }),
  ],
  resolve: {
    alias: { '@money-gate-engine': resolve(engineWorker, 'src') },
  },
  define: {
    'import.meta.env.MONEY_GATE_SIDE': JSON.stringify('head'),
  },
  server: { fs: { allow: [repoRoot, engineRoot] } },
  test: {
    include: ['money-gate/harness/outage.workers.test.ts'],
    // Only the refused shape's own rejection, which workerd reports even when it
    // was handled (money-gate/lib/outage.ts); any other unhandled error fails.
    onUnhandledError: (err) => (isOutageNetworkRejection(err) ? false : undefined),
    testTimeout: OUTAGE_DRILL_TIMEOUT_MS,
    hookTimeout: 120_000,
    env: { TZ: 'UTC', LANG: 'en_US.UTF-8' },
  },
})
