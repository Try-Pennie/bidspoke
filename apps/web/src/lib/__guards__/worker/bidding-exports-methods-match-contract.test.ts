/**
 * The deployed bidding script check (.github/scripts/bidding-exports-gateway.mjs,
 * #2998) requires exactly the OpsGateway methods the ops Worker may call:
 * OPS_GATEWAY_METHODS in the gateway contract, which OpsGatewayBinding is held
 * to at compile time. Read from the contract's source, not imported, because
 * the contract's type imports would pull worker modules into the web typecheck.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'
import { GATEWAY_METHODS, GATEWAY_SPEC } from '../../../../../../.github/scripts/bidding-exports-gateway.mjs'

function contractMethods(): string[] {
  const src = readFileSync(path.join(WORKER_SRC, 'lib/ops-gateway-contract.ts'), 'utf8')
  const list = /export const OPS_GATEWAY_METHODS = \[([^\]]*)\] as const/.exec(src)?.[1]
  if (!list) throw new Error('ops-gateway-contract.ts declares no OPS_GATEWAY_METHODS list')
  return [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
}

describe('the deployed bidding check requires the contract\'s gateway methods', () => {
  it('names OpsGateway and exactly OPS_GATEWAY_METHODS', () => {
    expect(GATEWAY_SPEC.entrypoint).toBe('OpsGateway')
    // opsRunVariables joined the ten in #2998, once #3008's bidding deploy carried it.
    expect(contractMethods()).toHaveLength(11)
    expect([...GATEWAY_METHODS].sort()).toEqual(contractMethods().sort())
  })
})
