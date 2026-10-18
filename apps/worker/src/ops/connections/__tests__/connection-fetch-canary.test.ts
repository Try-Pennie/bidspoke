import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import { LoginMintError } from '../refusals'
import {
  ACCESS_TOKEN, CONN, LOGIN_SECRET, ORG, RENEWED_TOKEN, exampleRules, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText,
  type Doubles, type Recorder, type TestKeys,
} from './harness'

/**
 * The canary (#2335, finding F120). A known login and a known token go into a
 * connection bound request; on every FAILURE path they must be absent from
 * everything that can leave the ops Worker:
 *
 * - the thrown error's name, message, stack and own properties. Workers Logs
 *   (wrangler.ops.toml: invocation_logs, head_sampling_rate 1) and the tail
 *   trace bidspoke-worker-tail receives both record an uncaught exception's
 *   name and message with no console call at all, so a ban on console.* alone
 *   does not protect them;
 * - the console, which feeds the same two places;
 * - the recorded request, which becomes the step record and the send ledger;
 * - the needs_reauth cause written to the ops database, and the reports.
 *
 * The three paths F120 names: a token endpoint error echoing the request, a 401
 * on the request with the token echoed back, and a network throw naming a URL
 * that carries the token. The stored step error and the run record do not exist
 * until the ops executor (Phase 9), whose own canary covers them.
 */

const SECRETS = [LOGIN_SECRET, ACCESS_TOKEN, RENEWED_TOKEN]

let keys: TestKeys
let envelope: SealedEnvelope
const consoleLines: string[] = []

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { plaintext: JSON.stringify({ api_key: LOGIN_SECRET }) })
}, 120_000)

beforeEach(() => {
  consoleLines.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (a instanceof Error ? visibleText(a) : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function call(rec: Recorder, overrides: Partial<ConnectionCall> = {}): ConnectionCall {
  return { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'lookup', record: async (r) => { rec.recorded.push(r) }, ...overrides }
}

/** Everything the canary must be absent from, after one call. */
function everythingThatLeaves(d: Doubles, err: unknown): string {
  return [visibleText(err), consoleLines.join('\n'), JSON.stringify(d.rec.recorded), JSON.stringify(d.rec.needsReauth), JSON.stringify(d.rec.reports)].join('\n')
}

function expectNoCanary(text: string) {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret)
    expect(text).not.toContain(encodeURIComponent(secret))
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

describe('the canary never leaves connectionFetch on a failure path (F120)', () => {
  it('a token endpoint error that echoes the request (refused login)', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, async () => {
      throw new LoginMintError('refused', `invalid_client: client_secret=${LOGIN_SECRET} assertion=${ACCESS_TOKEN}`)
    })])
    const err = await caught(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(d.rec.needsReauth).toHaveLength(1)
    expectNoCanary(everythingThatLeaves(d, err))
  })

  it('a token endpoint that fails with an ordinary Error naming the token in its message and cause', async () => {
    const inner = new Error(`POST https://login.example.test/token?refresh_token=${LOGIN_SECRET} failed`)
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, async () => {
      throw new Error(`mint failed for ${ACCESS_TOKEN}`, { cause: inner })
    })])
    const err = await caught(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expectNoCanary(everythingThatLeaves(d, err))
  })

  it('a 401 on the request with the token echoed back, twice (needs_reauth)', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(() => new Response(JSON.stringify({ error: 'invalid_token', presented: `Bearer ${ACCESS_TOKEN}`, renewed: RENEWED_TOKEN }), { status: 401 }))
    const err = await caught(connectionFetch(d.deps, call(d.rec), `https://api.example.test/x?access_token=${ACCESS_TOKEN}`, {
      method: 'POST', body: JSON.stringify({ refresh_token: LOGIN_SECRET, q: 1 }),
    }))
    expect(d.rec.sent).toHaveLength(2)
    expect(d.rec.recorded).toHaveLength(2)
    expectNoCanary(everythingThatLeaves(d, err))
  })

  it('a network throw whose message names a URL carrying the token', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new TypeError(`fetch failed: https://api.example.test/x?key=${ACCESS_TOKEN} (login ${LOGIN_SECRET})`))
    const err = await caught(connectionFetch(d.deps, call(d.rec), `https://api.example.test/x?key=${ACCESS_TOKEN}`))
    expectNoCanary(everythingThatLeaves(d, err))
  })

  it('a recorder that fails with the request in its message', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    const err = await caught(connectionFetch(d.deps, call(d.rec, { record: async () => { throw new Error(`ledger refused ${LOGIN_SECRET}`) } }), 'https://api.example.test/x'))
    expectNoCanary(everythingThatLeaves(d, err))
  })

  it('a timeout while the token is on the request', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.deps.deadlineMs = 20
    d.deps.fetch = (input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException(`aborted ${String(input)} ${ACCESS_TOKEN}`, 'AbortError')))
    })
    const err = await caught(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expectNoCanary(everythingThatLeaves(d, err))
  })

  it('connectionFetch itself writes nothing to the console on any of these paths', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new TypeError('fetch failed'))
    await caught(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(consoleLines).toEqual([])
  })

  it('the canary is really in play: the request was sent with it, so its absence above is not vacuous', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('expired', { status: 401 }))
    await caught(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(JSON.stringify(d.rec.sent.map((s) => new Headers(s.init.headers).get('authorization')))).toContain(ACCESS_TOKEN)
    expect(JSON.parse(d.rec.authorizeCalls[0].login.plaintext)).toEqual({ api_key: LOGIN_SECRET })
  })
})
