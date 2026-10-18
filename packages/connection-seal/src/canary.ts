import type { ConnectionAad } from './canonical-json'

/**
 * The restore drill's canary (#2333).
 *
 * The drill proves the escrowed copy of an ops private key opens what
 * production seals, before any real ops login depends on it (L535, L1).
 * POST /api/admin/seal-canary on the bidding Worker seals this text under this
 * binding and returns the envelope, storing nothing, and
 * scripts/restore-drill/open-seal-canary.ts opens it with the key from
 * 1Password. Both take the text and the binding from here, so they cannot
 * drift apart.
 *
 * The text is not a secret, and says so, so an envelope or a drill transcript
 * holding it is harmless. The binding names the nil organization and
 * connection and a service no login uses, so the cipher refuses to open a
 * canary as any login, or any login as a canary.
 */
export const RESTORE_DRILL_CANARY = 'bidspoke ops key restore drill canary (not a secret)'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** The binding a canary is sealed under, for the kid being drilled. */
export function restoreDrillAad(kid: string): ConnectionAad {
  return {
    organization_id: NIL_UUID,
    connection_id: NIL_UUID,
    service: 'restore-drill-canary',
    generation: 1,
    kid,
  }
}
