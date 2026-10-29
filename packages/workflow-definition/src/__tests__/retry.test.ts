import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETRY_POLICY,
  RETRY_SECONDS_MAX,
  readRetryPolicy,
  retryDelaySeconds,
  retrySaveProblems,
  validateDefinition,
  type DefinitionVerdict,
} from '../index'

// A workflow's retry setting (#1693, Dan's decision of 2026-10-28): "default to
// 15s, cap 8 minutes", and a way "to not retry at all and just immediately fail".

const reasons = (retry: unknown, lane: 'ops' | 'money' = 'ops') => retrySaveProblems(retry, lane).map((p) => p.reason)

describe('retryDelaySeconds: the wait before each retry after a real failure', () => {
  it('waits 15 s, doubling each time, never more than 8 minutes, by default', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelaySeconds(DEFAULT_RETRY_POLICY, n))
    expect(waits).toEqual([15, 30, 60, 120, 240, 480, 480])
  })

  it('follows a configured base and cap', () => {
    const policy = { mode: 'backoff' as const, baseSeconds: 5, capSeconds: 30 }
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySeconds(policy, n))).toEqual([5, 10, 20, 30, 30])
  })

  it('stays at the cap however many failures, never overflowing', () => {
    expect(retryDelaySeconds(DEFAULT_RETRY_POLICY, 2000)).toBe(480)
    expect(retryDelaySeconds({ mode: 'backoff', baseSeconds: RETRY_SECONDS_MAX, capSeconds: RETRY_SECONDS_MAX }, 1100)).toBe(RETRY_SECONDS_MAX)
  })

  it('reads a failure count under 1 as the first failure', () => {
    expect(retryDelaySeconds(DEFAULT_RETRY_POLICY, 0)).toBe(15)
  })
})

describe('readRetryPolicy: the setting a run is retried by', () => {
  it('is the default when the workflow sets none', () => {
    expect(readRetryPolicy(undefined)).toEqual({ kind: 'ok', policy: { mode: 'backoff', baseSeconds: 15, capSeconds: 480 } })
  })

  it('fills a backoff setting\'s missing numbers from the default', () => {
    expect(readRetryPolicy({ mode: 'backoff' })).toEqual({ kind: 'ok', policy: { mode: 'backoff', baseSeconds: 15, capSeconds: 480 } })
    expect(readRetryPolicy({ mode: 'backoff', base_seconds: 30 })).toEqual({ kind: 'ok', policy: { mode: 'backoff', baseSeconds: 30, capSeconds: 480 } })
    expect(readRetryPolicy({ mode: 'backoff', base_seconds: 2, cap_seconds: 60 })).toEqual({ kind: 'ok', policy: { mode: 'backoff', baseSeconds: 2, capSeconds: 60 } })
  })

  it('reads no retry', () => {
    expect(readRetryPolicy({ mode: 'none' })).toEqual({ kind: 'ok', policy: { mode: 'none' } })
  })

  it('answers a setting the save would refuse as invalid, naming why, never as the default', () => {
    const r = readRetryPolicy({ mode: 'sometimes' })
    expect(r.kind).toBe('invalid')
    expect(r.kind === 'invalid' && r.problems.map((p) => p.reason)).toEqual(['retry_mode_unknown'])
  })
})

describe('retrySaveProblems: a bad setting refused at save by name', () => {
  it('passes an absent setting, the default, a configured backoff and no retry', () => {
    expect(reasons(undefined)).toEqual([])
    expect(reasons({ mode: 'backoff' })).toEqual([])
    expect(reasons({ mode: 'backoff', base_seconds: 1, cap_seconds: RETRY_SECONDS_MAX })).toEqual([])
    expect(reasons({ mode: 'backoff', base_seconds: 60, cap_seconds: 60 })).toEqual([])
    expect(reasons({ mode: 'none' })).toEqual([])
  })

  it('refuses a setting that is not an object', () => {
    for (const bad of [null, 'none', 15, [], true]) expect(reasons(bad)).toEqual(['retry_not_an_object'])
  })

  it('refuses a missing or unknown mode', () => {
    expect(reasons({})).toEqual(['retry_mode_unknown'])
    expect(reasons({ mode: 'exponential' })).toEqual(['retry_mode_unknown'])
  })

  it('refuses a field it does not know, so a misspelt cap is not silently the default', () => {
    expect(reasons({ mode: 'backoff', cap_second: 60 })).toEqual(['retry_field_unknown'])
  })

  it('refuses a base or cap that is not a whole number of seconds from 1 to the ceiling', () => {
    for (const bad of [0, -1, 1.5, RETRY_SECONDS_MAX + 1, '15', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reasons({ mode: 'backoff', base_seconds: bad })).toEqual(['retry_base_invalid'])
      expect(reasons({ mode: 'backoff', cap_seconds: bad })).toEqual(['retry_cap_invalid'])
    }
  })

  it('refuses a base above the cap, including one above the default cap', () => {
    expect(reasons({ mode: 'backoff', base_seconds: 120, cap_seconds: 60 })).toEqual(['retry_base_above_cap'])
    expect(reasons({ mode: 'backoff', base_seconds: 600 })).toEqual(['retry_base_above_cap'])
  })

  it('refuses waits on a setting that never retries, which would read as doing something', () => {
    expect(reasons({ mode: 'none', base_seconds: 15 })).toEqual(['retry_none_takes_no_waits'])
    expect(reasons({ mode: 'none', cap_seconds: 15 })).toEqual(['retry_none_takes_no_waits'])
  })

  it('refuses any retry setting on a money workflow, whose engine does not read it', () => {
    expect(reasons({ mode: 'none' }, 'money')).toEqual(['retry_on_money_lane'])
    expect(reasons({ mode: 'backoff' }, 'money')).toEqual(['retry_on_money_lane'])
    expect(reasons(undefined, 'money')).toEqual([])
  })

  it('says what is wrong in each message', () => {
    const [p] = retrySaveProblems({ mode: 'backoff', base_seconds: 120, cap_seconds: 60 }, 'ops')
    expect(p.message).toContain('120')
    expect(p.message).toContain('60')
  })
})

describe('validateDefinition: the retry rule', () => {
  const trigger = { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } }
  const withRetry = (retry: unknown) => ({ trigger, nodes: [], edges: [], retry })
  const problems = (v: DefinitionVerdict) => (v.kind === 'judged' ? v.problems : [])

  it('refuses a bad setting on every save, by name', () => {
    const found = problems(validateDefinition(withRetry({ mode: 'backoff', base_seconds: 0 }), { lane: 'ops' })).filter((p) => p.rule === 'retry')
    expect(found).toEqual([expect.objectContaining({ rule: 'retry', enforce: 'every_save', severity: 'error', reason: 'retry_base_invalid' })])
  })

  it('finds nothing in a good setting or an absent one', () => {
    expect(problems(validateDefinition(withRetry({ mode: 'none' }), { lane: 'ops' })).filter((p) => p.rule === 'retry')).toEqual([])
    expect(problems(validateDefinition({ trigger, nodes: [], edges: [] }, { lane: 'ops' })).filter((p) => p.rule === 'retry')).toEqual([])
  })
})
