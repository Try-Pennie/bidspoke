/**
 * The deployed ops script check (.github/scripts/ops-exports-entrypoint.mjs,
 * #2335 PR 9) requires exactly the methods the bidding Worker calls through
 * OPS_CONNECTIONS: OPS_CONNECTIONS_METHODS in the shared contract. Read from the
 * contract's source, not imported, because the contract's type imports would
 * pull worker modules into the web typecheck.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'
import { ENTRYPOINT, METHODS } from '../../../../../../.github/scripts/ops-exports-entrypoint.mjs'

function contractMethods(): string[] {
  const src = readFileSync(path.join(WORKER_SRC, 'lib/ops-connections-contract.ts'), 'utf8')
  const list = /export const OPS_CONNECTIONS_METHODS = \[([^\]]*)\] as const/.exec(src)?.[1]
  if (!list) throw new Error('ops-connections-contract.ts declares no OPS_CONNECTIONS_METHODS list')
  return [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
}

describe('the deployed ops check requires the contract\'s methods', () => {
  it('names OpsConnections and exactly OPS_CONNECTIONS_METHODS', () => {
    expect(ENTRYPOINT).toBe('OpsConnections')
    // The Google list's three joined the six in #2338 build PR 6, once the ops deploy carried them.
    expect(contractMethods()).toHaveLength(9)
    expect([...METHODS].sort()).toEqual(contractMethods().sort())
  })
})
