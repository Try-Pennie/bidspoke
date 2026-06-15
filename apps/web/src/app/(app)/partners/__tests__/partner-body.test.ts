/**
 * Issue #98: PartnerForm's post-save Undo re-saves a snapshot via buildPartnerBody,
 * so every field must map faithfully — a dropped field would silently revert a
 * real-money setting. These tests pin the mapping, especially is_active (the
 * concrete bug: disable, save, Undo must re-enable).
 */
import { describe, it, expect } from 'vitest'
import { buildPartnerBody, serializeRules, floorsToMap, type FormSnapshot } from '../partner-body'

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
