import { describe, expect, it } from 'vitest'
import { deriveWorkflowKey, signBody, verifyBodySignature, SIGNATURE_HEADER } from './signature.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const MASTER = 'master-secret-for-tests-only-0123456789'

describe('per workflow key derivation', () => {
  it('derives a different key per hashid, so one workflow cannot sign for another', async () => {
    const a = await deriveWorkflowKey(MASTER, 'p_AAAA')
    const b = await deriveWorkflowKey(MASTER, 'p_BBBB')
    expect(a).not.toEqual(b)
    expect(a).toEqual(await deriveWorkflowKey(MASTER, 'p_AAAA'))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses an empty master or hashid by name rather than deriving from nothing', async () => {
    await expect(deriveWorkflowKey('', 'p_AAAA')).rejects.toThrow(/master secret is empty/)
    await expect(deriveWorkflowKey(MASTER, '')).rejects.toThrow(/hashid is empty/)
  })
})

describe('the one shared body signature verifier', () => {
  it('names the header it reads', () => {
    expect(SIGNATURE_HEADER).toBe('x-porting-signature')
  })

  it('accepts a body signed with the same key', async () => {
    const key = await deriveWorkflowKey(MASTER, 'p_AAAA')
    const body = enc('{"kind":"start"}')
    const sig = await signBody(key, body)
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/)
    expect(await verifyBodySignature(key, body, sig)).toBe(true)
  })

  it('refuses a body changed by one byte', async () => {
    const key = await deriveWorkflowKey(MASTER, 'p_AAAA')
    const sig = await signBody(key, enc('{"kind":"start"}'))
    expect(await verifyBodySignature(key, enc('{"kind":"stArt"}'), sig)).toBe(false)
  })

  it("refuses another workflow's signature", async () => {
    const a = await deriveWorkflowKey(MASTER, 'p_AAAA')
    const b = await deriveWorkflowKey(MASTER, 'p_BBBB')
    const body = enc('{}')
    expect(await verifyBodySignature(b, body, await signBody(a, body))).toBe(false)
  })

  it.each([
    ['missing', null],
    ['empty', ''],
    ['no version prefix', 'a'.repeat(64)],
    ['unknown version', `v2=${'a'.repeat(64)}`],
    ['not hex', `v1=${'z'.repeat(64)}`],
    ['short', 'v1=abcd'],
    ['odd length', `v1=${'a'.repeat(63)}`],
  ])('fails closed on a %s signature', async (_label, sig) => {
    const key = await deriveWorkflowKey(MASTER, 'p_AAAA')
    expect(await verifyBodySignature(key, enc('{}'), sig)).toBe(false)
  })
})
