/**
 * The ops private key check (#2333, phase 3 of #1689), run on every minute tick.
 *
 * OPS_CONNECTIONS_PRIVATE_KEY opens every ops connection login the bidding
 * Worker sealed to its public half (packages/connection-seal). A key that is
 * unset, or is set but would not import, is found only when the first sealed
 * login is opened, which is a run failing for someone else. So the tick imports
 * it every minute through the same importPrivateKey the opening will use, and
 * an unset or unusable key is reported not_configured, naming the secret, which
 * the bidding Worker pages on with that secret's remedy (lib/ops-gateway.ts).
 *
 * A key that imports may still be the wrong key: any sound RSA-4096 key passes
 * the import, and the bidding Worker seals to the public half committed under
 * CURRENT_OPS_KID (packages/connection-seal/src/keys.ts). So the tick also
 * seals a probe to that public half and opens it with this key, the same two
 * calls a real login takes, and a key that cannot open it is reported the same
 * way. NEXT may be the one that opens it, during a rotation (matchProblem).
 * With no kid current nothing is sealed, so only the import is checked.
 *
 * OPS_CONNECTIONS_PRIVATE_KEY_NEXT exists only during a rotation. Unset is
 * normal; set, it must import too, or the rotation would reseal logins to a key
 * that cannot open them.
 *
 * Nothing here ever carries the key's text: a refusal is reported by its
 * SealError message, which begins with its code (`seal_key_too_small: ...`) and
 * by the seal's own rule holds only sizes and names
 * (packages/connection-seal/src/errors.ts), and any other error by its name
 * alone, never its message.
 */
import {
  CURRENT_OPS_KID,
  importPrivateKey,
  MIN_MODULUS_BITS,
  OPS_CONNECTION_PUBLIC_KEYS,
  open,
  seal,
  SealError,
  type KeyRing,
} from '@bidspoke/connection-seal'
import type { OpsEnv } from './index'
import type { UnconfiguredSecret } from './tick'

const CURRENT = 'OPS_CONNECTIONS_PRIVATE_KEY'
const NEXT = 'OPS_CONNECTIONS_PRIVATE_KEY_NEXT'

async function importProblem(secret: string, value: string): Promise<UnconfiguredSecret | null> {
  try {
    await importPrivateKey(value)
    return null
  } catch (err) {
    const why = err instanceof SealError ? err.message : `an unexpected ${err instanceof Error ? err.name : 'error'}`
    return {
      secret,
      problem: `${secret} is set on bidspoke-worker-ops but does not import as an RSA-OAEP private key of at least ${MIN_MODULUS_BITS} bits (${why}), so no ops connection can be opened with it.`,
    }
  }
}

/** The public keys bidding seals to, and the kid it seals under now. */
export interface SealRegistry {
  currentKid: string | null
  publicKeys: KeyRing
}

const COMMITTED: SealRegistry = { currentKid: CURRENT_OPS_KID, publicKeys: OPS_CONNECTION_PUBLIC_KEYS }

/** A probe bound to no real organization or connection, so it can never stand in for a login. */
const PROBE = 'ops key check'
const probeAad = (kid: string) => ({
  organization_id: '00000000-0000-0000-0000-000000000000',
  connection_id: '00000000-0000-0000-0000-000000000000',
  service: 'ops-key-check',
  generation: 1,
  kid,
})

/** Whether this key opens a probe sealed to the committed public key under kid, and if not, why. */
async function opensProbe(value: string, kid: string, publicKeys: KeyRing): Promise<string | null> {
  try {
    const envelope = await seal(publicKeys, PROBE, probeAad(kid))
    if ((await open({ [kid]: value }, envelope, probeAad(kid))) === PROBE) return null
    return 'the probe opened to different text'
  } catch (err) {
    return err instanceof SealError ? err.message : `an unexpected ${err instanceof Error ? err.name : 'error'}`
  }
}

/**
 * Whether one of the keys that imported opens the current kid. NEXT counts: in
 * rotation step 3 the kid has moved to the new key while it is still held in
 * NEXT, and the opener holds both. Reported on the current secret, whose
 * restore steps are the remedy.
 */
async function matchProblem(keys: { secret: string; value: string }[], registry: SealRegistry): Promise<UnconfiguredSecret | null> {
  const kid = registry.currentKid
  if (kid === null || keys.length === 0) return null
  const why: string[] = []
  for (const k of keys) {
    const refused = await opensProbe(k.value, kid, registry.publicKeys)
    if (refused === null) return null
    why.push(refused)
  }
  const named = keys.length === 1 ? `${CURRENT} is set on bidspoke-worker-ops but is not` : `Neither ${CURRENT} nor ${NEXT} on bidspoke-worker-ops is`
  return {
    secret: CURRENT,
    problem: `${named} the private half of the public key committed as kid ${kid} (${why.join('; ')}), so no login bidding seals can be opened with it.`,
  }
}

const isBlank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === ''

/**
 * Each ops private key secret that is unset (the current one only) or does not
 * import, and, when neither the current key nor NEXT opens the kid bidding
 * seals under, that mismatch on the current one; current first.
 */
export async function opsConnectionKeyProblems(env: OpsEnv, registry: SealRegistry = COMMITTED): Promise<UnconfiguredSecret[]> {
  const problems: UnconfiguredSecret[] = []
  const imported: { secret: string; value: string }[] = []
  const current = env.OPS_CONNECTIONS_PRIVATE_KEY
  if (isBlank(current)) {
    problems.push({ secret: CURRENT, problem: `${CURRENT} is not set on bidspoke-worker-ops, so no ops connection can be opened.` })
  } else {
    const p = await importProblem(CURRENT, current as string)
    if (p) problems.push(p)
    else imported.push({ secret: CURRENT, value: current as string })
  }
  const next = env.OPS_CONNECTIONS_PRIVATE_KEY_NEXT
  let nextProblem: UnconfiguredSecret | null = null
  if (!isBlank(next)) {
    nextProblem = await importProblem(NEXT, next as string)
    if (!nextProblem) imported.push({ secret: NEXT, value: next as string })
  }
  // Only once the current key imported: an unset or broken current key is already named.
  if (imported[0]?.secret === CURRENT) {
    const m = await matchProblem(imported, registry)
    if (m) problems.push(m)
  }
  if (nextProblem) problems.push(nextProblem)
  return problems
}
