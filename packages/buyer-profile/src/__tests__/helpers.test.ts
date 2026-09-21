import { describe, expect, it } from 'vitest'
import { canaryBucket } from '../hash'
import { DeadlineError, withDeadline } from '../deadline'
import { buildSalePayload, canonicalBodySha256, SalePayloadError, type SalePayloadSpec } from '../payload'

describe('canaryBucket', () => {
  it('is deterministic and inside 0 to 99', () => {
    for (const key of ['a', 'lead-1', '0f4df7a7-2405-4fc7-9af4-5d5e05ce96c5']) {
      const b = canaryBucket(key)
      expect(b).toBe(canaryBucket(key))
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(100)
    }
  })
  it('spreads UUID shaped keys evenly enough that a percent means a percent', () => {
    const counts = new Array<number>(100).fill(0)
    const n = 20000
    for (let i = 0; i < n; i++) counts[canaryBucket(`4f2a9c1e-5b7d-4e8a-9c21-${String(i).padStart(12, '0')}`)] += 1
    for (const c of counts) {
      expect(c).toBeGreaterThan(n / 100 / 2)
      expect(c).toBeLessThan((n / 100) * 2)
    }
    const admittedAtFive = counts.slice(0, 5).reduce((a, b) => a + b, 0) / n
    expect(admittedAtFive).toBeGreaterThan(0.035)
    expect(admittedAtFive).toBeLessThan(0.065)
  })
})

/** A hand driven timer, so the deadline is proved without waiting (L524). */
function manualTimers() {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    timers: {
      setTimeout: (fn: () => void, _ms: number): number => {
        const id = next++
        pending.set(id, fn)
        return id
      },
      clearTimeout: (id: unknown): void => {
        pending.delete(id as number)
      },
    },
    fire: () => {
      for (const fn of [...pending.values()]) fn()
    },
    pendingCount: () => pending.size,
  }
}

describe('withDeadline', () => {
  it('rejects by name with a DeadlineError when the promise never settles', async () => {
    const { timers, fire } = manualTimers()
    const never = new Promise<string>(() => undefined)
    const guarded = withDeadline(never, 2000, 'ledger.reserve', timers)
    fire()
    await expect(guarded).rejects.toBeInstanceOf(DeadlineError)
    await expect(guarded).rejects.toMatchObject({ name: 'DeadlineError', operation: 'ledger.reserve', ms: 2000 })
  })
  it('resolves with the value and clears its timer when the promise settles first', async () => {
    const { timers, pendingCount } = manualTimers()
    const value = await withDeadline(Promise.resolve('ok'), 2000, 'ledger.reserve', timers)
    expect(value).toBe('ok')
    expect(pendingCount()).toBe(0)
  })
  it('passes the promise rejection through untouched', async () => {
    const { timers } = manualTimers()
    const boom = new Error('upstream')
    await expect(withDeadline(Promise.reject(boom), 2000, 'x', timers)).rejects.toBe(boom)
  })
})

describe('buildSalePayload', () => {
  // The six sources tripoint_ping uses today: the whole trigger payload as the base, four step
  // derived fields, one literal, and the SSN normaliser.
  const context: Record<string, unknown> = {
    '{{trigger.payload}}': {
      personalInformation: { firstName: 'X', ssn: '123-45-6789', state: 'NY' },
      financialInformation: { annualIncome: 50000 },
      leadUuid: 'lead-1',
    },
    '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}': 25000,
    '{{steps.prospect_trades.output.body.tradeCalculations.enrollableDebt}}': 31000,
    '{{steps.create_prospect.output.body.id}}': 'a06masked',
    '{{execution.trace_id}}': 'trace-1',
  }
  const resolve = (template: string): unknown => (template in context ? context[template] : template)
  const spec: SalePayloadSpec = {
    base: '{{trigger.payload}}',
    set: [
      { path: 'unsecuredDebt', template: '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}' },
      { path: 'maxUnsecuredDebt', template: '{{steps.prospect_trades.output.body.tradeCalculations.enrollableDebt}}' },
      { path: 'workflowId', template: 'engine-bidding' },
      { path: 'pennieLeadId', template: '{{steps.create_prospect.output.body.id}}' },
      { path: 'executionId', template: '{{execution.trace_id}}' },
      { path: 'leadType', template: 'prospect' },
    ],
    normalise: [{ path: 'personalInformation.ssn', normaliser: 'ssn_digits_9' }],
  }

  it('builds the body tripoint_ping sends, byte for byte in content', () => {
    expect(buildSalePayload(spec, resolve)).toEqual({
      personalInformation: { firstName: 'X', ssn: '123456789', state: 'NY' },
      financialInformation: { annualIncome: 50000 },
      leadUuid: 'lead-1',
      unsecuredDebt: 25000,
      maxUnsecuredDebt: 31000,
      workflowId: 'engine-bidding',
      pennieLeadId: 'a06masked',
      executionId: 'trace-1',
      leadType: 'prospect',
    })
  })
  it('does not mutate the resolved base object', () => {
    const base = context['{{trigger.payload}}'] as { personalInformation: { ssn: string } }
    buildSalePayload(spec, resolve)
    expect(base.personalInformation.ssn).toBe('123-45-6789')
  })
  it('sets a nested path that does not exist yet', () => {
    const out = buildSalePayload({ ...spec, set: [{ path: 'meta.source.name', template: 'engine' }] }, resolve)
    expect(out).toMatchObject({ meta: { source: { name: 'engine' } } })
  })
  it('normalises an SSN with spaces, an absent SSN, and one that is too long', () => {
    const cases: Array<[unknown, string]> = [['123 45 6789', '123456789'], [undefined, ''], ['1234567890123', '123456789']]
    for (const [ssn, expected] of cases) {
      const local = (t: string) => (t === '{{trigger.payload}}' ? { personalInformation: { ssn } } : resolve(t))
      const out = buildSalePayload({ base: '{{trigger.payload}}', set: [], normalise: spec.normalise }, local) as {
        personalInformation: { ssn: string }
      }
      expect(out.personalInformation.ssn).toBe(expected)
    }
  })
  it('refuses a base that does not resolve to a non empty object, by name (L505)', () => {
    for (const bad of [undefined, null, 'text', 42, [], {}]) {
      const local = (t: string) => (t === '{{trigger.payload}}' ? bad : resolve(t))
      expect(() => buildSalePayload(spec, local)).toThrow(SalePayloadError)
    }
  })
  it('refuses a set entry whose template resolves to undefined rather than sending a hole', () => {
    const local = (t: string) => (t === '{{steps.create_prospect.output.body.id}}' ? undefined : resolve(t))
    expect(() => buildSalePayload(spec, local)).toThrow(SalePayloadError)
  })
})

describe('canonicalBodySha256', () => {
  it('is the same hash whatever the key order', async () => {
    const a = await canonicalBodySha256({ b: 2, a: { d: 4, c: 3 } })
    const b = await canonicalBodySha256({ a: { c: 3, d: 4 }, b: 2 })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  it('changes when a value changes', async () => {
    expect(await canonicalBodySha256({ a: 1 })).not.toBe(await canonicalBodySha256({ a: 2 }))
  })
  it('keeps array order significant', async () => {
    expect(await canonicalBodySha256({ a: [1, 2] })).not.toBe(await canonicalBodySha256({ a: [2, 1] }))
  })
})
