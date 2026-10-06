/**
 * The Node side of the money gate harness (#1704).
 *
 * The replay runs inside workerd, where it cannot write a file or start a Worker.
 * This module is bound to it as the GATE_IO service and does both:
 *
 *   POST /bundles    hosts each workflow's code bundle, built by the engine under
 *                    test, in its own workerd (a nested Miniflare), so code nodes
 *                    run for real. A determinism prelude pins the clock and the
 *                    randomness inside the bundle (L504).
 *   POST /dispatch   forwards one dispatch from a fake dispatch namespace binding
 *                    to the bundle it names in that namespace, or answers "not
 *                    found" as the platform does for a script never deployed there.
 *   POST /begin      starts a fixture: names it and sets its stub arms.
 *   GET  /drain      returns, and clears, the outbound requests the code bundles sent.
 *   POST /transcript writes the transcript to MONEY_GATE_OUT.
 *
 * Every outbound request a bundle makes lands in outboundService below: recorded,
 * stripped of credentials, and answered by the shared stub rules. Nothing leaves.
 * A bundle in a namespace that names an outbound Worker (the compare namespace,
 * #1708 part B) has its requests answered by that Worker's own code instead, as
 * the platform routes them, and they are not recorded as sent, because none is.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { OutboundRecord } from '../lib/compare'
import { parseBody, redactBody, redactHeaders, redactPathAndQuery } from '../lib/redact'
import { noRuleAnswer, readBodyText, stubAnswer, toResponse, type Arms } from '../lib/stub-rules'
import { determinismPrelude, GATE_ENTRY } from './determinism-prelude'
import compareOutbound from '../../../compare-outbound/src/index'
import type { HostedBundle } from '../lib/hosted-bundle'

/**
 * The outbound Workers the gate can stand in for, by the service name a
 * namespace's binding names, each its real handler. A namespace naming any
 * other stops the gate by name, since its bundles' egress would be a guess.
 */
const OUTBOUND_WORKERS: Record<string, (request: Request) => Response | Promise<Response>> = {
  'bidspoke-compare-outbound': (request) => compareOutbound.fetch(request),
}

export interface GateNamespace { binding: string; namespace: string; outbound: string | null }

/** One hosted script per namespace and name: the same name in two namespaces is two scripts. */
const bundleKey = (namespace: string, name: string): string => `${namespace}/${name}`

type MiniflareCtor = new (opts: Record<string, unknown>) => {
  ready: Promise<unknown>
  getWorker(name: string): Promise<{ fetch: (url: string, init?: Record<string, unknown>) => Promise<Response> }>
  dispose(): Promise<void>
}

async function loadMiniflare(): Promise<{ Miniflare: MiniflareCtor; convert: (o: Record<string, unknown>) => Record<string, unknown> }> {
  // The Vitest plugin's own Miniflare: the same workerd the replay runs on, with no
  // second copy to keep in step.
  const pluginEntry = fileURLToPath(import.meta.resolve('@cloudflare/vitest-plugin'))
  const fromPlugin = createRequire(pluginEntry)
  const mod = (await import(pathToFileURL(fromPlugin.resolve('miniflare')).href)) as {
    Miniflare: MiniflareCtor
    convertV4MiniflareOptions?: (o: Record<string, unknown>) => Record<string, unknown>
  }
  // Miniflare 5 takes a new options shape and converts the v4 one we write here.
  return { Miniflare: mod.Miniflare, convert: mod.convertV4MiniflareOptions ?? ((o) => o) }
}

export interface GateIoOptions {
  outPath: string | undefined
  fixedTimeMs: number
  /** The engine under test's dispatch namespaces, from its wrangler.toml. */
  dispatchNamespaces: GateNamespace[]
  /**
   * Holds every code dispatch this long before forwarding it (MONEY_GATE_DISPATCH_DELAY_MS,
   * default 0). A busy runner made a dispatch slow enough to trip a code node's step
   * timeout on one side only (#1796); this reproduces that on purpose, so a replay can
   * be shown to give the same transcript however slow its dispatches are.
   */
  dispatchDelayMs?: number
}

export function createGateIo(opts: GateIoOptions) {
  let mf: InstanceType<MiniflareCtor> | null = null
  /** Hosted bundles by namespace and name, to the Miniflare worker holding each. */
  let hosted = new Map<string, string>()
  let fixture = ''
  let arms: Arms = {}
  let dispatchNode = ''
  let outbound: OutboundRecord[] = []
  const unstubbed = new Set<string>()

  async function codeOutbound(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const headers: Record<string, string> = {}
    request.headers.forEach((v, k) => { headers[k] = v })
    const text = await readBodyText(request)
    const body = parseBody(text, request.headers.get('content-type'))
    outbound.push({
      via: 'code',
      node: dispatchNode,
      method: request.method,
      host: url.host,
      path: redactPathAndQuery(url),
      headers: redactHeaders(headers),
      body: redactBody(body),
    })
    const stubReq = { method: request.method, url, headers, body }
    const hit = stubAnswer(stubReq, arms)
    const answer = hit?.answer ?? noRuleAnswer(stubReq)
    if (!hit) unstubbed.add(`${url.host}${url.pathname} (${fixture})`)
    return toResponse(answer)
  }

  /** How a bundle's outbound requests are answered: its namespace's outbound Worker, or the stub rules. */
  function egressFor(namespace: string): (request: Request) => Response | Promise<Response> {
    const ns = opts.dispatchNamespaces.find((d) => d.namespace === namespace)
    if (!ns) throw new Error(`money gate: a bundle was hosted in ${namespace}, which the engine under test's wrangler.toml does not declare`)
    if (ns.outbound === null) return codeOutbound
    const worker = OUTBOUND_WORKERS[ns.outbound]
    if (!worker) throw new Error(`money gate: ${namespace} names the outbound Worker ${ns.outbound}, which the gate cannot stand in for; add its handler to OUTBOUND_WORKERS`)
    return worker
  }

  async function hostBundles(bundles: HostedBundle[]): Promise<void> {
    if (mf) await mf.dispose()
    mf = null
    hosted = new Map(bundles.map((b, i) => [bundleKey(b.namespace, b.name), `bundle-${i}`]))
    // No code to host: the replay goes on, and the verdict fails by name if it
    // turns out nothing was replayed at all, rather than this failing obliquely.
    if (bundles.length === 0) return
    const { Miniflare, convert } = await loadMiniflare()
    mf = new Miniflare(convert({
      workers: bundles.map((b, i) => ({
        name: `bundle-${i}`,
        modules: [
          { type: 'ESModule', path: 'gate-entry.mjs', contents: GATE_ENTRY },
          { type: 'ESModule', path: 'gate-determinism.mjs', contents: determinismPrelude(opts.fixedTimeMs) },
          { type: 'ESModule', path: 'script.js', contents: b.script },
        ],
        // The dispatch namespace uploads bundles with no compatibility date of their
        // own; any fixed date works here because base and head share it.
        compatibilityDate: '2024-09-23',
        outboundService: egressFor(b.namespace),
      })),
    }))
    await mf.ready
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/bundles': {
        const { bundles } = (await request.json()) as { bundles: HostedBundle[] }
        await hostBundles(bundles)
        return Response.json({ hosted: [...hosted.keys()] })
      }
      case '/begin': {
        const body = (await request.json()) as { fixture: string; arms: Arms }
        fixture = body.fixture
        arms = body.arms ?? {}
        outbound = []
        return Response.json({ ok: true })
      }
      case '/dispatch': {
        const name = url.searchParams.get('name') ?? ''
        const namespace = url.searchParams.get('namespace') ?? ''
        const path = url.searchParams.get('path') ?? '/'
        dispatchNode = url.searchParams.get('node') ?? ''
        const workerName = hosted.get(bundleKey(namespace, name))
        if (!mf || !workerName) return new Response('not found', { status: 404, headers: { 'x-money-gate': 'worker-not-found' } })
        if (opts.dispatchDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.dispatchDelayMs))
        const worker = await mf.getWorker(workerName)
        const res = await worker.fetch(`https://worker${path}`, {
          method: request.method,
          headers: { 'content-type': 'application/json', 'x-money-gate-seed': request.headers.get('x-money-gate-seed') ?? fixture },
          body: await request.text(),
        })
        const text = await res.text()
        return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
      }
      case '/drain': {
        const out = outbound
        outbound = []
        return Response.json({ outbound: out, unstubbed: [...unstubbed].sort() })
      }
      case '/transcript': {
        const text = await request.text()
        if (!opts.outPath) return new Response('MONEY_GATE_OUT is not set; the transcript was not written', { status: 500 })
        mkdirSync(dirname(opts.outPath), { recursive: true })
        writeFileSync(opts.outPath, text)
        return Response.json({ written: opts.outPath })
      }
      case '/dispose':
        await dispose()
        return Response.json({ disposed: true })
      default:
        return new Response('unknown gate io route', { status: 404 })
    }
  }

  async function dispose(): Promise<void> {
    if (mf) await mf.dispose()
    mf = null
  }

  return { handler, dispose }
}

/** The replay's own outbound backstop: anything reaching it escaped the harness's fetch. */
export function refuseRunnerOutbound(request: Request): Response {
  return new Response(`money gate: network is off; the replay worker reached ${new URL(request.url).host} past the harness`, { status: 598 })
}
