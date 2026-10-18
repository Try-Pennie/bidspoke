/**
 * The ops public keys that seal ops connection logins, by kid (#2333).
 *
 * A code constant on purpose: its integrity comes from review. A public key
 * fetched from ops at seal time could be swapped by whoever controls that
 * fetch, and every login sealed afterwards would open for them instead.
 *
 * EMPTY until the ops key pair is generated (a step on the manual steps card).
 * Then the SPKI PEM that `openssl pkey -pubout` writes goes here under a new
 * kid, and CURRENT_OPS_KID names it. Rotation adds the NEXT kid beside it in a
 * normal deploy, and moves CURRENT_OPS_KID once every envelope is resealed.
 *
 * Only ever a PUBLIC key. The private half lives in the ops Worker secret
 * OPS_CONNECTIONS_PRIVATE_KEY and the 1Password item "Bidspoke recovery keys",
 * never here; keys.test.ts scans every file in this package for it.
 */
export const OPS_CONNECTION_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // PENDING (#2333): the first ops public key goes here, under kid 'ops-2026-10',
  // as the full SPKI PEM text `openssl pkey -pubout` writes (one string, its line
  // breaks kept), in the same commit that sets CURRENT_OPS_KID below to
  // 'ops-2026-10'. Only after OPS_CONNECTIONS_PRIVATE_KEY is set on
  // bidspoke-worker-ops from the 1Password copy. keys.test.ts fails a key
  // registered with no current kid, and a current kid with no key.
})

/**
 * The kid new seals use. Null while no key is registered.
 *
 * PENDING (#2333): becomes 'ops-2026-10' with the key above.
 */
export const CURRENT_OPS_KID: string | null = null
