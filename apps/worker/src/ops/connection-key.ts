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
import { importPrivateKey, MIN_MODULUS_BITS, SealError } from '@bidspoke/connection-seal'
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

const isBlank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === ''

/** Each ops private key secret that is unset (the current one only) or does not import, current first. */
export async function opsConnectionKeyProblems(env: OpsEnv): Promise<UnconfiguredSecret[]> {
  const problems: UnconfiguredSecret[] = []
  const current = env.OPS_CONNECTIONS_PRIVATE_KEY
  if (isBlank(current)) {
    problems.push({ secret: CURRENT, problem: `${CURRENT} is not set on bidspoke-worker-ops, so no ops connection can be opened.` })
  } else {
    const p = await importProblem(CURRENT, current as string)
    if (p) problems.push(p)
  }
  const next = env.OPS_CONNECTIONS_PRIVATE_KEY_NEXT
  if (!isBlank(next)) {
    const p = await importProblem(NEXT, next as string)
    if (p) problems.push(p)
  }
  return problems
}
