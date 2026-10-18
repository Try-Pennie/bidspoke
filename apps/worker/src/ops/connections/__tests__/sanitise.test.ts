import { describe, expect, it } from 'vitest'
import { REDACTED, isTokenName, sanitiseRequest, scrubSecrets, secretsOfLogin } from '../sanitise'

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
