/**
 * Runs the GENERATED capture code, the way Pipedream would, against receivers
 * that are dead, hung, failing and healthy (#1705).
 *
 * The promise to live Pipedream traffic is that the recorder changes nothing the
 * workflow does: same return value, same `$` calls in the same order, no throw,
 * and no long wait. Each test here runs the step module before and after
 * instrumenting and compares the two.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveWorkflowKey, verifyBodySignature } from '../../signature.ts'
import { instrumentWorkflow, keyEnvName, type PipedreamWorkflow } from '../index.ts'
import { codeStep, registryStep } from './fixture.ts'

const HASHID = 'p_RUNTIME'
const MASTER = 'runtime-test-master-secret'
const dir = mkdtempSync(path.join(tmpdir(), 'porting-capture-'))
let fileCount = 0

/** Loads a Pipedream step module, supplying the `defineComponent` global Pipedream provides. */
async function loadStep(code: string): Promise<{ run: (ctx: unknown) => Promise<unknown> }> {
  const file = path.join(dir, `step-${fileCount++}.mjs`)
  writeFileSync(file, `const defineComponent = (c) => c\n${code}`)
  const mod = (await import(pathToFileURL(file).href)) as { default: { run: (ctx: unknown) => Promise<unknown> } }
  return mod.default
}

const LEAD_STEP = `export default defineComponent({
  async run({ steps, $ }) {
    const body = steps.trigger.event.body
    if (body.reject) {
      await $.respond({ status: 400, body: { error: "rejected" } })
      return $.flow.exit("rejected")
    }
    if (body.quiet) $.flow.exit("quiet")
    $.export("score", body.score * 2)
    return { score: body.score * 2, name: body.name }
  },
})
`

const workflow = (): PipedreamWorkflow => ({
  id: HASHID,
  steps: [codeStep('lead', LEAD_STEP), registryStep('ret', 'http-return-http-response')],
  deployments: {},
})

/** A fake `$` that records every call, so before and after can be compared exactly. */
function fakeDollar() {
  const calls: unknown[] = []
  const $ = {
    respond: async (r: unknown) => {
      calls.push(['respond', r])
    },
    export: (k: string, v: unknown) => {
      calls.push(['export', k, v])
    },
    flow: {
      exit: (reason: string) => {
        calls.push(['exit', reason])
        return `exited:${reason}`
      },
    },
  }
  return { $, calls }
}

const stepsFor = (body: Record<string, unknown>) => ({ trigger: { event: { body }, context: { id: 'evt_123' } } })

async function runBoth(body: Record<string, unknown>) {
  const original = await loadStep(LEAD_STEP)
  const instrumented = await loadStep(instrumentWorkflow(workflow(), { receiverBaseUrl: 'https://ops.test', timeoutMs: 50 }).workflow.steps.find((s) => s.namespace === 'lead')!.uses.code!)
  const a = fakeDollar()
  const b = fakeDollar()
  const before = await original.run({ steps: stepsFor(body), $: a.$ })
  const after = await instrumented.run({ steps: stepsFor(body), $: b.$ })
  return { before, after, beforeCalls: a.calls, afterCalls: b.calls }
}

let keyHex = ''
beforeEach(async () => {
  keyHex = await deriveWorkflowKey(MASTER, HASHID)
  vi.stubEnv(keyEnvName(HASHID), keyHex)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('a dead receiver changes nothing the workflow does', () => {
  it.each([
    ['the normal path', { score: 3, name: 'Ann' }],
    ['the respond then exit path', { reject: true }],
    ['the bare exit path', { quiet: true, score: 1 }],
  ])('on %s: same return value, same $ calls, no throw', async (_label, body) => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('connect ECONNREFUSED')))
    vi.stubGlobal('fetch', fetch)
    const r = await runBoth(body)
    expect(r.after).toEqual(r.before)
    expect(r.afterCalls).toEqual(r.beforeCalls)
    if (!('score' in body) || 'quiet' in body || 'reject' in body) expect(fetch).toHaveBeenCalled()
  })

  it('returns within the timeout when the receiver hangs', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted by the capture timeout')))),
    )
    const started = performance.now()
    const r = await runBoth({ quiet: true })
    expect(r.after).toEqual(r.before)
    // Two runs, each waiting at most one 50 ms timeout per capture.
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('does not throw when the receiver answers 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    const r = await runBoth({ reject: true })
    expect(r.after).toEqual(r.before)
  })

  it('does not throw, and sends nothing, when the key env var is unset', async () => {
    vi.unstubAllEnvs()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const r = await runBoth({ quiet: true })
    expect(r.after).toEqual(r.before)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('what a capture sends', () => {
  const capturing = () => {
    const sent: Array<{ url: string; body: Uint8Array; signature: string | null }> = []
    vi.stubGlobal('fetch', async (url: string, init: { body: Uint8Array; headers: Record<string, string> }) => {
      sent.push({ url, body: init.body, signature: init.headers['x-porting-signature'] })
      return new Response('{}', { status: 202 })
    })
    return sent
  }
  const envelope = (s: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(s.body)) as Record<string, unknown>

  it('signs the exact bytes with the workflow key, verifiable by the shared verifier', async () => {
    const sent = capturing()
    await runBoth({ quiet: true })
    expect(sent.length).toBeGreaterThan(0)
    for (const s of sent) {
      expect(s.url).toBe(`https://ops.test/porting/capture/${HASHID}`)
      expect(await verifyBodySignature(keyHex, s.body, s.signature)).toBe(true)
    }
  })

  it('carries the event id, kind, site id, a unique sequence and the capture version', async () => {
    const sent = capturing()
    await runBoth({ reject: true })
    const env = sent.map(envelope)
    expect(env.map((e) => e.kind)).toEqual(['responded', 'terminal'])
    for (const e of env) {
      expect(e).toMatchObject({ v: 1, hashid: HASHID, event_id: 'evt_123' })
      expect(e.site).toMatch(/^main\/lead\/(respond|exit):\d+:\d+$/)
    }
    expect(env[0].payload).toEqual({ status: 400, body: { error: 'rejected' } })
    expect(new Set(env.map((e) => e.seq)).size).toBe(env.length)
  })

  it('carries the count of failed captures on the next one that succeeds', async () => {
    let calls = 0
    const bodies: Uint8Array[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: Uint8Array }) => {
      calls++
      if (calls === 1) throw new TypeError('down')
      bodies.push(init.body)
      return new Response('{}', { status: 202 })
    })
    const step = await loadStep(instrumentWorkflow(workflow(), { receiverBaseUrl: 'https://ops.test' }).workflow.steps.find((s) => s.namespace === 'lead')!.uses.code!)
    await step.run({ steps: stepsFor({ quiet: true }), $: fakeDollar().$ })
    await step.run({ steps: stepsFor({ quiet: true }), $: fakeDollar().$ })
    expect(envelope({ body: bodies[0] }).prior_failures).toBe(1)
  })

  it('runs the standalone start step and sends the trigger event', async () => {
    const sent = capturing()
    const start = await loadStep(instrumentWorkflow(workflow(), { receiverBaseUrl: 'https://ops.test' }).workflow.steps[0].uses.code!)
    await start.run({ steps: stepsFor({ score: 1 }), $: fakeDollar().$ })
    expect(envelope(sent[0])).toMatchObject({ kind: 'start', site: 'main/start', event_id: 'evt_123', payload: { body: { score: 1 } } })
  })

  it("runs the error listener: captures this workflow's failed run under its id and ignores other workflows", async () => {
    const sent = capturing()
    const listener = await loadStep(instrumentWorkflow(workflow(), { receiverBaseUrl: 'https://ops.test' }).errorListener.code)
    const errorEvent = (workflowId: string) => ({
      trigger: { event: { original_context: { id: 'evt_failed', workflow_id: workflowId }, error: { msg: 'boom' } }, context: { id: 'evt_listener' } },
    })
    await listener.run({ steps: errorEvent('p_OTHER') })
    expect(sent).toHaveLength(0)
    await listener.run({ steps: errorEvent(HASHID) })
    expect(envelope(sent[0])).toMatchObject({ kind: 'error', event_id: 'evt_failed' })
  })
})
