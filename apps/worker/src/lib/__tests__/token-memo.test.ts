/**
 * TokenMemo (#2335, phase 5 of #1689): one minted token per
 * (connection_id, generation, sub, scope), reused until its expiry less a
 * margin, on an injected clock (L524), with single flight minting.
 *
 * Every test drives the clock by hand and settles mints through deferreds, so
 * nothing here waits on real time.
 */
import { describe, it, expect } from 'vitest'
import { TokenMemo, type Minted, type TokenMemoKey } from '../token-memo'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const KEY: TokenMemoKey = { connectionId: 'conn-1', generation: 3, sub: 'ops@example.com', scope: 'gmail.send' }

/** A mint that counts its calls and hands out tok-1, tok-2, ... valid for `lifetimeMs` from the time it was given. */
function countingMint(lifetimeMs: number) {
  const calls: number[] = []
  const mint = async (nowMs: number): Promise<Minted<string>> => {
    calls.push(nowMs)
    return { value: `tok-${calls.length}`, expiresAtMs: nowMs + lifetimeMs }
  }
  return { mint, calls }
}

describe('TokenMemo reuse and expiry', () => {
  it('mints once and serves the same token while it has more than the margin left', async () => {
    let now = 1_000
    const memo = new TokenMemo<string>({ now: () => now, reuseMarginMs: 100 })
    const { mint, calls } = countingMint(1_000)

    expect(await memo.get(KEY, mint)).toBe('tok-1')
    now = 1_899 // expires at 2_000, 101 left
    expect(await memo.get(KEY, mint)).toBe('tok-1')
    expect(calls).toEqual([1_000])
  })

  it('does not serve an entry once only the margin is left, and hands the mint its own clock', async () => {
    let now = 1_000
    const memo = new TokenMemo<string>({ now: () => now, reuseMarginMs: 100 })
    const { mint, calls } = countingMint(1_000)

    await memo.get(KEY, mint)
    now = 1_900 // exactly the margin left
    expect(await memo.get(KEY, mint)).toBe('tok-2')
    expect(calls).toEqual([1_000, 1_900])
  })

  it('never serves an expired entry, even with no margin', async () => {
    let now = 0
    const memo = new TokenMemo<string>({ now: () => now, reuseMarginMs: 0 })
    const { mint } = countingMint(500)

    await memo.get(KEY, mint)
    now = 499
    expect(await memo.get(KEY, mint)).toBe('tok-1')
    now = 500
    expect(await memo.get(KEY, mint)).toBe('tok-2')
  })

  it('never reuses a token whose mint reported no usable expiry', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    let n = 0
    const mint = async (): Promise<Minted<string>> => ({ value: `tok-${++n}`, expiresAtMs: Number.NaN })

    expect(await memo.get(KEY, mint)).toBe('tok-1')
    expect(await memo.get(KEY, mint)).toBe('tok-2')
  })

  it('refuses a negative margin at construction', () => {
    expect(() => new TokenMemo<string>({ now: () => 0, reuseMarginMs: -1 })).toThrow(/reuseMarginMs/)
  })

  it('drops expired entries of other keys when it mints, so a long lived isolate does not keep every old generation', async () => {
    let now = 0
    const memo = new TokenMemo<string>({ now: () => now, reuseMarginMs: 0 })
    const { mint } = countingMint(100)

    await memo.get({ ...KEY, generation: 1 }, mint)
    await memo.get({ ...KEY, generation: 2 }, mint)
    expect(memo.size).toBe(2)
    now = 100
    await memo.get({ ...KEY, generation: 3 }, mint)
    expect(memo.size).toBe(1)
  })
})

describe('TokenMemo key', () => {
  it('keeps a separate token for each connection, generation, sub and scope', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const { mint, calls } = countingMint(1_000)

    const tokens = await Promise.all([
      memo.get(KEY, mint),
      memo.get({ ...KEY, connectionId: 'conn-2' }, mint),
      memo.get({ ...KEY, generation: 4 }, mint),
      memo.get({ ...KEY, sub: 'other@example.com' }, mint),
      memo.get({ ...KEY, scope: 'drive.readonly' }, mint),
    ])

    expect(new Set(tokens).size).toBe(5)
    expect(calls).toHaveLength(5)
    // The same four fields again, as a new object, share the first token.
    expect(await memo.get({ connectionId: 'conn-1', generation: 3, sub: 'ops@example.com', scope: 'gmail.send' }, mint)).toBe(tokens[0])
    expect(calls).toHaveLength(5)
  })

  it('does not let one field run into the next', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const { mint, calls } = countingMint(1_000)

    await memo.get({ connectionId: 'a', generation: 1, sub: 'b', scope: 'c' }, mint)
    await memo.get({ connectionId: 'a\u00001', generation: 1, sub: 'b', scope: 'c' }, mint)
    await memo.get({ connectionId: 'a', generation: 1, sub: 'b\u0000c', scope: '' }, mint)
    await memo.get({ connectionId: 'a', generation: '1', sub: 'b', scope: 'c' }, mint)

    expect(calls).toHaveLength(4)
  })
})

describe('TokenMemo single flight', () => {
  it('shares one mint between concurrent callers for the same key', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const gate = deferred<Minted<string>>()
    let calls = 0
    const mint = () => {
      calls++
      return gate.promise
    }

    const a = memo.get(KEY, mint)
    const b = memo.get(KEY, mint)
    const c = memo.get(KEY, mint)
    gate.resolve({ value: 'shared', expiresAtMs: 1_000 })

    expect(await Promise.all([a, b, c])).toEqual(['shared', 'shared', 'shared'])
    expect(calls).toBe(1)
  })

  it('does not cache a failed mint as a token, and the next caller mints again', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    let calls = 0
    const mint = async (): Promise<Minted<string>> => {
      calls++
      if (calls === 1) throw new Error('token endpoint refused')
      return { value: 'good', expiresAtMs: 1_000 }
    }

    await expect(memo.get(KEY, mint)).rejects.toThrow('token endpoint refused')
    expect(memo.size).toBe(0)
    expect(await memo.get(KEY, mint)).toBe('good')
    expect(calls).toBe(2)
  })

  it('gives a failure only to the callers who joined that mint, never to a caller after it', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const first = deferred<Minted<string>>()
    let calls = 0
    const mint = () => {
      calls++
      return calls === 1 ? first.promise : Promise.resolve({ value: 'second', expiresAtMs: 1_000 })
    }

    const a = memo.get(KEY, mint)
    const b = memo.get(KEY, mint)
    first.reject(new Error('timed out'))
    await expect(a).rejects.toThrow('timed out')
    await expect(b).rejects.toThrow('timed out')

    expect(await memo.get(KEY, mint)).toBe('second')
    expect(calls).toBe(2)
  })

  it('turns a mint that throws before returning a promise into a rejection, and remembers nothing', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const mint = (): Promise<Minted<string>> => {
      throw new Error('bad key')
    }

    await expect(memo.get(KEY, mint)).rejects.toThrow('bad key')
    expect(memo.size).toBe(0)
  })
})

describe('TokenMemo evictIfHolds', () => {
  it('evicts the entry holding the rejected token, so the next caller mints', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const { mint, calls } = countingMint(1_000)

    const rejected = await memo.get(KEY, mint)
    expect(memo.evictIfHolds(KEY, rejected)).toBe(true)
    expect(await memo.get(KEY, mint)).toBe('tok-2')
    expect(calls).toHaveLength(2)
  })

  it('never evicts a fresher token another caller has just minted', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const { mint } = countingMint(1_000)

    const rejected = await memo.get(KEY, mint)
    memo.evictIfHolds(KEY, rejected)
    const fresh = await memo.get(KEY, mint)

    // A second caller that was rejected with the same old token arrives late.
    expect(memo.evictIfHolds(KEY, rejected)).toBe(false)
    expect(await memo.get(KEY, mint)).toBe(fresh)
  })

  it('never evicts a mint still in flight', async () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    const gate = deferred<Minted<string>>()
    let calls = 0
    const mint = () => {
      calls++
      return gate.promise
    }

    const pending = memo.get(KEY, mint)
    expect(memo.evictIfHolds(KEY, 'old')).toBe(false)
    gate.resolve({ value: 'new', expiresAtMs: 1_000 })
    expect(await pending).toBe('new')
    expect(await memo.get(KEY, mint)).toBe('new')
    expect(calls).toBe(1)
  })

  it('answers false for a key it does not hold', () => {
    const memo = new TokenMemo<string>({ now: () => 0, reuseMarginMs: 0 })
    expect(memo.evictIfHolds(KEY, 'anything')).toBe(false)
  })
})
