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
  source: 'bidding', servedAt: SERVED_AT, values: { API_BASE: 'https://api.example.test', REGION: 'us' }, secretValues: { API_TOKEN: 'fake-planted-secret-value' },
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

  it('carries the kept copy\'s plain values (#2999), and never a secret from it: the copy holds none', () => {
    const fromCopy = { source: 'copy', servedAt: SERVED_AT, values: { API_BASE: 'https://api.example.test' }, secretValues: {} }
    expect(isDispatchedRunVariables(fromCopy)).toBe(true)
    expect(recordOf(fromCopy as DispatchedRunVariables)).toEqual({ source: 'copy', servedAt: SERVED_AT, values: fromCopy.values, secretKeys: [] })
    expect(isDispatchedRunVariables({ ...fromCopy, secretValues: { API_TOKEN: 'fake-planted-secret-value' } })).toBe(false)
    expect(isDispatchedRunVariables({ ...fromCopy, source: 'kv' })).toBe(false)
  })
})

describe('the record a run keeps of its variables', () => {
  it('holds the plain values and the secret NAMES only, never a secret value', () => {
    const record = recordOf(DISPATCHED)
    expect(record).toEqual({ source: 'bidding', servedAt: SERVED_AT, values: DISPATCHED.values, secretKeys: ['API_TOKEN'] })
    const row = recordRow(record)
    expect(row).toEqual({ source: 'bidding', served_at: SERVED_AT, values: DISPATCHED.values, secret_keys: ['API_TOKEN'] })
    expect(JSON.stringify(row)).not.toContain('fake-planted-secret-value')
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
      env: { API_BASE: 'https://api.example.test', API_TOKEN: 'fake-planted-secret-value' }, secrets: { API_TOKEN: 'fake-planted-secret-value' },
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
      // By name, as a field (#3000): the page names them from here, never from the sentence.
      missing: ['LIST_ID', 'GONE'],
    })
    expect(runVariablesFor(['LIST_ID'], recorded, {})).toEqual({
      refused: 'the definition reads env.LIST_ID, which was not a variable of this workflow when the run started, so nothing was run; add it and run it again',
      missing: ['LIST_ID'],
    })
  })

  it('refuses by name a secret the run read when it started that this start was not served', () => {
    expect(runVariablesFor(['API_TOKEN'], recorded, {})).toEqual({
      refused: 'the definition reads the secret variable env.API_TOKEN, which the run read when it started and the bidding Worker did not serve when it started again, so nothing was run',
      missing: ['API_TOKEN'],
    })
  })

  it('refuses a definition reading any variable when the run has no record of them', () => {
    expect(runVariablesFor(['API_BASE'], null, {})).toEqual({
      refused: 'the definition reads env.API_BASE, and the run has no record of its variables from when it started, so nothing was run',
    })
  })
})

describe('refusedRunEnd: a run the bidding Worker would not serve variables for', () => {
  // #3131: every refusal but a deleted workflow fails by name, with the status
  // reason variables_refused and the refusal as typed fields (refusal and
  // refusedVariables), which the minute tick's page names, never the error text.
  it('ends a run of a deleted workflow dead as workflow_deleted, and every other refusal failed as variables_refused, named, nothing run', () => {
    expect(refusedRunEnd({ reason: 'workflow_deleted', keys: [] }, 3)).toEqual({ outcome: 'dead', reason: 'workflow_deleted' })
    for (const reason of RUN_VARIABLES_REFUSALS.filter((r) => r !== 'workflow_deleted')) {
      const keys = reason === 'secret_unreadable' ? ['API_TOKEN', 'PASS'] : []
      const end = refusedRunEnd({ reason, keys }, 3)
      expect(end, reason).toMatchObject({ outcome: 'failed', reason: 'variables_refused', refusal: reason, refusedVariables: keys })
      expect(end.outcome === 'failed' && end.error, reason).toMatch(new RegExp(`^variables_refused \\(${reason}\\): .*nothing was run$`))
    }
    expect(refusedRunEnd({ reason: 'secret_unreadable', keys: ['API_TOKEN', 'PASS'] }, 3)).toEqual({
      outcome: 'failed', reason: 'variables_refused', refusal: 'secret_unreadable', refusedVariables: ['API_TOKEN', 'PASS'],
      error: 'variables_refused (secret_unreadable): the secret variables env.API_TOKEN, env.PASS would not decrypt on the bidding Worker, so nothing was run',
    })
    expect(refusedRunEnd({ reason: 'version_missing', keys: [] }, 3)).toEqual({
      outcome: 'failed', reason: 'variables_refused', refusal: 'version_missing', refusedVariables: [],
      error: 'variables_refused (version_missing): the bidding Worker holds no version 3 of this workflow, so nothing was run',
    })
  })

  it('copies the refused names, so a later change to the answer\'s list cannot change the end', () => {
    const keys = ['API_TOKEN']
    const end = refusedRunEnd({ reason: 'secret_unreadable', keys }, 3)
    keys.push('LATER')
    expect(end).toMatchObject({ refusedVariables: ['API_TOKEN'] })
  })
})
