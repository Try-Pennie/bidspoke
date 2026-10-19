/**
 * The bidding Worker's side of the OPS_CONNECTIONS binding (#2335, PR 9 of phase
 * 5 of #1689): every call raced against a per method deadline, and a binding
 * that is absent, throws, never answers or answers something unreadable turned
 * into one named answer, ops_connections_unavailable.
 *
 * What matters, from the plan and the Phase 0 spike (#2330):
 * - a service binding call has no timeout of its own, so a binding double that
 *   never answers must give the named answer at the deadline, not a hung call;
 * - each deadline is longer than the ceiling ops answers by name at
 *   (OPS_CONNECTIONS_CEILINGS_MS), so ops says why before bidding gives up;
 * - a binding to an entrypoint the deployed ops Worker does not export throws a
 *   plain "internal error; reference = <id>": the reference is logged, and
 *   nothing says the ops Worker is down, because the error names no cause.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPS_CONNECTIONS_CEILINGS_MS, OPS_CONNECTIONS_METHODS, OpsConnectionsContractError, parseHealthRequest, type OpsConnectionsBinding,
} from '../ops-connections-contract'
import {
  callOpsConnections, OPS_CONNECTIONS_DEADLINES_MS, OPS_CONNECTIONS_PROBE_EXPECTED, OPS_CONNECTIONS_PROBE_REQUEST, probeOpsConnections,
} from '../ops-connections-client'
import { OpsConnections } from '../../ops/ops-connections-entrypoint'
import type { OpsEnv } from '../../ops/index'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'

/** A binding double: each method answers through `answer`, recording what it was asked. */
function binding(answer: (method: string, request: unknown) => Promise<unknown>) {
  const calls: Array<{ method: string; request: unknown }> = []
  const methods = Object.fromEntries(OPS_CONNECTIONS_METHODS.map((m) => [m, (request: unknown) => {
    calls.push({ method: m, request })
    return answer(m, request)
  }]))
  return { binding: methods as unknown as OpsConnectionsBinding, calls }
}

const never = () => new Promise<never>(() => {})

function captureLogs() {
  const lines: string[] = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  }
  return lines
}

afterEach(() => { vi.restoreAllMocks() })

describe('each per method deadline is longer than the ceiling ops answers by name at', () => {
  it('names a deadline for exactly the methods the contract names', () => {
    expect(Object.keys(OPS_CONNECTIONS_DEADLINES_MS).sort()).toEqual([...OPS_CONNECTIONS_METHODS].sort())
  })

  it.each(OPS_CONNECTIONS_METHODS)('%s: the bidding deadline exceeds the ops ceiling by at least 2 s', (method) => {
    expect(OPS_CONNECTIONS_DEADLINES_MS[method]).toBeGreaterThanOrEqual(OPS_CONNECTIONS_CEILINGS_MS[method] + 2_000)
  })

  it('holds the stated values', () => {
    expect(OPS_CONNECTIONS_DEADLINES_MS).toEqual({ verify: 50_000, clearReauth: 50_000, exchangeOAuthCode: 35_000, lookup: 30_000, revoke: 15_000, health: 15_000 })
  })
})

describe('callOpsConnections', () => {
  it('passes the request to the named method and returns its answer, a refusal included, unchanged', async () => {
    const refusal = { ok: false, refused: 'connection_not_found', detail: 'no copy', retry_at: null }
    const { binding: b, calls } = binding(async () => refusal)
    const answer = await callOpsConnections({ OPS_CONNECTIONS: b }, 'verify', { organization_id: ORG, connection_id: ORG, candidate: null })
    expect(answer).toEqual(refusal)
    expect(calls).toEqual([{ method: 'verify', request: { organization_id: ORG, connection_id: ORG, candidate: null } }])
  })

  it('a binding that never answers gives ops_connections_unavailable at the method\'s deadline, not a hung call', async () => {
    const lines = captureLogs()
    const waited: number[] = []
    const { binding: b } = binding(never)
    const answer = await callOpsConnections({ OPS_CONNECTIONS: b }, 'health', { organization_id: ORG }, { delay: async (ms) => { waited.push(ms) } })
    expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_unavailable', cause: 'deadline', reference: null, retry_at: null })
    expect(waited).toEqual([OPS_CONNECTIONS_DEADLINES_MS.health])
    expect(lines.some((l) => l.includes('"event":"ops_connections_unavailable"') && l.includes('"cause":"deadline"'))).toBe(true)
  })

  it('an absent binding is named, and nothing is called', async () => {
    captureLogs()
    expect(await callOpsConnections({}, 'health', { organization_id: ORG })).toMatchObject({ ok: false, refused: 'ops_connections_unavailable', cause: 'binding_absent' })
  })

  it('a throw is logged with its reference id, never its message, and claims nothing about whether ops is running', async () => {
    const lines = captureLogs()
    const { binding: b } = binding(async () => { throw new Error('internal error; reference = 7a1c9e2b0d4f6a8c; plain-binding-error-canary') })
    const answer = await callOpsConnections({ OPS_CONNECTIONS: b }, 'lookup', { organization_id: ORG, connection_id: ORG, key: 'objects', parents: [] })
    expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_unavailable', cause: 'threw', reference: '7a1c9e2b0d4f6a8c' })
    const logged = lines.join('\n')
    expect(logged).toContain('"reference":"7a1c9e2b0d4f6a8c"')
    expect(logged).toContain('"method":"lookup"')
    expect(logged).not.toContain('plain-binding-error-canary')
    expect(JSON.stringify(answer)).not.toContain('plain-binding-error-canary')
    for (const text of [logged, (answer as { detail: string }).detail]) {
      expect(text).not.toMatch(/\b(down|offline|outage|crashed|unreachable)\b/i)
    }
  })

  it('a throw with no reference says so', async () => {
    captureLogs()
    const { binding: b } = binding(async () => { throw new TypeError('x') })
    expect(await callOpsConnections({ OPS_CONNECTIONS: b }, 'revoke', { organization_id: ORG, connection_id: ORG, generation: 1, removed_at: '2026-10-19T10:00:00.000Z' }))
      .toMatchObject({ refused: 'ops_connections_unavailable', cause: 'threw', reference: null })
  })

  it.each([[null], ['ok'], [{ ok: 'yes' }], [[]], [{ ok: false }]])('an answer that is not the contract\'s (%j) is unreadable, never passed on', async (raw) => {
    captureLogs()
    const { binding: b } = binding(async () => raw)
    expect(await callOpsConnections({ OPS_CONNECTIONS: b }, 'health', { organization_id: ORG })).toMatchObject({ refused: 'ops_connections_unavailable', cause: 'unreadable' })
  })

  it('logs the organization a call was for, and never the request it carried', async () => {
    const lines = captureLogs()
    const { binding: b } = binding(never)
    await callOpsConnections({ OPS_CONNECTIONS: b }, 'exchangeOAuthCode', {
      organization_id: ORG, connection_id: ORG, code: 'plain-oauth-code-canary', verifier: 'v'.repeat(43), redirect_uri: 'https://bidspoke.trypennie.dev/cb',
      candidate: { service: 'gmail', generation: 1, envelope: { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcA==', iv: 'aXY=', ct: 'Y3Q=' }, target: null, public_config: {} },
    }, { delay: async () => {} })
    const logged = lines.join('\n')
    expect(logged).toContain(`"organization_id":"${ORG}"`)
    expect(logged).not.toContain('plain-oauth-code-canary')
  })
})

describe('probeOpsConnections: the post deploy call through the binding', () => {
  it('sends health a request ops refuses before it reads anything', () => {
    expect(() => parseHealthRequest(OPS_CONNECTIONS_PROBE_REQUEST)).toThrow(OpsConnectionsContractError)
    expect(OPS_CONNECTIONS_PROBE_EXPECTED).toBe('ops_connections_request_invalid')
  })

  it('against the real OpsConnections entrypoint, with no ops database configured, it is answered by name: so it reads and writes nothing', async () => {
    captureLogs()
    // No OPS_SUPABASE_* at all: any read would answer ops_connections_not_configured instead.
    const real = new OpsConnections({} as ExecutionContext, { LANE: 'ops' } as OpsEnv)
    const result = await probeOpsConnections({ OPS_CONNECTIONS: real as unknown as OpsConnectionsBinding })
    expect(result).toEqual({ outcome: 'answered', method: 'health', answer: 'ops_connections_request_invalid' })
  })

  it('calls health once, and nothing else', async () => {
    const { binding: b, calls } = binding(async () => ({ ok: false, refused: 'ops_connections_request_invalid', detail: 'x', retry_at: null }))
    await probeOpsConnections({ OPS_CONNECTIONS: b })
    expect(calls).toEqual([{ method: 'health', request: OPS_CONNECTIONS_PROBE_REQUEST }])
  })

  it.each([
    [{ ok: false, refused: 'lane_not_ops', detail: 'x', retry_at: null }, 'lane_not_ops'],
    [{ ok: true, connections: [], reached_limit: false }, 'ok'],
  ])('another answer (%j) is unexpected, named by its code', async (raw, code) => {
    const { binding: b } = binding(async () => raw)
    expect(await probeOpsConnections({ OPS_CONNECTIONS: b })).toEqual({ outcome: 'unexpected', method: 'health', answer: code })
  })

  it('a throw is unavailable, carrying the reference', async () => {
    captureLogs()
    const { binding: b } = binding(async () => { throw new Error('internal error; reference = 0f0e0d0c0b0a') })
    expect(await probeOpsConnections({ OPS_CONNECTIONS: b })).toMatchObject({ outcome: 'unavailable', method: 'health', cause: 'threw', reference: '0f0e0d0c0b0a' })
  })
})
