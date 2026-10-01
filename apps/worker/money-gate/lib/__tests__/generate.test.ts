import { describe, it, expect } from 'vitest'
import { buildWorkflowShape } from '../shape'
import { generatePayload } from '../generate'
import { scanForPersonalData } from '../fixture-scan'

const sample = (i: number) => ({
  leadUuid: `7f3c2a10-1b2c-4d5e-8f90-0000000000${10 + i}`,
  personalInformation: {
    firstName: `Name${i}`, email: `p${i}@corp.net`, ssn: `512-44-10${10 + i}`,
    dateOfBirth: '1984-07-19', state: i % 2 ? 'TX' : 'NY', phone: '2125550123', zip: '10001',
  },
  financialInformation: { creditScore: 700 + i, income: 85000.5, debts: [{ amount: 12000, type: 'card' }] },
  optional: i === 0 ? 'rare' : undefined,
  flags: { military: false },
})
const shape = buildWorkflowShape({ workflow_id: 'w', workflow_name: 'w', payloads: Array.from({ length: 8 }, (_, i) => sample(i)) })

describe('generatePayload', () => {
  it('is deterministic for a seed', () => {
    expect(generatePayload(shape, { seed: 'a' })).toEqual(generatePayload(shape, { seed: 'a' }))
  })

  it('rebuilds the nested structure, arrays included, from the field paths', () => {
    const p = generatePayload(shape, { seed: 'a' }) as Record<string, any>
    expect(typeof p.personalInformation.firstName).toBe('string')
    expect(Array.isArray(p.financialInformation.debts)).toBe(true)
    expect(typeof p.financialInformation.debts[0].amount).toBe('number')
    expect(p.flags.military).toBe(false)
    expect(p.personalInformation.email).toMatch(/@example\.com$/)
  })

  it('keeps an identifier at its real length, so a Salesforce id stays an 18 character id', () => {
    const s = buildWorkflowShape({ workflow_id: 'w', workflow_name: 'w', payloads: [{ Prospect__c: 'a0B5f00000AbCdEfGh' }, { Prospect__c: 'a0B5f00000XyZaBcDe' }] })
    expect((generatePayload(s, { seed: 'x' }) as { Prospect__c: string }).Prospect__c).toMatch(/^[A-Za-z0-9]{18}$/)
  })

  it('leaves out a path present in under half the samples', () => {
    const p = generatePayload(shape, { seed: 'a' }) as Record<string, unknown>
    expect('optional' in p).toBe(false)
  })

  it('draws an enumerated field from its domain', () => {
    const p = generatePayload(shape, { seed: 'a' }) as Record<string, any>
    expect(['NY', 'TX']).toContain(p.personalInformation.state)
  })

  it('applies set and unset overrides by path', () => {
    const p = generatePayload(shape, {
      seed: 'a',
      set: { 'personalInformation.state': 'CA', 'financialInformation.creditScore': 512, 'extra.added': true },
      unset: ['personalInformation.email'],
    }) as Record<string, any>
    expect(p.personalInformation.state).toBe('CA')
    expect(p.financialInformation.creditScore).toBe(512)
    expect(p.extra.added).toBe(true)
    expect('email' in p.personalInformation).toBe(false)
  })

  it('never produces a value the personal data scanner accuses', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(scanForPersonalData(generatePayload(shape, { seed }))).toEqual([])
    }
  })

  it('carries no value from the real samples other than domain members', () => {
    const text = JSON.stringify(generatePayload(shape, { seed: 'a' }))
    for (const real of ['Name1', 'p1@corp.net', '512-44-1011', '1984-07-19', '2125550123', '701', '85000.5']) {
      expect(text).not.toContain(real)
    }
  })
})
