/**
 * POST /porting/capture/:hashid on the ops Worker (#1705).
 *
 * Caller: Pipedream capture steps only, each signing with its workflow's
 * derived key. The order is the contract: refuse an unset master or unknown
 * workflow by name, verify the signature before anything else is read or
 * counted, quarantine an unknown capture version rather than drop it, redact
 * before any write and refuse the write if redaction throws, never log a body
 * or an error message, and never overwrite a stored capture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveWorkflowKey, signBody } from '@bidspoke/porting-evidence'
import { createOpsHandler, type OpsEnv } from '../index'
import type { PortingRegistry } from '../porting-registry'

const MASTER = 'ops-test-master-secret'
const HASHID = 'p_ENROLLED'
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

/** An in memory stand in for the R2 bucket, recording every write. */
function fakeBucket() {
  const objects = new Map<string, { body: string; customMetadata?: Record<string, string> }>()
  const bucket = {
    head: vi.fn(async (key: string) => (objects.has(key) ? { key } : null)),
    // Honours R2's conditional write: with onlyIf etagDoesNotMatch '*', an
    // existing key is left alone and the put answers null.
    put: vi.fn(async (key: string, body: string, opts?: { customMetadata?: Record<string, string>; onlyIf?: { etagDoesNotMatch?: string } }) => {
      await Promise.resolve()
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null
      objects.set(key, { body, customMetadata: opts?.customMetadata })
      return { key }
    }),
  }
  return { bucket, objects }
}

const registry: PortingRegistry = {
  enrolled: { [HASHID]: { name: 'Fixture flow', enrolledOn: '2026-10-01' } },
  currentCaptureVersions: [1],
}

const envelope = (over: Record<string, unknown> = {}) => ({
  v: 1,
  hashid: HASHID,
  event_id: 'evt_abc123',
  kind: 'terminal',
  site: 'main/end',
  seq: '1759320000000.0.k3j2h1',
  sent_at: new Date(NOW).toISOString(),
  prior_failures: 0,
  payload: { lead: { email: 'a@example.test' }, headers: { Authorization: 'Bearer sekrit-value-123456' }, password: 'hunter2hunter2' },
  ...over,
})

async function signedRequest(body: unknown, opts: { hashid?: string; keyFor?: string; rawBody?: string } = {}) {
  const text = opts.rawBody ?? JSON.stringify(body)
  const bytes = new TextEncoder().encode(text)
  const key = await deriveWorkflowKey(MASTER, opts.keyFor ?? HASHID)
  return new Request(`https://ops.test/porting/capture/${opts.hashid ?? HASHID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-porting-signature': await signBody(key, bytes) },
    body: bytes,
  })
}

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => JSON.stringify(x)).join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => JSON.stringify(x)).join(' ')))
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => JSON.stringify(x)).join(' ')))
})
afterEach(() => vi.restoreAllMocks())

function setup(over: Partial<OpsEnv> = {}, deps: Parameters<typeof createOpsHandler>[0] extends infer D ? Partial<D> : never = {}) {
  const { bucket, objects } = fakeBucket()
  const env = { LANE: 'ops', PORTING_CAPTURE_MASTER: MASTER, PORTING_TEE: bucket as unknown as R2Bucket, ...over } as OpsEnv
  const handler = createOpsHandler({ registry, now: () => NOW, ...deps })
  return { env, bucket, objects, call: (req: Request) => handler(req, env) }
}

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error

describe('refusals by name, before any signature work', () => {
  it('refuses when the master secret is unset', async () => {
    const { call, objects } = setup({ PORTING_CAPTURE_MASTER: undefined })
    const res = await call(await signedRequest(envelope()))
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe('master_secret_unset')
    expect(objects.size).toBe(0)
  })

  it('refuses a workflow that is not enrolled', async () => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(envelope({ hashid: 'p_STRANGER' }), { hashid: 'p_STRANGER', keyFor: 'p_STRANGER' }))
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('unknown_workflow')
    expect(objects.size).toBe(0)
  })

  it('refuses a path segment that is not valid percent encoding, by name', async () => {
    const { call, objects } = setup()
    const res = await call(new Request('https://ops.test/porting/capture/p_%E0%A4%A', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('malformed_hashid')
    expect(objects.size).toBe(0)
  })

  it('answers 404 for any other path and 405 for any other method', async () => {
    const { call } = setup()
    expect((await call(new Request('https://ops.test/porting/other', { method: 'POST' }))).status).toBe(404)
    expect((await call(new Request(`https://ops.test/porting/capture/${HASHID}`, { method: 'GET' }))).status).toBe(405)
  })
})

describe('signature first', () => {
  it('refuses an unsigned body and parses, redacts and stores nothing', async () => {
    const redact = vi.fn()
    const { call, bucket, objects } = setup({}, { redact })
    const req = new Request(`https://ops.test/porting/capture/${HASHID}`, { method: 'POST', body: JSON.stringify(envelope()) })
    const parse = vi.spyOn(JSON, 'parse')
    const res = await call(req)
    // Read before res.json() below, which parses the refusal itself.
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toBe('bad_signature')
    expect(redact).not.toHaveBeenCalled()
    expect(bucket.put).not.toHaveBeenCalled()
    expect(objects.size).toBe(0)
  })

  it("refuses a body signed with another workflow's key", async () => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(envelope(), { keyFor: 'p_OTHER' }))
    expect(res.status).toBe(401)
    expect(objects.size).toBe(0)
  })

  it('refuses an oversized body by name, reading no further than the limit', async () => {
    const { call, objects } = setup()
    const big = 'x'.repeat(2 * 1024 * 1024)
    const res = await call(await signedRequest(null, { rawBody: JSON.stringify(envelope({ payload: big })) }))
    expect(res.status).toBe(413)
    expect(await errorOf(res)).toBe('body_too_large')
    expect(objects.size).toBe(0)
  })

  it('refuses a signed body that is not JSON, after the signature passed', async () => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(null, { rawBody: 'not json' }))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('malformed_body')
    expect(objects.size).toBe(0)
  })

  it('refuses a body naming a different workflow than its path', async () => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(envelope({ hashid: 'p_OTHER' })))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('hashid_mismatch')
    expect(objects.size).toBe(0)
  })
})

describe('storing a capture', () => {
  it('writes the redacted capture at tee/<hashid>/<event_id>/<kind>/<seq>.json', async () => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(envelope()))
    expect(res.status).toBe(202)
    const key = `tee/${HASHID}/evt_abc123/terminal/1759320000000.0.k3j2h1.json`
    expect([...objects.keys()]).toEqual([key])
    const stored = JSON.parse(objects.get(key)!.body) as Record<string, unknown>
    expect(stored).toMatchObject({ event_id: 'evt_abc123', kind: 'terminal', site: 'main/end', v: 1, quarantined: false, received_at: new Date(NOW).toISOString() })
    expect(stored.redacted_count).toBe(2)
    expect(JSON.stringify(stored)).not.toContain('sekrit-value')
    expect(JSON.stringify(stored)).not.toContain('hunter2')
    expect((stored.payload as { lead: unknown }).lead).toEqual({ email: 'a@example.test' })
  })

  it('never overwrites a capture already stored under the same key', async () => {
    const { call, objects } = setup()
    expect((await call(await signedRequest(envelope()))).status).toBe(202)
    const first = [...objects.values()][0].body
    const second = await call(await signedRequest(envelope({ payload: { different: true } })))
    expect(second.status).toBe(200)
    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBe(true)
    expect(objects.size).toBe(1)
    expect([...objects.values()][0].body).toBe(first)
  })

  it('keeps the first of two concurrent captures under one key', async () => {
    const { call, objects, bucket } = setup()
    // The race a read then write has: both requests read before either writes.
    // A head call here waits until both have been made; a handler that never
    // reads first is unaffected.
    let heads = 0
    let release: () => void = () => {}
    const bothRead = new Promise<void>((resolve) => { release = resolve })
    bucket.head.mockImplementation(async (key: string) => {
      const exists = objects.has(key)
      if (++heads === 2) release()
      await bothRead
      return exists ? { key } : null
    })
    // And both writes arrive before either is applied, so only the store's own
    // conditional write can keep the first: a handler that writes without onlyIf
    // overwrites here, whether or not it read first.
    const realPut = bucket.put.getMockImplementation()!
    let puts = 0
    let releasePuts: () => void = () => {}
    const bothWriting = new Promise<void>((resolve) => { releasePuts = resolve })
    bucket.put.mockImplementation(async (...args: Parameters<typeof realPut>) => {
      const turn = ++puts
      if (turn === 2) releasePuts()
      await bothWriting
      if (turn === 2) await Promise.resolve()
      return realPut(...args)
    })
    const [a, b] = await Promise.all([
      call(await signedRequest(envelope({ payload: { first: true } }))),
      call(await signedRequest(envelope({ payload: { second: true } }))),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 202])
    const duplicate = a.status === 200 ? a : b
    expect(((await duplicate.json()) as { duplicate?: boolean }).duplicate).toBe(true)
    expect(objects.size).toBe(1)
    const stored = JSON.parse([...objects.values()][0].body) as { payload: Record<string, boolean> }
    expect(stored.payload).toEqual(a.status === 202 ? { first: true } : { second: true })
  })

  it('writes with onlyIf etagDoesNotMatch, so the store refuses an overwrite rather than a prior read', async () => {
    const { call, bucket } = setup()
    await call(await signedRequest(envelope()))
    expect(bucket.put.mock.calls[0][2]).toMatchObject({ onlyIf: { etagDoesNotMatch: '*' } })
  })

  it('quarantines an unknown capture version: stored and flagged, never dropped', async () => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(envelope({ v: 7 })))
    expect(res.status).toBe(202)
    const [key] = [...objects.keys()]
    expect(key).toBe(`quarantine/${HASHID}/evt_abc123/terminal/1759320000000.0.k3j2h1.json`)
    expect(objects.get(key)!.customMetadata).toMatchObject({ quarantined: 'unknown_capture_version' })
    expect(JSON.stringify(objects.get(key)!.body)).not.toContain('hunter2')
  })

  it.each([
    ['a missing event id', { event_id: null }],
    ['an event id that is not a safe key segment', { event_id: '../../etc' }],
    ['an unknown kind', { kind: 'finished' }],
    ['an unsafe sequence', { seq: 'a/b' }],
  ])('quarantines %s under a safe key rather than dropping it', async (_label, over) => {
    const { call, objects } = setup()
    const res = await call(await signedRequest(envelope(over)))
    expect(res.status).toBe(202)
    const [key] = [...objects.keys()]
    expect(key).toMatch(new RegExp(`^quarantine/${HASHID}/[A-Za-z0-9_-]+/[a-z_]+/[A-Za-z0-9._-]+\\.json$`))
  })

  it('refuses the write, by name, when redaction throws', async () => {
    const { call, objects } = setup({}, { redact: vi.fn(async () => { throw new Error('boom with hunter2 inside') }) })
    const res = await call(await signedRequest(envelope()))
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('redaction_failed')
    expect(objects.size).toBe(0)
    expect(logs.join('\n')).toContain('redaction_failed')
  })

  it('refuses by name when the bucket write fails, and says nothing of the error', async () => {
    const { call, bucket } = setup()
    bucket.put.mockRejectedValueOnce(new Error('r2 down with hunter2'))
    const res = await call(await signedRequest(envelope()))
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe('store_failed')
  })
})

describe('logging', () => {
  it('never logs a body, a payload value or an error message', async () => {
    const { call, bucket } = setup()
    await call(await signedRequest(envelope()))
    bucket.put.mockRejectedValueOnce(new Error('r2 down with hunter2'))
    await call(await signedRequest(envelope({ seq: '2.0.x' })))
    await call(await signedRequest(null, { rawBody: '{"password":"hunter2hunter2"' }))
    const all = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(all).not.toContain('hunter2')
    expect(all).not.toContain('sekrit')
    expect(all).not.toContain('a@example.test')
    expect(all).not.toContain('r2 down')
  })
})
