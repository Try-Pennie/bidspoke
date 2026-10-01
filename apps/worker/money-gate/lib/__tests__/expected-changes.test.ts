import { describe, it, expect } from 'vitest'
import { applyExpectedChanges, parseExpectedChanges, type ExpectedChange } from '../expected-changes'
import type { Difference } from '../compare'

const diff = (over: Partial<Difference> = {}): Difference => ({
  fixture: 'Main Flow/bid_race_tripoint_wins',
  check: 'outbound_request',
  node: 'bid_race',
  field: 'outbound[9] POST tripoint-proxy.trypennie.dev/leads/create body.unsecuredDebt',
  base: 25000,
  head: undefined,
  ...over,
})

const entry = (over: Partial<ExpectedChange> = {}): ExpectedChange => ({
  workflow: 'Main Flow',
  check: 'outbound_request',
  node: 'bid_race',
  field: '* body.unsecuredDebt',
  reason: 'Tripoint no longer receives the debt field, agreed with the partner on 2026-10-01',
  ...over,
})

describe('applyExpectedChanges', () => {
  it('leaves a difference no entry names unexcused', () => {
    const r = applyExpectedChanges([diff()], [], [])
    expect(r.unexcused).toHaveLength(1)
    expect(r.excused).toEqual([])
  })

  it('excuses a difference matched by an entry that is new in this change', () => {
    const r = applyExpectedChanges([diff(), diff({ fixture: 'Main Flow/achieve_rejects' })], [entry()], [])
    expect(r.unexcused).toEqual([])
    expect(r.excused.map((x) => x.diff.fixture)).toEqual(['Main Flow/bid_race_tripoint_wins', 'Main Flow/achieve_rejects'])
    expect(r.failures).toEqual([])
  })

  it('an entry carried over from the base excuses nothing, so it cannot mask a later change', () => {
    const r = applyExpectedChanges([diff()], [entry()], [entry()])
    expect(r.unexcused).toHaveLength(1)
    expect(r.excused).toEqual([])
    expect(r.carriedOver).toHaveLength(1)
    expect(r.failures).toEqual([])
  })

  it('an edited entry is new, and only its new form counts', () => {
    const r = applyExpectedChanges([diff()], [entry({ reason: 'Tripoint dropped the field from its spec, see thread of 2026-10-01' })], [entry()])
    expect(r.unexcused).toEqual([])
  })

  it('fails by name on a new entry that matches no difference: a stale excuse is a defect', () => {
    const r = applyExpectedChanges([diff()], [entry(), entry({ workflow: 'Engine Bidding Workflow', field: '* body.ssn' })], [])
    expect(r.failures).toEqual(['expected change for Engine Bidding Workflow outbound_request node bid_race field "* body.ssn" matched no difference; remove it or fix its pattern'])
  })

  it('matches on workflow, check, node and field pattern, all of them', () => {
    expect(applyExpectedChanges([diff()], [entry({ check: 'route' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ node: 'other' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ workflow: 'Main Flow (v2)' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ field: 'body.debt' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ node: undefined })], []).unexcused).toHaveLength(0)
  })
})

describe('parseExpectedChanges', () => {
  it('reads an absent or empty file as no entries', () => {
    expect(parseExpectedChanges(null)).toEqual({ entries: [], failures: [] })
    expect(parseExpectedChanges('{ "entries": [] }')).toEqual({ entries: [], failures: [] })
  })

  it('refuses an entry without a written reason, or naming an unknown check', () => {
    const r = parseExpectedChanges(JSON.stringify({ entries: [
      { workflow: 'Main Flow', check: 'outbound_request', field: '*', reason: '' },
      { workflow: 'Main Flow', check: 'outbound_request', field: '*', reason: '--- ok' },
      { workflow: 'Main Flow', check: 'nonsense', field: '*', reason: 'A perfectly good reason here' },
    ] }))
    expect(r.entries).toEqual([])
    expect(r.failures).toHaveLength(3)
  })

  it('refuses a file that does not parse, rather than reading it as empty', () => {
    expect(parseExpectedChanges('{ nope').failures[0]).toMatch(/does not parse/)
  })
})
