/**
 * Client side of the alert claim (#1298): the one question a check asks before
 * it posts, "am I the tick that posts this?", answered by a strongly consistent
 * Durable Object rather than by a KV read that two ticks can pass together.
 */
import { formatErr } from './format-error'

export interface AlertClaims {
  /** True for exactly one caller per key per TTL window. */
  claim(key: string, ttlSeconds: number): Promise<boolean>
  /** The claimant could not post; free the key so the next tick can. */
  release(key: string): Promise<void>
}

export function makeAlertClaims(ns: DurableObjectNamespace, now: () => number = Date.now): AlertClaims {
  const stub = (key: string) => ns.get(ns.idFromName(key))
  return {
    async claim(key, ttlSeconds) {
      try {
        const res = await stub(key).fetch('https://do/claim', {
          method: 'POST',
          body: JSON.stringify({ now: now(), ttl_seconds: ttlSeconds }),
        })
        const body = await res.json<{ claimed?: unknown }>()
        return body.claimed === true
      } catch (e) {
        // A claim that cannot be asked must not silence the alert: the KV
        // cooldown still stands behind it, so the worst case is the duplicate
        // this object exists to prevent, never a missing page.
        console.error(`[alert-claim] claim ${key} failed, posting without it: ${formatErr(e)}`)
        return true
      }
    },
    async release(key) {
      try {
        await stub(key).fetch('https://do/release', { method: 'POST' })
      } catch (e) {
        console.error(`[alert-claim] release ${key} failed: ${formatErr(e)}`)
      }
    },
  }
}
