/**
 * The code node sandbox records every non-2xx response its script fetches, so the engine can
 * recognise a partner firewall block page the script itself swallowed (#1265).
 *
 * The bundle is a generated ES module, so this loads the REAL built source through a data:
 * import and runs its fetch handler, the way the dispatch namespace would. Three things the
 * capture must get right, each proven here: it holds NO rule (it records host, status, the
 * content type, the Cloudflare headers and a bounded head of the body; the worker's one
 * detector decides), it is per invocation (two leads in flight at once never see each
 * other's records, because `fetch` is passed to each script the way `console` is, not
 * patched on the global), and it never costs the script its own body or unbounded memory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildBundledWorkerScript, BLOCK_CAPTURE_BODY_HEAD_BYTES } from '../code-node-deployer'
import { ACHIEVE_CLOUDFLARE_BLOCK_PAGE } from './fixtures/achieve-cloudflare-block-page'

type Handler = { fetch(request: Request): Promise<Response> }

async function loadBundle(scripts: Array<{ namespace: string; script: string }>): Promise<Handler> {
  const source = buildBundledWorkerScript(scripts)
  const mod = (await import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)) as { default: Handler }
  return mod.default
}

function execute(handler: Handler, namespace: string, body: Record<string, unknown> = {}) {
  return handler.fetch(new Request(`https://worker/execute/${namespace}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: {}, steps: {}, env: {}, execution: {}, props: {}, ...body }),
  }))
}

const blockResponse = () => new Response(ACHIEVE_CLOUDFLARE_BLOCK_PAGE, { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': 'a369312f2f2faa85-EWR' } })
const jsonResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })

const FETCH_SCRIPT = `const r = await fetch('https://oauth.prd.ffngcp.com/v1/token', { method: 'POST' })
const text = await r.text()
return { status: r.status, bodyLength: text.length }`

let realFetch: typeof fetch
beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { vi.unstubAllGlobals(); globalThis.fetch = realFetch })

describe('sandbox block capture', () => {
  it('records a non-2xx response with its host, status, headers and a head of the body, holding no rule', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => blockResponse()))
    const handler = await loadBundle([{ namespace: 'scout', script: FETCH_SCRIPT }])
    const res = await execute(handler, 'scout')
    expect(res.status).toBe(200)
    const envelope = await res.json() as { __bsv: number; output: { status: number; bodyLength: number }; blocks: Array<Record<string, unknown>> }
    expect(envelope.output).toEqual({ status: 403, bodyLength: ACHIEVE_CLOUDFLARE_BLOCK_PAGE.length })
    expect(envelope.blocks).toHaveLength(1)
    expect(envelope.blocks[0]).toMatchObject({ host: 'oauth.prd.ffngcp.com', url: 'https://oauth.prd.ffngcp.com/v1/token', status: 403, contentType: 'text/html; charset=UTF-8', cfRay: 'a369312f2f2faa85-EWR', cfMitigated: null })
    expect(String(envelope.blocks[0].bodyHead)).toContain('Sorry, you have been blocked')
  })

  it('always returns blocks, empty when every response was 2xx, so an old bundle is told apart from a quiet one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse()))
    const handler = await loadBundle([{ namespace: 'scout', script: FETCH_SCRIPT }])
    const envelope = await (await execute(handler, 'scout')).json() as { blocks: unknown[] }
    expect(envelope.blocks).toEqual([])
  })

  it('carries the records on the error envelope when the script throws after the fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => blockResponse()))
    const handler = await loadBundle([{ namespace: 'scout', script: `const r = await fetch('https://oauth.prd.ffngcp.com/v1/token')\nthrow new Error('HTTP ' + r.status)` }])
    const res = await execute(handler, 'scout')
    expect(res.status).toBe(500)
    const envelope = await res.json() as { error: string; blocks: Array<{ status: number }> }
    expect(envelope.error).toBe('HTTP 403')
    expect(envelope.blocks).toEqual([expect.objectContaining({ status: 403 })])
  })

  it('keeps records per invocation: two leads in flight at once never see each other\'s', async () => {
    let calls = 0
    const gate: Array<() => void> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => {
      calls++
      gate.push(() => resolve(url.includes('blocked') ? blockResponse() : jsonResponse()))
    })))
    const handler = await loadBundle([
      { namespace: 'blocked', script: `const r = await fetch('https://blocked.partner.test/x')\nreturn { status: r.status }` },
      { namespace: 'clean', script: `const r = await fetch('https://clean.partner.test/x')\nreturn { status: r.status }` },
    ])
    const a = execute(handler, 'blocked')
    const b = execute(handler, 'clean')
    await vi.waitFor(() => expect(calls).toBe(2))
    // Release in the opposite order to the start, so a shared list would interleave.
    gate[1]()
    gate[0]()
    const [ea, eb] = await Promise.all([a.then((r) => r.json()), b.then((r) => r.json())]) as Array<{ blocks: Array<{ host: string }> }>
    expect(ea.blocks.map((r) => r.host)).toEqual(['blocked.partner.test'])
    expect(eb.blocks).toEqual([])
  })

  it('bounds the body head and leaves the script its whole body', async () => {
    const huge = '<!DOCTYPE html><html><body>' + 'x'.repeat(1_000_000) + '</body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(huge, { status: 403, headers: { 'content-type': 'text/html' } })))
    const handler = await loadBundle([{ namespace: 'scout', script: FETCH_SCRIPT }])
    const envelope = await (await execute(handler, 'scout')).json() as { output: { bodyLength: number }; blocks: Array<{ bodyHead: string }> }
    expect(envelope.output.bodyLength).toBe(huge.length)
    expect(envelope.blocks[0].bodyHead.length).toBeLessThanOrEqual(BLOCK_CAPTURE_BODY_HEAD_BYTES)
  })

  it('records per step on the chain path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('blocked') ? blockResponse() : jsonResponse())))
    const handler = await loadBundle([
      { namespace: 'first', script: `const r = await fetch('https://blocked.partner.test/x')\nreturn { status: r.status }` },
      { namespace: 'second', script: `const r = await fetch('https://clean.partner.test/x')\nreturn { status: r.status }` },
    ])
    const res = await handler.fetch(new Request('https://worker/execute-chain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: [{ namespace: 'first' }, { namespace: 'second' }], payload: {}, steps: {}, env: {}, execution: {} }),
    }))
    const envelope = await res.json() as { results: Array<{ namespace: string; blocks: Array<{ host: string }> }> }
    expect(envelope.results.map((r) => [r.namespace, r.blocks.map((b) => b.host)])).toEqual([['first', ['blocked.partner.test']], ['second', []]])
  })

  it('a script that fetches nothing still returns an empty blocks list', async () => {
    const handler = await loadBundle([{ namespace: 'pure', script: 'return { ok: true }' }])
    const envelope = await (await execute(handler, 'pure')).json() as { blocks: unknown[] }
    expect(envelope.blocks).toEqual([])
  })
})

describe('a script must not declare its own fetch', () => {
  it('is refused at bundle build time, naming the namespace, because the injected fetch would make it a syntax error at deploy', () => {
    expect(() => buildBundledWorkerScript([{ namespace: 'scout', script: 'const fetch = () => 1\nreturn fetch()' }])).toThrow(/scout.*fetch/)
    expect(() => buildBundledWorkerScript([{ namespace: 'scout', script: 'function fetch() {}\nreturn 1' }])).toThrow(/scout.*fetch/)
  })

  it('leaves a script that merely calls fetch, or names a property fetch, alone', () => {
    expect(() => buildBundledWorkerScript([{ namespace: 'scout', script: 'const r = await fetch(x)\nconst o = { fetch: 1 }\nreturn r' }])).not.toThrow()
  })
})
