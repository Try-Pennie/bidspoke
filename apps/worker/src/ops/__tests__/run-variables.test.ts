/**
 * An ops run's variables (#2998, phase 2 of #2982): what the tick carries in a
 * run's dispatch, what the run records at its first start, what it is given,
 * and how a run the bidding Worker refused is ended.
 */
import { describe, expect, it } from 'vitest'
import { RUN_VARIABLES_REFUSALS } from '../../lib/ops-gateway-contract'
import {
  dispatchedFrom, isDispatchedRunVariables, parseRunVariablesRecord, recordOf, recordRow, refusedRunEnd, runVariablesFor,
  type DispatchedRunVariables,
} from '../run-variables'

const SERVED_AT = '2026-10-29T14:00:00.000Z'
const DISPATCHED: DispatchedRunVariables = {
  source: 'bidding', servedAt: SERVED_AT, values: { API_BASE: 'https://api.example.test', REGION: 'us' }, secretValues: { API_TOKEN: 'sk_live_planted_1' },
}

describe('the variables a run dispatch carries', () => {
  it('is built from a served answer, and read back only in exactly that shape', () => {
    expect(dispatchedFrom({ kind: 'served', workflowId: 'w', versionNumber: 3, values: DISPATCHED.values, secretValues: DISPATCHED.secretValues, servedAt: SERVED_AT }))
      .toEqual(DISPATCHED)
    expect(isDispatchedRunVariables(DISPATCHED)).toBe(true)
    expect(isDispatchedRunVariables(JSON.parse(JSON.stringify(DISPATCHED)))).toBe(true)
    const bads: unknown[] = [
      null, [], 'x',
      { ...DISPATCHED, source: 'copy' },
      { ...DISPATCHED, servedAt: 'yesterday' },
      { ...DISPATCHED, values: { 'not a name': 'x' } },
      { ...DISPATCHED, values: { A: 1 } },
      { ...DISPATCHED, secretValues: [] },
      { ...DISPATCHED, secretValues: { REGION: 'both' } },
      { ...DISPATCHED, extra: true },
      { source: 'bidding', servedAt: SERVED_AT, values: {} },
    ]
    for (const bad of bads) expect(isDispatchedRunVariables(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('the record a run keeps of its variables', () => {
  it('holds the plain values and the secret NAMES only, never a secret value', () => {
    const record = recordOf(DISPATCHED)
    expect(record).toEqual({ source: 'bidding', servedAt: SERVED_AT, values: DISPATCHED.values, secretKeys: ['API_TOKEN'] })
    const row = recordRow(record)
    expect(row).toEqual({ source: 'bidding', served_at: SERVED_AT, values: DISPATCHED.values, secret_keys: ['API_TOKEN'] })
    expect(JSON.stringify(row)).not.toContain('sk_live_planted_1')
  })

  it('reads back the row start_run_execution answers, null as no record, and refuses any other shape by name', () => {
    expect(parseRunVariablesRecord(recordRow(recordOf(DISPATCHED)))).toEqual(recordOf(DISPATCHED))
    expect(parseRunVariablesRecord(null)).toBeNull()
    const row = recordRow(recordOf(DISPATCHED))
    for (const bad of [{ ...row, secret_values: { API_TOKEN: 'x' } }, { ...row, source: 'kv' }, { ...row, secret_keys: 'API_TOKEN' }, { ...row, values: { A: 2 } }, 'x']) {
      expect(() => parseRunVariablesRecord(bad), JSON.stringify(bad)).toThrow(/run_variables/)
    }
  })
})

describe('runVariablesFor: what a run is given', () => {
  const recorded = recordOf(DISPATCHED)

  it('gives the recorded plain values and the secrets served for this start, only those the definition reads', () => {
    expect(runVariablesFor(['API_BASE', 'API_TOKEN'], recorded, DISPATCHED.secretValues)).toEqual({
      env: { API_BASE: 'https://api.example.test', API_TOKEN: 'sk_live_planted_1' }, secrets: { API_TOKEN: 'sk_live_planted_1' },
    })
    expect(runVariablesFor([], null, {})).toEqual({ env: {}, secrets: {} })
  })

  it('uses the plain values recorded at the first start, whatever this start was served', () => {
    // A retry or a continued slice: bidding now serves another value, the record wins.
    expect(runVariablesFor(['API_BASE'], recorded, {})).toEqual({ env: { API_BASE: 'https://api.example.test' }, secrets: {} })
  })

  it('refuses by name a variable that did not exist when the run started', () => {
    expect(runVariablesFor(['API_BASE', 'LIST_ID', 'GONE'], recorded, DISPATCHED.secretValues)).toEqual({
      refused: 'the definition reads env.LIST_ID, env.GONE, which were not variables of this workflow when the run started, so nothing was run; add them and run it again',
    })
    expect(runVariablesFor(['LIST_ID'], recorded, {})).toEqual({
      refused: 'the definition reads env.LIST_ID, which was not a variable of this workflow when the run started, so nothing was run; add it and run it again',
    })
  })

  it('refuses by name a secret the run read when it started that this start was not served', () => {
    expect(runVariablesFor(['API_TOKEN'], recorded, {})).toEqual({
      refused: 'the definition reads the secret variable env.API_TOKEN, which the run read when it started and the bidding Worker did not serve when it started again, so nothing was run',
    })
  })

  it('refuses a definition reading any variable when the run has no record of them', () => {
    expect(runVariablesFor(['API_BASE'], null, {})).toEqual({
      refused: 'the definition reads env.API_BASE, and the run has no record of its variables from when it started, so nothing was run',
    })
  })
})

describe('refusedRunEnd: a run the bidding Worker would not serve variables for', () => {
  it('ends a run of a deleted workflow dead as workflow_deleted, and every other refusal failed, named, nothing run', () => {
    expect(refusedRunEnd({ reason: 'workflow_deleted', keys: [] }, 3)).toEqual({ outcome: 'dead', reason: 'workflow_deleted' })
    for (const reason of RUN_VARIABLES_REFUSALS.filter((r) => r !== 'workflow_deleted')) {
      const end = refusedRunEnd({ reason, keys: reason === 'secret_unreadable' ? ['API_TOKEN', 'PASS'] : [] }, 3)
      expect(end, reason).toMatchObject({ outcome: 'failed' })
      expect(end.outcome === 'failed' && end.error, reason).toMatch(new RegExp(`^variables_refused \\(${reason}\\): .*nothing was run$`))
      expect('reason' in end && end.reason, reason).toBeFalsy()
    }
    expect(refusedRunEnd({ reason: 'secret_unreadable', keys: ['API_TOKEN', 'PASS'] }, 3)).toEqual({
      outcome: 'failed', error: 'variables_refused (secret_unreadable): the secret variables env.API_TOKEN, env.PASS would not decrypt on the bidding Worker, so nothing was run',
    })
    expect(refusedRunEnd({ reason: 'version_missing', keys: [] }, 3)).toEqual({
      outcome: 'failed', error: 'variables_refused (version_missing): the bidding Worker holds no version 3 of this workflow, so nothing was run',
    })
  })
})
