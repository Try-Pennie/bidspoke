import { describe, it, expect } from 'vitest'
import { ABSENT_AT_BASE, applyExpectedChanges, parseExpectedChanges, resolveExpectedBase, type ExpectedChange } from '../expected-changes'
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

  it('credits a difference to every new entry that matches it, so overlapping entries are not reported stale', () => {
    const r = applyExpectedChanges([diff()], [entry(), entry({ field: '*unsecuredDebt', reason: 'Overlapping entry for the same field, written by a second author' })], [])
    expect(r.unexcused).toEqual([])
    expect(r.failures).toEqual([])
  })

  it('matches on workflow, check, node and field pattern, all of them', () => {
    expect(applyExpectedChanges([diff()], [entry({ check: 'route' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ node: 'other' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ workflow: 'Main Flow (v2)' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ field: 'body.debt' })], []).unexcused).toHaveLength(1)
    expect(applyExpectedChanges([diff()], [entry({ node: undefined })], []).unexcused).toHaveLength(0)
  })
})

describe('resolveExpectedBase', () => {
  const fs = (files: Record<string, string>) => ({
    exists: (p: string) => p in files,
    read: (p: string) => files[p],
  })

  it('reads the base copy when one was handed over', () => {
    expect(resolveExpectedBase('/base/expected-changes.json', fs({ '/base/expected-changes.json': '{"entries":[]}' }))).toEqual({ text: '{"entries":[]}', failure: null })
  })

  it('honours the marker git wrote for a file absent at the base as no entries', () => {
    expect(resolveExpectedBase(ABSENT_AT_BASE, fs({}))).toEqual({ text: null, failure: null })
  })

  it('fails by name when nothing was handed over, rather than reading it as absent', () => {
    expect(resolveExpectedBase(undefined, fs({})).failure).toMatch(/was not handed over/)
    expect(resolveExpectedBase('', fs({})).failure).toMatch(/was not handed over/)
  })

  it('fails by name when the path handed over cannot be read, rather than reading it as absent', () => {
    expect(resolveExpectedBase('/wrong/expected-changes.json', fs({})).failure).toMatch(/cannot be read/)
  })
})

describe('applyExpectedChanges: the replay an entry names (#1780)', () => {
  const live = diff({ fixture: 'Main Flow/bid_race_tripoint_wins' })
  const shadow = diff({ fixture: 'Main Flow/bid_race_tripoint_wins as shadow dry_run' })

  it('excuses only the replays its fixture pattern names, so a shadow only excuse leaves a live difference red', () => {
    const r = applyExpectedChanges([live, shadow], [entry({ fixture: '* as shadow *' })], [])
    expect(r.excused.map((x) => x.diff.fixture)).toEqual(['Main Flow/bid_race_tripoint_wins as shadow dry_run'])
    expect(r.unexcused.map((d) => d.fixture)).toEqual(['Main Flow/bid_race_tripoint_wins'])
  })

  it('matches the pattern against the replay after the workflow name', () => {
    expect(applyExpectedChanges([live], [entry({ fixture: 'bid_race_*' })], []).unexcused).toEqual([])
    expect(applyExpectedChanges([live], [entry({ fixture: 'Main Flow/*' })], []).unexcused).toHaveLength(1)
  })

  it('names the pattern when an entry carrying one matches nothing', () => {
    const r = applyExpectedChanges([live], [entry(), entry({ fixture: '* as shadow *', reason: 'A shadow only excuse with nothing to excuse' })], [])
    expect(r.failures).toEqual(['expected change for Main Flow outbound_request node bid_race fixture "* as shadow *" field "* body.unsecuredDebt" matched no difference; remove it or fix its pattern'])
  })

  it('refuses a fixture pattern that is not a string', () => {
    const r = parseExpectedChanges(JSON.stringify({ entries: [{ workflow: 'Main Flow', check: 'outbound_request', fixture: 7, field: '*', reason: 'A perfectly good reason here' }] }))
    expect(r.entries).toEqual([])
    expect(r.failures[0]).toMatch(/a fixture that is not a string/)
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
