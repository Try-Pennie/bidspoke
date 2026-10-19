/**
 * The ops Salesforce budget reading from a response's Sforce-Limit-Info header
 * (#2336, phase 6 of #1689): the parser, and the recorder that keys a reading
 * on the connection's MEASURED org and writes it at most once per org per
 * SF_BUDGET_READING_MIN_INTERVAL_MS.
 */
import { describe, expect, it } from 'vitest'
import type { OrganizationId } from '../../ops-db'
import {
  parseSforceLimitInfo, recordSfBudgetReadingFor, SF_BUDGET_READING_MIN_INTERVAL_MS, SfBudgetMemory, type SfBudgetRecorderDeps,
} from '../sf-budget-reading'

const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId
const CONN = '33333333-3333-4333-8333-333333333333'
const OTHER_CONN = '44444444-4444-4444-8444-444444444444'
const SF_ORG = '00Dcs0000000001EAA'
const T0 = Date.parse('2026-10-19T12:00:00.000Z')

describe('parseSforceLimitInfo', () => {
  it('reads the documented example, used then max, ignoring the other fields', () => {
    expect(parseSforceLimitInfo('api-usage=10018/100000; api-bursts=1/750')).toEqual({ ok: true, used: 10018, max: 100000 })
    expect(parseSforceLimitInfo('api-usage=10018/100000')).toEqual({ ok: true, used: 10018, max: 100000 })
    expect(parseSforceLimitInfo('api-usage=25/5000; per-app-api-usage=17/250(appName=sample-connected-app)')).toEqual({ ok: true, used: 25, max: 5000 })
    expect(parseSforceLimitInfo('api-bursts=1/750;api-usage=0/15000')).toEqual({ ok: true, used: 0, max: 15000 })
  })

  it('answers absent for no header, which most other responses are', () => {
    expect(parseSforceLimitInfo(null)).toEqual({ ok: false, refusal: 'absent' })
  })

  it('answers a header with no api-usage field, or an empty one, as absent of the field', () => {
    expect(parseSforceLimitInfo('api-bursts=1/750')).toEqual({ ok: false, refusal: 'no_api_usage' })
    expect(parseSforceLimitInfo('')).toEqual({ ok: false, refusal: 'no_api_usage' })
  })

  it.each([
    ['letters for a number', 'api-usage=ten/100000'],
    ['a missing max', 'api-usage=10018/'],
    ['a missing used', 'api-usage=/100000'],
    ['a sign', 'api-usage=-1/100000'],
    ['a decimal', 'api-usage=1.5/100000'],
    ['an exponent', 'api-usage=1e3/100000'],
    ['hex', 'api-usage=0x10/100000'],
    ['no slash', 'api-usage=10018'],
    ['a third number', 'api-usage=1/2/3'],
    ['two api-usage fields', 'api-usage=1/100000; api-usage=2/100000'],
    ['two headers folded into one by Headers.get', 'api-usage=1/100000, api-usage=2/100000'],
  ])('refuses %s as malformed, never a NaN', (_why, header) => {
    expect(parseSforceLimitInfo(header)).toEqual({ ok: false, refusal: 'malformed' })
  })

  it('refuses a number too long to be finite', () => {
    expect(parseSforceLimitInfo(`api-usage=${'9'.repeat(400)}/100000`)).toEqual({ ok: false, refusal: 'not_finite' })
    expect(parseSforceLimitInfo(`api-usage=1/${'9'.repeat(400)}`)).toEqual({ ok: false, refusal: 'not_finite' })
  })

  it('refuses a number the reading table cannot hold (integer columns)', () => {
    expect(parseSforceLimitInfo('api-usage=1/2147483648')).toEqual({ ok: false, refusal: 'out_of_range' })
    expect(parseSforceLimitInfo('api-usage=2147483648/100000')).toEqual({ ok: false, refusal: 'out_of_range' })
    expect(parseSforceLimitInfo('api-usage=1/2147483647')).toEqual({ ok: true, used: 1, max: 2147483647 })
  })

  it('refuses an allocation of zero, which the table refuses and no org has', () => {
    expect(parseSforceLimitInfo('api-usage=0/0')).toEqual({ ok: false, refusal: 'max_not_positive' })
  })

  it('reads used above max as a real reading: an org past its allocation, which the table records as remaining below zero', () => {
    expect(parseSforceLimitInfo('api-usage=15003/15000')).toEqual({ ok: true, used: 15003, max: 15000 })
  })
})

interface World {
  deps: SfBudgetRecorderDeps
  memory: SfBudgetMemory
  reads: Array<{ connectionId: string; generation: number }>
  writes: Array<{ sfOrgId: string; dailyApiMax: number; dailyApiRemaining: number }>
  measured: Map<string, string | null | Error>
  writeAnswer: { value: Error | null }
}

function world(): World {
  const reads: World['reads'] = []
  const writes: World['writes'] = []
  const measured = new Map<string, string | null | Error>([[`${CONN}:1`, SF_ORG], [`${OTHER_CONN}:1`, SF_ORG]])
  const writeAnswer: World['writeAnswer'] = { value: null }
  const memory = new SfBudgetMemory()
  const deps: SfBudgetRecorderDeps = {
    memory,
    readMeasuredSfOrg: async (organizationId, connectionId, generation) => {
      expect(organizationId).toBe(ORG)
      reads.push({ connectionId, generation })
      const answer = measured.get(`${connectionId}:${generation}`) ?? null
      if (answer instanceof Error) throw answer
      return answer
    },
    recordSfBudgetReading: async (sfOrgId, reading) => {
      if (writeAnswer.value) throw writeAnswer.value
      writes.push({ sfOrgId, dailyApiMax: reading.dailyApiMax, dailyApiRemaining: reading.dailyApiRemaining })
    },
  }
  return { deps, memory, reads, writes, measured, writeAnswer }
}

const reading = (used: number, max: number) => ({ used, max })

describe('recordSfBudgetReadingFor', () => {
  it('writes remaining as max minus used, for the org the connection measured as', async () => {
    const w = world()
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(10018, 100000), T0)).toBe('recorded')
    expect(w.writes).toEqual([{ sfOrgId: SF_ORG, dailyApiMax: 100000, dailyApiRemaining: 89982 }])
  })

  it('writes an org past its allocation as remaining below zero, so the floor refuses at once', async () => {
    const w = world()
    await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(15003, 15000), T0)
    expect(w.writes).toEqual([{ sfOrgId: SF_ORG, dailyApiMax: 15000, dailyApiRemaining: -3 }])
  })

  it('writes nothing for a connection with no measured org, and says so', async () => {
    const w = world()
    w.measured.set(`${CONN}:1`, null)
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)).toBe('unmeasured')
    expect(w.writes).toEqual([])
  })

  it('writes at most once per org within the interval, two connections to one org included', async () => {
    const w = world()
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)).toBe('recorded')
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(2, 100), T0 + SF_BUDGET_READING_MIN_INTERVAL_MS - 1)).toBe('throttled')
    expect(await recordSfBudgetReadingFor(w.deps, ORG, OTHER_CONN, 1, reading(3, 100), T0 + 1)).toBe('throttled')
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(4, 100), T0 + SF_BUDGET_READING_MIN_INTERVAL_MS)).toBe('recorded')
    expect(w.writes.map((x) => x.dailyApiRemaining)).toEqual([99, 96])
  })

  it('reads the measured org once per connection and generation, then from memory', async () => {
    const w = world()
    await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)
    await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0 + 1)
    await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0 + SF_BUDGET_READING_MIN_INTERVAL_MS)
    expect(w.reads).toEqual([{ connectionId: CONN, generation: 1 }])
  })

  it('does not remember an unmeasured connection, so the reading after verify measures it is written', async () => {
    const w = world()
    w.measured.set(`${CONN}:1`, null)
    await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)
    w.measured.set(`${CONN}:1`, SF_ORG)
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0 + 1)).toBe('recorded')
  })

  it('keys the memory on organization, connection and generation, so a new generation is read afresh', async () => {
    const w = world()
    w.measured.set(`${CONN}:2`, '00Dcs0000000002EAA')
    await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 2, reading(1, 100), T0 + 1)).toBe('recorded')
    expect(w.writes.map((x) => x.sfOrgId)).toEqual([SF_ORG, '00Dcs0000000002EAA'])
  })

  it('throws a failed write, and forgets it, so the next response tries again inside the interval', async () => {
    const w = world()
    w.writeAnswer.value = new Error('the ops database is down')
    await expect(recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)).rejects.toThrow(/down/)
    w.writeAnswer.value = null
    expect(await recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(2, 100), T0 + 1)).toBe('recorded')
  })

  it('throws a failed measured org read, writing nothing', async () => {
    const w = world()
    w.measured.set(`${CONN}:1`, new Error('the read failed'))
    await expect(recordSfBudgetReadingFor(w.deps, ORG, CONN, 1, reading(1, 100), T0)).rejects.toThrow(/read failed/)
    expect(w.writes).toEqual([])
  })

  it('holds its memory to a bound, so a long lived isolate cannot grow it without end', () => {
    const memory = new SfBudgetMemory(2)
    memory.rememberOrg('a', SF_ORG)
    memory.rememberOrg('b', SF_ORG)
    memory.rememberOrg('c', SF_ORG)
    expect(memory.orgOf('a')).toBeUndefined()
    expect(memory.orgOf('c')).toBe(SF_ORG)
  })
})
