/**
 * The key ring a Supabase client's Slack readers open sealed tokens with (#2331).
 *
 * getSlackConnection and readSlackConnectionForLead take a client and an org,
 * and about 45 alert senders across lib and engine call them; none takes env.
 * Rather than thread env through every one, createSupabaseClient registers
 * secretKeys(env) here for every client it builds, keyed on the client in a
 * WeakMap (the same pattern as scheduledSlackFor, lead-read-budget.ts), and
 * the readers look it up. A client built any other way has none, and a sealed
 * row met on it fails by name (slack_key_ring_missing), never as "no Slack".
 */
import type { SecretKeys } from './secret-crypto'

const rings = new WeakMap<object, SecretKeys>()

export function registerSlackKeyRing(client: object, keys: SecretKeys): void {
  rings.set(client, keys)
}

/** The ring registered for `client`, or undefined when none was. */
export function slackKeyRingFor(client: object): SecretKeys | undefined {
  return rings.get(client)
}
