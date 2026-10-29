/**
 * No ops Worker source calls an OpsGateway method the bidding Worker serves
 * ahead of it (#2997, phase 1 of #2982).
 *
 * The ops Worker reaches the bidding Worker's OpsGateway over a service
 * binding, and a method the deployed bidding Worker does not export yet fails
 * every call. So a new method ships on bidding first, listed in
 * OPS_GATEWAY_SERVED_AHEAD and kept off OpsGatewayBinding (the compile time
 * half of this gate), and only the ops change that calls it moves it onto
 * OPS_GATEWAY_METHODS, once the bidding deploy carries it. This is the other
 * half: a call through a cast or an untyped binding, which the compiler cannot
 * see, still names the method. Read from the contract's source, not imported,
 * so the contract's type imports stay out of the web typecheck.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, WORKER_SRC } from '../../__tests__/_scan-utils'

function servedAhead(): string[] {
  const src = readFileSync(path.join(WORKER_SRC, 'lib/ops-gateway-contract.ts'), 'utf8')
  const list = /export const OPS_GATEWAY_SERVED_AHEAD = \[([^\]]*)\] as const/.exec(src)?.[1]
  if (list === undefined) throw new Error('ops-gateway-contract.ts declares no OPS_GATEWAY_SERVED_AHEAD list')
  return [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
}

/** The methods served ahead that a source names as a word. */
const named = (source: string, methods: readonly string[]) => methods.filter((m) => new RegExp(`\\b${m}\\b`).test(source))

describe('OpsGateway methods served ahead of the ops Worker', () => {
  it('reads the list, and finds a call when one is planted', () => {
    expect(servedAhead()).toEqual(['opsRunVariables'])
    expect(named('const answer = await env.OPS_GATEWAY.opsRunVariables(request)', ['opsRunVariables'])).toEqual(['opsRunVariables'])
    expect(named('await (gateway as any)["opsRunVariables"](request)', ['opsRunVariables'])).toEqual(['opsRunVariables'])
    expect(named('await env.OPS_GATEWAY.opsWorkflowDefinitions(request)', ['opsRunVariables'])).toEqual([])
  })

  it('are named by no ops Worker source', () => {
    const methods = servedAhead()
    const files = listFiles(path.join(WORKER_SRC, 'ops'), { exts: ['.ts'] })
    expect(files.length).toBeGreaterThan(20)
    const offenders = files
      .map((f) => ({ file: path.relative(WORKER_SRC, f), names: named(readFileSync(f, 'utf8'), methods) }))
      .filter((o) => o.names.length > 0)
    expect(offenders, 'move the method onto OPS_GATEWAY_METHODS and OpsGatewayBinding once the bidding deploy carries it').toEqual([])
  })
})
