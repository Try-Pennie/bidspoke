import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { fakeHttp, HOST, json, text } from './fake-http'

/**
 * The HTTP actions (#2337), ported from Pipedream's HTTP steps. In the export
 * of 2026-09-30 (the duplicate project folder left out, steps inside if/else
 * branches counted): http-custom-request 638 steps in 188 workflows (62
 * disabled), http-post-request 5 steps in 3 workflows, http-get-request none.
 * The export redacts every one of their settings, so which method, host or key
 * each uses is read off Pipedream when the workflow is ported. Pipedream's POST
 * request is its custom request with POST chosen (post-request.mjs spreads
 * custom-request.mjs), so it ports to http.custom-request with method POST.
 * http.get-request exists for its traits: a GET is safe by HTTP's own
 * definition, so it has no side effect and is retried, where a custom request
 * is neither.
 *
 * Fixtures every service PR carries: an expired or refused key (401, 403), a
 * 429 with Retry-After, a timeout after send, and a host outside the declared one.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const GET = action('http.get-request')
const CUSTOM = action('http.custom-request')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const POST: ActionArgs = { method: 'POST', url: '/v2/leads', body: { first_name: 'Sam', amount: 12000 } }

describe('the HTTP actions decide their own traits', () => {
  it('are a GET request and a custom request, and nothing else', () => {
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('http.'))).toEqual(['http.get-request@1', 'http.custom-request@1'])
  })

  it('a GET request has no side effect and is retried, since HTTP defines GET as safe', () => {
    expect([GET.sideEffect, GET.idempotent]).toEqual([false, true])
    expect(GET.idempotentBecause).toMatch(/safe/)
  })

  it('a custom request is side effecting and never repeated after an uncertain outcome, whatever its method', () => {
    expect([CUSTOM.sideEffect, CUSTOM.idempotent]).toEqual([true, false])
    expect(CUSTOM.idempotentBecause).toMatch(/method/)
  })

  it('take what Pipedream offered, by these names', () => {
    const shape = (a: RuntimeAction) => Object.fromEntries(a.arguments.map((x) => [x.key, [x.type, x.required, x.allowsVariables, x.parseJson]]))
    expect(shape(GET)).toEqual({
      url: ['text', true, true, false],
      query: ['text', false, true, true],
      headers: ['text', false, true, true],
      include_headers: ['text', false, false, true],
    })
    expect(shape(CUSTOM)).toEqual({
      method: ['text', true, false, false],
      url: ['text', true, true, false],
      query: ['text', false, true, true],
      headers: ['text', false, true, true],
      body: ['text', false, true, true],
      body_text: ['text', false, true, false],
      form: ['text', false, true, true],
      include_headers: ['text', false, false, true],
    })
  })
})

describe('http.get-request@1', () => {
  it('sends one GET to a path on the declared host with its query and headers, and no key of its own, and returns the data', async () => {
    const f = fakeHttp()
    f.respond(json({ id: 'L-1', status: 'open' }))
    const out = await GET.run(f.ctx, { url: '/v2/leads/L-1', query: { expand: 'offers', limit: 5, active: true }, headers: { Accept: 'application/json' } })
    expect(out).toEqual({ id: 'L-1', status: 'open' })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([['GET', `https://${HOST}/v2/leads/L-1?expand=offers&limit=5&active=true`]])
    expect(f.sent[0].headers.get('accept')).toBe('application/json')
    // connectionFetch puts the key on the request: the action never holds it.
    expect(f.sent[0].headers.get('x-partner-key')).toBeNull()
    expect(f.sent[0].body).toBeNull()
  })

  it('takes a whole address on the declared host, keeping its own query beside the step query', async () => {
    const f = fakeHttp()
    f.respond(text('pong'))
    expect(await GET.run(f.ctx, { url: `https://${HOST}/ping?a=1`, query: { b: '2' } })).toBe('pong')
    expect(f.sent[0].url).toBe(`https://${HOST}/ping?a=1&b=2`)
  })

  it('with include_headers, returns the status, the headers and the data together', async () => {
    const f = fakeHttp()
    f.respond(json({ ok: true }, 200, { 'x-request-id': 'r-9' }))
    expect(await GET.run(f.ctx, { url: '/v1/me', include_headers: true })).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'r-9' },
      data: { ok: true },
    })
  })

  it('an empty answer is empty text, and a JSON answer that is not JSON fails by name, not applied', async () => {
    const f = fakeHttp()
    f.respond(new Response(null, { status: 204 }))
    expect(await GET.run(f.ctx, { url: '/v1/me' })).toBe('')
    const g = fakeHttp()
    g.respond(new Response('<html>edge</html>', { status: 200, headers: { 'content-type': 'application/json' } }))
    const failed = await failure(GET.run(g.ctx, { url: '/v1/me' }))
    expect([failed.code, failed.outcome]).toEqual(['http_answer_not_json', 'not_applied'])
    expect(failed.message).not.toContain('edge')
  })

  it('a refused key: what the connection bound fetch throws for a 401 passes through unchanged, and nothing more is sent', async () => {
    const expired = new Error('connection_needs_reauth: request_refused_after_renew')
    const f = fakeHttp()
    f.respond({ throws: expired })
    await expect(GET.run(f.ctx, { url: '/v1/me' })).rejects.toBe(expired)
    expect(f.sent).toHaveLength(1)
  })

  it('a key the API forbids (403) fails by its status, not applied, never quoting the answer', async () => {
    const f = fakeHttp()
    f.respond(json({ error: 'key for Sam Lee is not allowed here' }, 403))
    const failed = await failure(GET.run(f.ctx, { url: '/v1/me' }))
    expect([failed.code, failed.outcome]).toEqual(['http_403', 'not_applied'])
    expect(failed.message).not.toContain('Sam Lee')
  })

  it('a 429 with Retry-After: the requeue passes through unchanged, and nothing waits in the request', async () => {
    const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-23T15:00:20Z') }
    const f = fakeHttp()
    f.respond({ throws: requeue })
    await expect(GET.run(f.ctx, { url: '/v1/me' })).rejects.toBe(requeue)
    expect(f.sent).toHaveLength(1)
  })

  it('a 429 reaching the action is not applied and names the wait', async () => {
    const f = fakeHttp()
    f.respond(json({}, 429, { 'retry-after': '20' }))
    const limited = await failure(GET.run(f.ctx, { url: '/v1/me' }))
    expect([limited.code, limited.outcome]).toEqual(['http_429', 'not_applied'])
    expect(limited.message).toContain('20')
  })

  it('a server error on a read changed nothing, so it is not applied', async () => {
    const f = fakeHttp()
    f.respond(text('down', 503))
    const failed = await failure(GET.run(f.ctx, { url: '/v1/me' }))
    expect([failed.code, failed.outcome]).toEqual(['http_503', 'not_applied'])
  })

  it('a host outside the declared one: the refusal of the connection bound fetch passes through, and the action itself refuses one before sending', async () => {
    const refusal = Object.assign(new Error('evil.example is not among the connection\'s declared hosts'), { code: 'connection_host_not_declared' })
    const f = fakeHttp()
    f.respond({ throws: refusal })
    // The fake stands in for connectionFetch, which refuses before sending; the action names the host it was given.
    const g = fakeHttp()
    const refused = await failure(GET.run(g.ctx, { url: 'https://evil.example/v1/me' }))
    expect([refused.code, refused.outcome]).toEqual(['http_host_not_declared', 'not_applied'])
    expect(g.sent).toEqual([])
    // A step URL on the declared host that the bound fetch still refuses passes its refusal on unchanged.
    await expect(GET.run(f.ctx, { url: '/v1/me' })).rejects.toBe(refusal)
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{}, 'http_url_missing'],
      [{ url: 'v1/me' }, 'http_argument_invalid'],
      [{ url: '//evil.example/x' }, 'http_argument_invalid'],
      [{ url: 'http://api.lender.example/v1' }, 'http_argument_invalid'],
      [{ url: '/v1/me', query: 'a=1' }, 'http_argument_invalid'],
      [{ url: '/v1/me', query: { a: { nested: true } } }, 'http_argument_invalid'],
      [{ url: '/v1/me', headers: ['Accept'] }, 'http_argument_invalid'],
      [{ url: '/v1/me', headers: { 'Bad Header': 'x' } }, 'http_argument_invalid'],
      [{ url: '/v1/me', headers: { Accept: 3 } }, 'http_argument_invalid'],
      [{ url: '/v1/me', headers: { 'X-Note': 'a\r\nb' } }, 'http_argument_invalid'],
      [{ url: '/v1/me', include_headers: 'yes' }, 'http_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeHttp()
      const refused = await failure(GET.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })

  it('refuses a connection whose target declares no usable host, before anything is sent', async () => {
    for (const target of [{}, { host: 'localhost' }, { host: 'api.openai.com' }, null]) {
      const f = fakeHttp(target)
      const refused = await failure(GET.run(f.ctx, { url: '/v1/me' }))
      expect([refused.code, refused.outcome], JSON.stringify(target)).toEqual(['http_target_invalid', 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})

describe('http.custom-request@1', () => {
  it('sends a JSON body with its content type, by the method the step names, and returns the data', async () => {
    const f = fakeHttp()
    f.respond(json({ id: 'L-2' }, 201))
    expect(await CUSTOM.run(f.ctx, POST)).toEqual({ id: 'L-2' })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([['POST', `https://${HOST}/v2/leads`]])
    expect(f.sent[0].headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(f.sent[0].body ?? '')).toEqual({ first_name: 'Sam', amount: 12000 })
  })

  it('takes the method in any case, a text body as written, and a form as url encoded', async () => {
    const f = fakeHttp()
    f.respond(text('ok'), text('ok'))
    await CUSTOM.run(f.ctx, { method: 'put', url: '/v1/notes/1', body_text: 'plain words', headers: { 'Content-Type': 'text/csv' } })
    await CUSTOM.run(f.ctx, { method: 'PATCH', url: '/v1/notes/1', form: { a: 'x y', n: 2 } })
    expect(f.sent.map((s) => [s.method, s.headers.get('content-type'), s.body])).toEqual([
      ['PUT', 'text/csv', 'plain words'],
      ['PATCH', 'application/x-www-form-urlencoded', 'a=x+y&n=2'],
    ])
  })

  it('sends no body with a GET, a HEAD or a DELETE that names none, and returns a HEAD as empty', async () => {
    const f = fakeHttp()
    f.respond(new Response(null, { status: 200 }), json({ deleted: true }))
    expect(await CUSTOM.run(f.ctx, { method: 'HEAD', url: '/v1/me' })).toBe('')
    expect(await CUSTOM.run(f.ctx, { method: 'DELETE', url: '/v1/notes/1' })).toEqual({ deleted: true })
    expect(f.sent.map((s) => [s.method, s.body])).toEqual([['HEAD', null], ['DELETE', null]])
  })

  it('a timeout after send passes through unchanged, for the executor to record as outcome unknown and never retry', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeHttp()
    f.respond({ throws: timeout })
    await expect(CUSTOM.run(f.ctx, POST)).rejects.toBe(timeout)
    expect(f.sent).toHaveLength(1)
    expect(CUSTOM.idempotent).toBe(false)
  })

  it('a server error may have applied the write, so its outcome is unknown; a refusal applied nothing', async () => {
    const f = fakeHttp()
    f.respond(text('oops', 500))
    const failed = await failure(CUSTOM.run(f.ctx, POST))
    expect([failed.code, failed.outcome]).toEqual(['http_500', 'unknown'])
    for (const status of [400, 403, 404, 409, 422]) {
      const g = fakeHttp()
      g.respond(json({ error: 'refused' }, status))
      const refused = await failure(CUSTOM.run(g.ctx, POST))
      expect([refused.code, refused.outcome], String(status)).toEqual([`http_${status}`, 'not_applied'])
    }
  })

  it('a redirect is not followed: on a write its outcome is unknown, since a 303 answers a write that ran', async () => {
    const f = fakeHttp()
    f.respond(new Response(null, { status: 303, headers: { location: 'https://evil.example/x' } }))
    const failed = await failure(CUSTOM.run(f.ctx, POST))
    expect([failed.code, failed.outcome]).toEqual(['http_303', 'unknown'])
    expect(failed.message).not.toContain('evil.example')
    expect(f.sent).toHaveLength(1)
  })

  it('a 2xx it cannot read was applied, so it fails as applied', async () => {
    const f = fakeHttp()
    f.respond(new Response('{"id":', { status: 200, headers: { 'content-type': 'application/json' } }))
    const failed = await failure(CUSTOM.run(f.ctx, POST))
    expect([failed.code, failed.outcome]).toEqual(['http_answer_not_json', 'applied'])
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{ url: '/x' }, 'http_method_missing'],
      [{ method: 'FETCH', url: '/x' }, 'http_argument_invalid'],
      [{ method: 'POST' }, 'http_url_missing'],
      [{ method: 'POST', url: '/x', body: { a: 1 }, body_text: 'b' }, 'http_argument_invalid'],
      [{ method: 'POST', url: '/x', body: { a: 1 }, form: { b: 2 } }, 'http_argument_invalid'],
      [{ method: 'POST', url: '/x', form: ['a'] }, 'http_argument_invalid'],
      [{ method: 'POST', url: '/x', body_text: 3 }, 'http_argument_invalid'],
      [{ method: 'GET', url: '/x', body: { a: 1 } }, 'http_argument_invalid'],
      [{ method: 'HEAD', url: '/x', body_text: 'a' }, 'http_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeHttp()
      const refused = await failure(CUSTOM.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})
