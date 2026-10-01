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
 *   POST /dispatch   forwards one dispatch from the fake DYNAMIC_WORKER_LOADER to
 *                    the bundle it names, or answers "not found" as the platform
 *                    does for a script that was never deployed.
 *   POST /begin      starts a fixture: names it and sets its stub arms.
 *   GET  /drain      returns, and clears, the outbound requests the code bundles sent.
 *   POST /transcript writes the transcript to MONEY_GATE_OUT.
 *
 * Every outbound request a bundle makes lands in outboundService below: recorded,
 * stripped of credentials, and answered by the shared stub rules. Nothing leaves.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { OutboundRecord } from '../lib/compare'
import { parseBody, redactBody, redactHeaders, redactPathAndQuery } from '../lib/redact'
import { noRuleAnswer, readBodyText, stubAnswer, toResponse, type Arms } from '../lib/stub-rules'
import { determinismPrelude, GATE_ENTRY } from './determinism-prelude'

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
}

export function createGateIo(opts: GateIoOptions) {
  let mf: InstanceType<MiniflareCtor> | null = null
  let names = new Set<string>()
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

  async function hostBundles(bundles: Array<{ name: string; script: string }>): Promise<void> {
    if (mf) await mf.dispose()
    mf = null
    names = new Set(bundles.map((b) => b.name))
    // No code to host: the replay goes on, and the verdict fails by name if it
    // turns out nothing was replayed at all, rather than this failing obliquely.
    if (bundles.length === 0) return
    const { Miniflare, convert } = await loadMiniflare()
    mf = new Miniflare(convert({
      workers: bundles.map((b) => ({
        name: b.name,
        modules: [
          { type: 'ESModule', path: 'gate-entry.mjs', contents: GATE_ENTRY },
          { type: 'ESModule', path: 'gate-determinism.mjs', contents: determinismPrelude(opts.fixedTimeMs) },
          { type: 'ESModule', path: 'script.js', contents: b.script },
        ],
        // The dispatch namespace uploads bundles with no compatibility date of their
        // own; any fixed date works here because base and head share it.
        compatibilityDate: '2024-09-23',
        outboundService: codeOutbound,
      })),
    }))
    await mf.ready
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/bundles': {
        const { bundles } = (await request.json()) as { bundles: Array<{ name: string; script: string }> }
        await hostBundles(bundles)
        return Response.json({ hosted: [...names] })
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
        const path = url.searchParams.get('path') ?? '/'
        dispatchNode = url.searchParams.get('node') ?? ''
        if (!mf || !names.has(name)) return new Response('not found', { status: 404, headers: { 'x-money-gate': 'worker-not-found' } })
        const worker = await mf.getWorker(name)
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
