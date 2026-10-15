/**
 * Issue #98: PartnerForm's post-save Undo re-saves a snapshot via buildPartnerBody,
 * so every field must map faithfully: a dropped field would silently revert a
 * real-money setting. These tests pin the mapping, especially is_active (the
 * concrete bug: disable, save, Undo must re-enable).
 */
import { describe, it, expect } from 'vitest'
import { SIGNAL_OPERATORS, type Signal, type SignalOperator } from '@bidspoke/buyer-profile'
import { buildPartnerBody, changedPatch, draftReducer, initDraft, inversePatch, parseRules, serializeRules, floorsToMap, type FormSnapshot } from '../partner-draft'

function snap(overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    name: 'Acme', apiEndpoint: '', cfSecretKey: '', clickUrl: '', isActive: true,
    priority: '', dailyCap: '', minBid: '', bidFormula: '',
    resolverType: 'formula', resolverConfig: {}, outboundMapping: null,
    bidMode: 'commit', bidComparisonSource: 'auto', extraExtraction: null, lastProbeResponse: null,
    dedupEndpoint: '', circuitEnabled: true, circuitThreshold: '', circuitWindow: '', circuitCooldown: '',
    signalRules: { rejection: [], transient: [], permanent: [] },
    alertTransient: true, alertPermanent: true,
    sellOffOfferTitle: '', sellOffOfferDetails: '', partnerType: 'buyer', confirmationWindowMs: '',
    subAccountFloors: [],
    acceptSignals: [],
    externalRoutingCode: '',
    duplicateSignals: [],
    ...overrides,
  }
}

describe('buildPartnerBody (#98)', () => {
  it('carries is_active through both ways (the Undo re-enable case)', () => {
    expect(buildPartnerBody(snap({ isActive: false }), { slug: 's', isExisting: true }).is_active).toBe(false)
    expect(buildPartnerBody(snap({ isActive: true }), { slug: 's', isExisting: true }).is_active).toBe(true)
  })

  it('omits slug for an existing partner and includes it for a new one', () => {
    expect(buildPartnerBody(snap(), { slug: 'acme', isExisting: true }).slug).toBeUndefined()
    expect(buildPartnerBody(snap(), { slug: 'acme', isExisting: false }).slug).toBe('acme')
  })

  it('applies numeric defaults and null-for-blank rules', () => {
    const b = buildPartnerBody(snap(), { slug: 's', isExisting: true })
    expect(b.priority).toBe(0)
    expect(b.daily_cap).toBeNull()
    expect(b.min_bid).toBeNull()
    expect(b.circuit_error_threshold).toBe(5)
    expect(b.circuit_window_seconds).toBe(60)
    expect(b.circuit_cooldown_seconds).toBe(300)
    expect(b.confirmation_window_ms).toBeNull()
  })

  it('parses provided numbers', () => {
    const b = buildPartnerBody(snap({ priority: '7', dailyCap: '250', minBid: '1.5', confirmationWindowMs: '4000' }), { slug: 's', isExisting: true })
    expect(b.priority).toBe(7)
    expect(b.daily_cap).toBe(250)
    expect(b.min_bid).toBe(1.5)
    expect(b.confirmation_window_ms).toBe(4000)
  })

  it('carries the routing code as a whole number or null, and the duplicate rules as they are (#1416)', () => {
    const blank = buildPartnerBody(snap(), { slug: 's', isExisting: true })
    expect(blank.external_routing_code).toBeNull()
    expect(blank.duplicate_signals).toEqual([])
    const set = buildPartnerBody(snap({ externalRoutingCode: '2', duplicateSignals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }] }), { slug: 's', isExisting: true })
    expect(set.external_routing_code).toBe(2)
    expect(set.duplicate_signals).toEqual([{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }])
    // A routing code that is not a whole number is not a routing code (L50): null, never a rounded guess.
    expect(buildPartnerBody(snap({ externalRoutingCode: '2.5' }), { slug: 's', isExisting: true }).external_routing_code).toBeNull()
    expect(buildPartnerBody(snap({ externalRoutingCode: 'two' }), { slug: 's', isExisting: true }).external_routing_code).toBeNull()
  })

  it('serializes signal rules into response_classification', () => {
    const b = buildPartnerBody(
      snap({ signalRules: { rejection: [{ id: 'r1', kind: 'body', field: 'status', condition: 'equals', value: 'declined' }], transient: [], permanent: [] } }),
      { slug: 's', isExisting: true },
    )
    expect(b.response_classification).toEqual({ rejection_signals: [{ field: 'status', equals: 'declined' }] })
  })
})

describe('floorsToMap / serializeRules (#98, moved intact)', () => {
  it('drops blank/non-positive sub-account floors', () => {
    expect(floorsToMap([
      { id: '1', uuid: 'a', bid: '5' },
      { id: '2', uuid: 'b', bid: '' },    // blank = no override
      { id: '3', uuid: 'c', bid: '0' },   // non-positive = no override
      { id: '4', uuid: '  ', bid: '9' },  // blank uuid
    ])).toEqual({ a: 5 })
  })

  it('returns null when no floors survive', () => {
    expect(floorsToMap([{ id: '1', uuid: 'a', bid: '' }])).toBeNull()
  })

  it('returns null when there are no signal rules', () => {
    expect(serializeRules({ rejection: [], transient: [], permanent: [] })).toBeNull()
  })
})

/**
 * #1463: the Rejection rules builder offered five operators while the shared
 * classifier knows seven, and a stored rule using one of the other two was read
 * as "equals" with an empty value and written back that way on the next save
 * (L652). Every operator the vocabulary names must survive a read and a write.
 */
describe('parseRules and serializeRules round trip every signal operator (#1463)', () => {
  const ONE_OF_EACH: Record<SignalOperator, Signal> = {
    present: { field: 'data.id', present: true },
    equals: { field: 'ok', equals: true },
    contains: { field: 'message', contains: 'declined' },
    in: { field: 'data.createLead.resultCode', in: [1000, 1001, 'A1'] },
    not_in: { field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] },
    any_item_contains: { field: 'details[].message', any_item_contains: 'Cannot return null for non-nullable field CreateLeadResponse.id' },
    any_item_word_prefix_ci: { field: 'details[].message', any_item_word_prefix_ci: 'invalid' },
  }

  for (const op of SIGNAL_OPERATORS) {
    it(`${op} survives unchanged`, () => {
      const stored = { rejection_signals: [ONE_OF_EACH[op]] }
      expect(serializeRules(parseRules(stored))).toEqual(stored)
    })
  }

  it('the two Tripoint 502 decline shapes survive beside the result code rule, in order', () => {
    const stored = {
      rejection_signals: [ONE_OF_EACH.not_in, ONE_OF_EACH.any_item_contains, ONE_OF_EACH.any_item_word_prefix_ci],
    }
    expect(serializeRules(parseRules(stored))).toEqual(stored)
  })

  it('reads every operator into the condition the picker shows, never a blank equals', () => {
    const rules = parseRules({ rejection_signals: SIGNAL_OPERATORS.map((op) => ONE_OF_EACH[op]) })
    expect(rules.rejection.map((r) => (r.kind === 'body' ? r.condition : r.kind))).toEqual([...SIGNAL_OPERATORS])
    expect(rules.rejection.some((r) => r.kind === 'body' && r.condition === 'equals' && r.value === '')).toBe(false)
  })
})

// #2132: the draft a save is made from. A save sends only the keys the person
// touched whose value differs from what the page loaded (base), so a save made
// on top of someone else's newer save cannot put their change back.
describe('the partner draft: base, draft and touched (#2132)', () => {
  const base = buildPartnerBody(snap({ name: 'Acme', bidMode: 'ping_only', dailyCap: '100' }), { slug: 'acme', isExisting: true })

  it('starts with nothing touched and nothing to send', () => {
    const s = initDraft(base)
    expect(s.touched.size).toBe(0)
    expect(changedPatch(s)).toEqual({})
  })

  it('an edit touches only the keys it changed, and the patch carries only those', () => {
    const s = draftReducer(initDraft(base), { type: 'observe', draft: { ...base, name: 'Acme 2' } })
    expect([...s.touched]).toEqual(['name'])
    expect(changedPatch(s)).toEqual({ name: 'Acme 2' })
    expect('bid_mode' in changedPatch(s)).toBe(false)
  })

  it('a key edited back to its base value stays touched but is not sent', () => {
    let s = draftReducer(initDraft(base), { type: 'observe', draft: { ...base, daily_cap: 200 } })
    s = draftReducer(s, { type: 'observe', draft: { ...base, daily_cap: 100 } })
    expect(s.touched.has('daily_cap')).toBe(true)
    expect(changedPatch(s)).toEqual({})
  })

  it('compares structured values by content, so a rebuilt but equal object is not a change', () => {
    const s = draftReducer(initDraft(base), { type: 'observe', draft: { ...base, alert_config: JSON.parse(JSON.stringify(base.alert_config)) } })
    expect(changedPatch(s)).toEqual({})
  })

  it('a save rebases: what was saved is the new base and nothing is left to send', () => {
    let s = draftReducer(initDraft(base), { type: 'observe', draft: { ...base, name: 'Acme 2' } })
    s = draftReducer(s, { type: 'rebase', base: { ...base, name: 'Acme 2' } })
    expect(changedPatch(s)).toEqual({})
    expect(s.base.name).toBe('Acme 2')
  })

  it('the inverse of a patch restores each sent key to its value before the save', () => {
    expect(inversePatch({ name: 'Acme 2', daily_cap: null }, base)).toEqual({ name: 'Acme', daily_cap: 100 })
  })
})
