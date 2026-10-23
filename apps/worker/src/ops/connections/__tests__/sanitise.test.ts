import { describe, expect, it } from 'vitest'
import { REDACTED, credentialSecretsOfLogin, isTokenName, sanitiseRequest, scrubResponse, scrubSecrets, secretsOfLogin } from '../sanitise'

/**
 * The request sanitiser (#2335, finding F120). What a connection bound request
 * looks like once it is safe to record: no Authorization or other credential
 * header, no token query parameter, no token body field, and no known secret
 * anywhere in what is left.
 */

const TOKEN = 'canary-token-5b9e2f0c7d1a'

describe('isTokenName', () => {
  it.each([
    'access_token', 'refresh_token', 'id_token', 'token', 'client_secret', 'client_assertion', 'assertion', 'api_key', 'apikey',
    'key', 'password', 'secret', 'code', 'code_verifier', 'signature', 'sig', 'Authorization', 'private_key', 'X-Api-Key', 'sessionId',
  ])('names %s as a token', (name) => {
    expect(isTokenName(name)).toBe(true)
  })

  it.each(['q', 'limit', 'fields', 'sobject', 'name', 'email', 'channel'])('leaves %s alone', (name) => {
    expect(isTokenName(name)).toBe(false)
  })
})

describe('scrubSecrets', () => {
  it('removes each known secret, its URL encoded form and nothing else', () => {
    const secret = 'abc/def+ghi=jkl'
    expect(scrubSecrets(`a ${secret} b ${encodeURIComponent(secret)} c`, [secret])).toBe(`a ${REDACTED} b ${REDACTED} c`)
  })

  it('removes the longer of two overlapping secrets whole', () => {
    expect(scrubSecrets('x tokenvalue123456 y', ['tokenvalue', 'tokenvalue123456'])).toBe(`x ${REDACTED} y`)
  })

  it('ignores a value too short to be a secret, so a word is never mangled', () => {
    expect(scrubSecrets('the ops lane', ['ops'])).toBe('the ops lane')
  })
})

describe('secretsOfLogin', () => {
  it('takes the whole plaintext and every long string inside a JSON login', () => {
    const login = JSON.stringify({ client_id: 'client-id-0001', client_secret: TOKEN, nested: { refresh_token: 'refresh-0002-abcdef' }, n: 3, short: 'ab' })
    const secrets = secretsOfLogin(login)
    expect(secrets).toContain(login)
    expect(secrets).toContain(TOKEN)
    expect(secrets).toContain('refresh-0002-abcdef')
    expect(secrets).toContain('client-id-0001')
    expect(secrets).not.toContain('ab')
  })

  it('takes a plain text login whole', () => {
    expect(secretsOfLogin(TOKEN)).toEqual([TOKEN])
  })
})

describe('sanitiseRequest', () => {
  it('drops credential headers and keeps the rest', () => {
    const recorded = sanitiseRequest({
      method: 'POST',
      url: 'https://api.example.test/v1/items',
      headers: new Headers({ authorization: `Bearer ${TOKEN}`, 'x-api-key': TOKEN, cookie: `s=${TOKEN}`, 'content-type': 'application/json', accept: 'application/json' }),
      body: null,
    }, [TOKEN], 1)
    expect(recorded.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json' })
    expect(JSON.stringify(recorded)).not.toContain(TOKEN)
  })

  it('redacts token query parameters and a known secret in the path', () => {
    const recorded = sanitiseRequest({
      method: 'GET',
      url: `https://api.example.test/hooks/${TOKEN}/send?access_token=${TOKEN}&q=open&api_key=other-secret-value`,
      headers: new Headers(),
      body: null,
    }, [TOKEN], 1)
    expect(recorded.url).toBe(`https://api.example.test/hooks/${REDACTED}/send?access_token=${REDACTED}&q=open&api_key=${REDACTED}`)
  })

  it('redacts token fields at any depth of a JSON body', () => {
    const body = JSON.stringify({ name: 'Ada', auth: { refresh_token: 'r-1', client_secret: 's-1' }, rows: [{ password: 'p-1', city: 'Leeds' }] })
    const recorded = sanitiseRequest({ method: 'POST', url: 'https://api.example.test/x', headers: new Headers({ 'content-type': 'application/json' }), body }, [], 1)
    expect(JSON.parse(recorded.body!)).toEqual({ name: 'Ada', auth: REDACTED, rows: [{ password: REDACTED, city: 'Leeds' }] })
  })

  it('redacts token fields of a form body, as text or as URLSearchParams', () => {
    const form = 'grant_type=client_credentials&client_id=abc&client_secret=xyz&scope=read'
    const asText = sanitiseRequest({ method: 'POST', url: 'https://login.example.test/token', headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }), body: form }, [], 1)
    expect(asText.body).toBe(`grant_type=client_credentials&client_id=abc&client_secret=${REDACTED}&scope=read`)
    const asParams = sanitiseRequest({ method: 'POST', url: 'https://login.example.test/token', headers: new Headers(), body: new URLSearchParams(form) }, [], 1)
    expect(asParams.body).toBe(asText.body)
  })

  it('scrubs a known secret from a body that is neither JSON nor a form', () => {
    const recorded = sanitiseRequest({ method: 'POST', url: 'https://api.example.test/x', headers: new Headers({ 'content-type': 'text/plain' }), body: `hello ${TOKEN}` }, [TOKEN], 1)
    expect(recorded.body).toBe(`hello ${REDACTED}`)
  })

  it('never reads a stream or form data body, and names what it was', () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(TOKEN)); c.close() } })
    expect(sanitiseRequest({ method: 'POST', url: 'https://api.example.test/x', headers: new Headers(), body: stream }, [], 1).body).toBe('[stream]')
    const fd = new FormData()
    fd.set('password', TOKEN)
    expect(sanitiseRequest({ method: 'POST', url: 'https://api.example.test/x', headers: new Headers(), body: fd }, [], 1).body).toBe('[form data]')
  })

  it('decodes a byte body that is text, and names one that is not', () => {
    const text = sanitiseRequest({ method: 'POST', url: 'https://api.example.test/x', headers: new Headers(), body: new TextEncoder().encode(`{"token":"${TOKEN}"}`) }, [], 1)
    expect(text.body).toBe(`{"token":"${REDACTED}"}`)
    const binary = sanitiseRequest({ method: 'POST', url: 'https://api.example.test/x', headers: new Headers(), body: new Uint8Array([0xff, 0xfe, 0x00]) }, [], 1)
    expect(binary.body).toBe('[binary 3 bytes]')
  })

  it('records the method upper case and the attempt', () => {
    const recorded = sanitiseRequest({ method: 'patch', url: 'https://api.example.test/x', headers: new Headers(), body: undefined }, [], 2)
    expect(recorded).toEqual({ method: 'PATCH', url: 'https://api.example.test/x', headers: {}, body: null, attempt: 2 })
  })
})

// #2339: a service that echoes the login it was sent (in a body, an error text
// or a header) must not hand it to the action that called it, whose output and
// error a run stores and logs.
describe('credentialSecretsOfLogin', () => {
  it('takes the whole login and every value under a credential named key, at any depth', () => {
    const login = JSON.stringify({ api_key: TOKEN, nested: { refresh_token: 'refresh-0002-abcdef', private_key: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n' } })
    const secrets = credentialSecretsOfLogin(login)
    expect(secrets).toEqual(expect.arrayContaining([login, TOKEN, 'refresh-0002-abcdef', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n']))
  })

  it('leaves the public fields of a login alone, so a response naming the same domain or account is not mangled', () => {
    const google = JSON.stringify({
      type: 'service_account', project_id: 'pennie-ops-1234', private_key: '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n',
      client_email: 'ops@pennie-ops-1234.iam.gserviceaccount.com', client_id: '1234567890123', universe_domain: 'googleapis.com',
    })
    const secrets = credentialSecretsOfLogin(google)
    for (const open of ['service_account', 'pennie-ops-1234', 'ops@pennie-ops-1234.iam.gserviceaccount.com', '1234567890123', 'googleapis.com']) {
      expect(secrets, open).not.toContain(open)
    }
  })

  it('takes a plain text login whole', () => {
    expect(credentialSecretsOfLogin(TOKEN)).toEqual([TOKEN])
  })
})

describe('scrubResponse', () => {
  const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer())

  it('removes a known secret from the body as written, URL encoded and JSON escaped, and from every header', async () => {
    const key = 'line-one-secret\nline-two-secret'
    const echoed = new Response(`{"echo":"Bearer ${TOKEN}","q":"${encodeURIComponent(TOKEN)}","key":${JSON.stringify(key)}}`, {
      status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': `Bearer realm="x", token="${TOKEN}"`, 'x-request-id': 'r-1' },
    })
    const clean = await scrubResponse(echoed, [TOKEN, key])
    expect([clean.status, clean.statusText]).toEqual([401, 'Unauthorized'])
    expect(await clean.text()).toBe(`{"echo":"Bearer ${REDACTED}","q":"${REDACTED}","key":"${REDACTED}"}`)
    expect(clean.headers.get('www-authenticate')).toBe(`Bearer realm="x", token="${REDACTED}"`)
    expect(clean.headers.get('x-request-id')).toBe('r-1')
  })

  it('keeps every other byte of a binary body exactly, and drops the length the scrub may have changed', async () => {
    const head = [0xff, 0xfe, 0x00, 0x80]
    const tail = [0xc3, 0x28, 0x01]
    const body = new Uint8Array([...head, ...new TextEncoder().encode(TOKEN), ...tail])
    const clean = await scrubResponse(new Response(body, { headers: { 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' } }), [TOKEN])
    expect([...await bytes(clean)]).toEqual([...head, ...new TextEncoder().encode(REDACTED), ...tail])
    expect(clean.headers.get('content-length')).toBeNull()
    expect(clean.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('removes every occurrence, back to back ones included, and leaves a near miss that shares only its start', async () => {
    const near = TOKEN.slice(0, -1)
    const clean = await scrubResponse(new Response(`${TOKEN}${TOKEN} ${near}x ${TOKEN}`), [TOKEN])
    expect(await clean.text()).toBe(`${REDACTED}${REDACTED} ${near}x ${REDACTED}`)
  })

  it('answers a body with no secret in it byte for byte, and a bodiless answer as bodiless', async () => {
    const body = new Uint8Array([0, 1, 2, 250, 251])
    expect([...await bytes(await scrubResponse(new Response(body), [TOKEN]))]).toEqual([...body])
    const none = await scrubResponse(new Response(null, { status: 204 }), [TOKEN])
    expect([none.status, none.body]).toEqual([204, null])
  })
})
