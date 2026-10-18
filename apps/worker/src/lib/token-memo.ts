/**
 * One minted token per credential and identity, reused while it has time left
 * (#2335, phase 5 of #1689; the pattern first built for Snowflake in #609).
 *
 * Per isolate and in memory only: it lives as long as the isolate that holds it,
 * which is safe only because reuse is decided by the token's own expiry, never by
 * the invocation. Nothing is handed out with `reuseMarginMs` or less left.
 *
 * The key is (connection_id, generation, sub, scope), so two mailboxes acting
 * through one connection never share a token, and a reconnect (a new generation)
 * never meets the old credential's token.
 *
 * The promise is stored rather than the token, so concurrent callers for one key
 * share one mint (single flight). A mint that fails is removed before any caller
 * sees the failure, so a failure is shared only by the callers who joined that
 * mint, never remembered as a token and never handed to a later caller.
 *
 * The clock is injected (L524): no test of this needs a real sleep or a real time.
 */

export interface TokenMemoKey {
  readonly connectionId: string
  /**
   * The credential's version: an ops connection's generation, or, for an
   * identity configured outside connections (the Snowflake export's key pair),
   * the credential itself, so a rotated credential never meets the old token.
   */
  readonly generation: number | string
  /** Who the token acts as (a mailbox for Google delegation), or '' when the credential has one identity. */
  readonly sub: string
  /** What the token is for (Google's space joined scope list), or '' when the service has no scopes. */
  readonly scope: string
}

export interface Minted<T> {
  readonly value: T
  /**
   * Epoch ms after which the token is no longer valid. A value that is not a
   * finite number is treated as already expired: the token goes to the callers
   * of that mint and is never reused.
   */
  readonly expiresAtMs: number
}

export interface TokenMemoOptions {
  /** Epoch ms. Injected so tests drive time by hand (L524). */
  readonly now?: () => number
  /** How much life an entry must still have to be served. */
  readonly reuseMarginMs: number
}

interface Entry<T> {
  readonly promise: Promise<T>
  /** Set once the mint resolves; absent while it is in flight. */
  settled?: Minted<T>
}

export class TokenMemo<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly now: () => number
  private readonly reuseMarginMs: number

  constructor(opts: TokenMemoOptions) {
    if (!Number.isFinite(opts.reuseMarginMs) || opts.reuseMarginMs < 0) {
      throw new Error(`TokenMemo: reuseMarginMs must be a finite number of 0 or more, got ${opts.reuseMarginMs}`)
    }
    this.now = opts.now ?? Date.now
    this.reuseMarginMs = opts.reuseMarginMs
  }

  /**
   * The token for `key`: the one held, if it is still in flight or has more than
   * the margin left, otherwise a new one from `mint`, which is given the memo's
   * own clock reading so a token it stamps (iat, exp) agrees with the memo.
   */
  get(key: TokenMemoKey, mint: (nowMs: number) => Promise<Minted<T>>): Promise<T> {
    const id = keyOf(key)
    const at = this.now()
    const held = this.entries.get(id)
    if (held && (!held.settled || this.servable(held.settled, at))) return held.promise

    this.dropExpired(at)
    const entry: Entry<T> = {
      promise: new Promise<Minted<T>>((resolve) => resolve(mint(at))).then(
        (minted) => {
          entry.settled = minted
          return minted.value
        },
        (err: unknown) => {
          if (this.entries.get(id) === entry) this.entries.delete(id)
          throw err
        },
      ),
    }
    this.entries.set(id, entry)
    return entry.promise
  }

  /**
   * Drop the entry for `key` only if it still holds `rejected` (compared by
   * identity), for a caller whose request the service refused with its expiry
   * signal. A mint in flight, or a token another caller has minted since, is
   * left alone, so concurrent rejections never evict a fresh token. Answers
   * whether it evicted.
   */
  evictIfHolds(key: TokenMemoKey, rejected: T): boolean {
    const id = keyOf(key)
    const held = this.entries.get(id)
    if (!held?.settled || !Object.is(held.settled.value, rejected)) return false
    this.entries.delete(id)
    return true
  }

  /** How many entries are held, in flight or settled. */
  get size(): number {
    return this.entries.size
  }

  private servable(minted: Minted<T>, at: number): boolean {
    return Number.isFinite(minted.expiresAtMs) && minted.expiresAtMs - at > this.reuseMarginMs
  }

  /** Settled entries already past their expiry are of no use to anyone. */
  private dropExpired(at: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.settled && !(entry.settled.expiresAtMs > at)) this.entries.delete(id)
    }
  }
}

/** JSON keeps the four fields apart whatever they contain, and keeps generation 1 apart from '1'. */
function keyOf(key: TokenMemoKey): string {
  return JSON.stringify([key.connectionId, key.generation, key.sub, key.scope])
}
