/**
 * Each History entry in plain words (#2141): every shape production's
 * audit_log holds for a partner (read only, 2026-10-16, values redacted where
 * they name a person or work as a credential), the matrix syncs, and the
 * shapes the server half's triggers write.
 */
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@bidspoke/partner-history'
import { describeEntry, groupByEtDay, pickupNote, type HistoryLine } from '../describe-history'

const PARTNER = '1b9cbd8f-1d23-496c-b046-b11d64edae29'
const person = { kind: 'person' as const, userId: '00000000-0000-4000-8000-000000000002', name: 'Editor B', via: null }

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    key: 'audit:x', source: 'audit_log', at: '2026-10-14T20:52:21.130Z', entityType: 'partner_config', entityId: PARTNER,
    action: 'updated', editor: person, editorLabel: 'Editor B', changes: {}, matrix: null, ...over,
  }
}

const lines = (e: HistoryEntry): HistoryLine[] => describeEntry(e).lines

describe('partner settings', () => {
  it('a changed setting is its registry label, the old value and the new one', () => {
    expect(lines(entry({ changes: { click_url: { old: 'https://trypennie.com/portal/libertyone/{prospect_id}', new: 'https://trypennie.com/portal/liberty/{prospect_id}' } } }))).toEqual([
      { kind: 'change', label: 'Click URL', from: 'https://trypennie.com/portal/libertyone/{prospect_id}', to: 'https://trypennie.com/portal/liberty/{prospect_id}' },
    ])
    expect(lines(entry({ changes: { external_routing_code: { old: null, new: 4 } } }))).toEqual([
      { kind: 'change', label: 'Salesforce routing code', from: 'none', to: '4' },
    ])
  })

  it('a list or a setting object reads as itself, an empty one as none', () => {
    expect(lines(entry({ changes: { duplicate_signals: { old: [], new: [{ in: [1003, 1004, 1020], field: 'data.createLead.resultCode' }] } } }))).toEqual([
      { kind: 'change', label: 'Duplicate when any of', from: 'none', to: '[{"in":[1003,1004,1020],"field":"data.createLead.resultCode"}]' },
    ])
  })

  it('an older save that recorded only which settings it sent says so, never that each one changed', () => {
    const all = ['name', 'api_endpoint', 'cf_secret_key', 'daily_cap', 'min_bid', 'bid_formula', 'bid_resolver_type', 'bid_mode']
    expect(lines(entry({ changes: { changed_fields: all } }))).toEqual([{ kind: 'text', text: 'Saved 8 settings at once; the values were not recorded.' }])
    expect(lines(entry({ changes: { changed_fields: ['bid_resolver_config'] } }))).toEqual([{ kind: 'text', text: 'Saved Resolver settings; the values were not recorded.' }])
  })

  it('a hand written note with its before and after reads as the change and the note', () => {
    const e = entry({ changes: { note: 'Tripoint high tier 0.0012 to 0.0013 to match Salesforce', after: 0.0013, before: 0.0012, changed_fields: ['bid_resolver_config'] } })
    expect(lines(e)).toEqual([
      { kind: 'change', label: 'Resolver settings', from: '0.0012', to: '0.0013' },
      { kind: 'text', text: 'Note: Tripoint high tier 0.0012 to 0.0013 to match Salesforce' },
    ])
    expect(describeEntry(e).unregistered).toEqual([])
  })

  it('a created partner says so and lists what it was set up with, leaving out the row\'s own bookkeeping', () => {
    expect(lines(entry({ action: 'created', changes: { name: 'Tripoint', slug: 'tripoint' } }))).toEqual([
      { kind: 'text', text: 'Created the partner.' },
      { kind: 'set', label: 'Name', value: 'Tripoint' },
      { kind: 'set', label: 'Slug', value: 'tripoint' },
    ])
    expect(lines(entry({ action: 'created', changes: { id: { old: null, new: PARTNER }, organization_id: { old: null, new: 'org' }, created_at: { old: null, new: '2026-09-25T14:14:11Z' }, name: { old: null, new: 'Liberty1' }, is_active: { old: null, new: true } } }))).toEqual([
      { kind: 'text', text: 'Created the partner.' },
      { kind: 'set', label: 'Name', value: 'Liberty1' },
      { kind: 'set', label: 'Status', value: 'yes' },
    ])
  })

  it('a field the registry no longer holds is named by its retired label, and one it never held by its raw name and counted', () => {
    const retired = describeEntry(entry({ action: 'created', changes: { bid_mode: { old: null, new: 'commit' } } }))
    expect(retired.lines).toEqual([{ kind: 'text', text: 'Created the partner.' }, { kind: 'set', label: 'Bid mode (since removed)', value: 'commit' }])
    expect(retired.unregistered).toEqual([])
    const unknown = describeEntry(entry({ changes: { brand_new_column: { old: 1, new: 2 } } }))
    expect(unknown.lines).toEqual([{ kind: 'change', label: 'brand_new_column', from: '1', to: '2' }])
    expect(unknown.unregistered).toEqual(['brand_new_column'])
  })

  it('bookkeeping a trigger adds is never a line: the actor, the source, the route', () => {
    expect(lines(entry({ editor: { kind: 'direct' }, changes: { _source: 'direct_sql', _actor: { name: 'x' }, extra_extraction: { old: { a: 1 }, new: { a: 2 } } } }))).toEqual([
      { kind: 'change', label: 'Extra extraction', from: '{"a":1}', to: '{"a":2}' },
    ])
  })

  it('a reason a save carried is its own line', () => {
    expect(lines(entry({ changes: { name: { old: 'A', new: 'B' }, reason: 'rename' } }))).toEqual([
      { kind: 'change', label: 'Name', from: 'A', to: 'B' },
      { kind: 'text', text: 'Reason: rename' },
    ])
  })
})

describe('the buyer profile', () => {
  const profile = (changes: Record<string, unknown>, action = 'updated') => entry({ entityType: 'buyer_profile', action, changes })

  it('a field by its form label and its form value', () => {
    expect(lines(profile({ loan_amount_min: { new: 10000, old: 2500 } }))).toEqual([{ kind: 'change', label: 'Loan amount minimum', from: '$2,500.00', to: '$10,000.00' }])
    expect(lines(profile({ is_enabled: { new: true, old: false } }))).toEqual([{ kind: 'change', label: 'Enabled', from: 'no', to: 'yes' }])
  })

  it('states by count and the states that moved, as the settled design words them', () => {
    const S41 = ['AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MO', 'MS', 'MT', 'NC', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'WV']
    const S40 = S41.filter((s) => s !== 'RI')
    expect(lines(profile({ allowed_states: { new: S40, old: S41 } }))).toEqual([{ kind: 'change', label: 'States', from: '41', to: '40, removed RI' }])
    expect(lines(profile({ allowed_states: { new: [...S41, 'WY'], old: S40 } }))).toEqual([{ kind: 'change', label: 'States', from: '40', to: '42, added RI, WY' }])
  })

  it('a move of every weekday\'s hours is one line for the run of days, from the real save', () => {
    const changes: Record<string, unknown> = {}
    for (const d of [1, 2, 3, 4, 5]) {
      changes[`windows.${d}.540`] = { new: 1260, old: null }
      changes[`windows.${d}.660`] = { new: null, old: 1260 }
    }
    expect(lines(profile(changes))).toEqual([{ kind: 'change', label: 'Hours, Monday to Friday', from: '11:00 AM to 9:00 PM', to: '9:00 AM to 9:00 PM' }])
  })

  it('hours that differ by day are a line each, and a whole day open reads as all day', () => {
    expect(lines(profile({ 'windows.0.0': { new: 1440, old: null }, 'windows.2.660': { new: 1320, old: 1260 } }, 'created'))).toEqual([
      { kind: 'text', text: 'Set up the buyer profile.' },
      { kind: 'set', label: 'Hours, Sunday', value: 'all day' },
      { kind: 'change', label: 'Hours, Tuesday', from: '11:00 AM to 9:00 PM', to: '11:00 AM to 10:00 PM' },
    ])
  })

  it('a pricing tier added or removed is one line; a field of a tier kept on both sides is its own line', () => {
    expect(lines(profile({
      'tiers.engine.0.debt_to': { new: 12500, old: null },
      'tiers.engine.0.multiplier': { new: 0.0009, old: null },
      'tiers.engine.10000.debt_to': { new: null, old: 20000 },
      'tiers.engine.10000.multiplier': { new: null, old: 0.001 },
      'tiers.engine.12500.multiplier': { new: 0.0013, old: null },
    }))).toEqual([
      { kind: 'change', label: 'Engine tier from $0', from: 'none', to: '0.0009 with up to $12,500' },
      { kind: 'change', label: 'Engine tier from $10,000', from: '0.001 with up to $20,000', to: 'none' },
      { kind: 'change', label: 'Engine tier from $12,500', from: 'none', to: '0.0013 with no upper bound' },
    ])
    expect(lines(profile({ 'tiers.engine.12500.debt_to': { new: 16000, old: 15000 } }))).toEqual([
      { kind: 'change', label: 'Engine tier from $12,500 upper bound', from: '$15,000.00', to: '$16,000.00' },
    ])
  })

  it('a click route by its states, never its address, and the success reply as set', () => {
    expect(lines(profile({
      'click_delivery.routes[DI4]': { new: { url: 'https://hooks.example.com/redacted/DI4', states: [] }, old: null },
      'click_delivery.routes[DV1]': { new: { url: 'https://hooks.example.com/redacted/DV1', states: ['WA', 'DE'] }, old: { url: 'https://hooks.example.com/redacted/old', states: ['WA', 'DE'] } },
      'click_delivery.success_pattern': { new: '^ok$', old: null },
    }))).toEqual([
      { kind: 'change', label: 'Route DI4', from: 'none', to: 'every state no other route lists' },
      { kind: 'change', label: 'Route DV1', from: 'DE, WA', to: 'DE, WA, new address' },
      { kind: 'change', label: 'Success reply', from: 'none', to: 'set' },
    ])
  })

  it('a path no registry entry matches is shown under its raw name and counted, never dropped', () => {
    const d = describeEntry(profile({ 'mystery.path': { old: 1, new: 2 }, 'windows.x': { old: 1, new: 2 } }))
    expect(d.lines).toEqual([
      { kind: 'change', label: 'mystery.path', from: '1', to: '2' },
      { kind: 'change', label: 'windows.x', from: '1', to: '2' },
    ])
    expect(d.unregistered).toEqual(['mystery.path', 'windows.x'])
  })

  it('a hand edit of a profile table says which part and how many rows', () => {
    expect(lines(profile({ _source: 'direct_sql', table: 'buyer_pricing_tiers', op: 'UPDATE', rows: 2 }))).toEqual([{ kind: 'text', text: 'Pricing: 2 rows updated.' }])
    expect(lines(profile({ _source: 'direct_sql', table: 'buyer_profiles', op: 'DELETE', rows: 1 }, 'deleted'))).toEqual([{ kind: 'text', text: 'Buyer profile: 1 row deleted.' }])
  })
})

describe('held clicks, sub-account IDs and matrices', () => {
  it('a held click marked sent, from the real row', () => {
    expect(lines(entry({ entityType: 'held_click', entityId: 'hc', changes: {
      subject: { reason: 'outcome_unknown', held_at: '2026-09-30T15:57:55Z', partner_id: PARTNER, prospect_id: 'prospect-1' },
      claim_state: { new: 'sold', old: 'in_flight' }, buyer_lead_id: { new: 'lead-1', old: null }, claim_generation: { new: 2, old: 1 },
    } }))).toEqual([{ kind: 'change', label: 'Held click, prospect prospect-1', from: 'held', to: 'marked sent, lead id lead-1' }])
  })

  it('a held click cleared from the list names its prospect from the cleared claim, and its Salesforce updates say whether they all landed', () => {
    expect(lines(entry({ entityType: 'held_click', action: 'deleted', changes: {
      held_click: { old: { partner_id: PARTNER, prospect_id: 'p3', reason: 'outcome_unknown', held_at: '2026-09-30T15:57:55Z' }, new: null },
      claim_state: { old: 'sold', new: 'sold' }, _actor: { name: 'Editor B', email: 'editor-b@example.com' },
    } }))).toEqual([{ kind: 'text', text: 'Cleared the held click for prospect p3 from the list; it was marked sent.' }])
    const d = describeEntry(entry({ entityType: 'held_click', changes: {
      subject: { prospect_id: 'p4' }, salesforce_writes: { old: { complete: false }, new: { complete: true, writes: [] } },
    } }))
    expect(d.lines).toEqual([{ kind: 'change', label: 'Held click, prospect p4, Salesforce updates', from: 'not all written', to: 'all written' }])
    expect(d.unregistered).toEqual([])
  })

  it('a held_click pair on a row that is not a clear is shown and counted, never dropped', () => {
    const d = describeEntry(entry({ entityType: 'held_click', action: 'updated', changes: { held_click: { old: { prospect_id: 'p5' }, new: { prospect_id: 'p5', reason: 'x' } } } }))
    expect(d.lines).toEqual([{ kind: 'change', label: 'held_click', from: '{"prospect_id":"p5"}', to: '{"prospect_id":"p5","reason":"x"}' }])
    expect(d.unregistered).toEqual(['held_click'])
  })

  it('a held click freed', () => {
    expect(lines(entry({ entityType: 'held_click', changes: { subject: { prospect_id: 'p2' }, claim_state: { new: 'free', old: 'in_flight' } } }))).toEqual([
      { kind: 'change', label: 'Held click, prospect p2', from: 'held', to: 'freed' },
    ])
  })

  it('a sub-account ID added, removed and moved', () => {
    expect(lines(entry({ entityType: 'partner_uuid', action: 'created', changes: { uuid: { old: null, new: 'u-1' }, partner_slug: { old: null, new: 'sofi' }, partner_id: PARTNER } }))).toEqual([
      { kind: 'text', text: 'Added sub-account UUID u-1.' },
    ])
    expect(lines(entry({ entityType: 'partner_uuid', action: 'deleted', changes: { uuid: { old: 'u-1', new: null }, partner_slug: { old: 'sofi', new: null }, partner_id: PARTNER } }))).toEqual([
      { kind: 'text', text: 'Removed sub-account UUID u-1.' },
    ])
    expect(lines(entry({ entityType: 'partner_uuid', action: 'updated', changes: { partner_slug: { old: 'sofi', new: 'nerdwallet' }, partner_id: 'other', old_partner_id: PARTNER } }))).toEqual([
      { kind: 'change', label: 'Sub-account UUID', from: 'on sofi', to: 'on nerdwallet' },
    ])
  })

  it('a matrix created, changed and deleted, by its name', () => {
    const matrix = { configId: 'c1', configName: 'Tripoint default', source: null }
    expect(lines(entry({ entityType: 'partner_bid_config', action: 'created', matrix, changes: { slug: 'tp', name: 'Tripoint default', partner_id: PARTNER } }))).toEqual([{ kind: 'text', text: 'Created the bid matrix Tripoint default.' }])
    expect(lines(entry({ entityType: 'partner_bid_config', action: 'updated', matrix, changes: { changed_fields: ['sf_object', 'is_default'], partner_id: PARTNER } }))).toEqual([{ kind: 'text', text: 'Saved the bid matrix Tripoint default: Salesforce object, Default matrix; the values were not recorded.' }])
    expect(lines(entry({ entityType: 'partner_bid_config', action: 'updated', matrix, changes: { changed_fields: [], partner_id: PARTNER } }))).toEqual([{ kind: 'text', text: 'Saved the bid matrix Tripoint default; what changed was not recorded.' }])
    expect(lines(entry({ entityType: 'partner_bid_config', action: 'deleted', matrix: { ...matrix, configName: null }, changes: { name: 'Old matrix', partner_id: PARTNER } }))).toEqual([{ kind: 'text', text: 'Deleted the bid matrix Old matrix.' }])
  })

  it('a matrix sync: its name, the counts, and each row added, removed or edited', () => {
    const e = entry({
      source: 'bid_config_history', entityType: 'bid_matrix', action: 'synced', key: 'matrix:m1',
      matrix: { configId: 'c1', configName: 'Tripoint default', source: 'salesforce_sync' },
      changes: {
        rows_fetched: 12, rows_upserted: 12, rows_deleted: 1,
        added: [{ row_id: 'r1', range: '600 to 649', is_sell_off: false, bid_amount: 17.5 }],
        removed: [{ row_id: 'r2', range: '550 to 599', is_sell_off: true, bid_amount: 4 }],
        edited: [{ row_id: 'r3', range: '650 to 699', is_sell_off: false, changes: [{ field: 'bid_amount', before: 20, after: 22.5 }, { field: 'is_sell_off', before: false, after: true }] }],
      },
    })
    expect(lines(e)).toEqual([
      { kind: 'text', text: 'Tripoint default: 1 row added, 1 edited, 1 removed (12 rows read from Salesforce).' },
      { kind: 'change', label: 'Row 600 to 649', from: 'none', to: '$17.50' },
      { kind: 'change', label: 'Row 650 to 699 bid', from: '$20.00', to: '$22.50' },
      { kind: 'change', label: 'Row 650 to 699 sell-off', from: 'no', to: 'yes' },
      { kind: 'change', label: 'Sell-off row 550 to 599', from: '$4.00', to: 'removed' },
    ])
  })

  it('an edited sell-off row is named as a sell-off row, as an added or removed one is', () => {
    expect(lines(entry({ source: 'bid_config_history', entityType: 'bid_matrix', action: 'synced', matrix: { configId: 'c1', configName: 'M', source: 'salesforce_sync' }, changes: {
      added: [], removed: [], edited: [{ range: '500 to 549', is_sell_off: true, changes: [{ field: 'bid_amount', before: 2, after: 2.5 }] }],
    } })).slice(1)).toEqual([{ kind: 'change', label: 'Sell-off row 500 to 549 bid', from: '$2.00', to: '$2.50' }])
  })

  it('a kind of change this page has not met is shown by its raw name with its values, and counted', () => {
    const d = describeEntry(entry({ entityType: 'something_new' as HistoryEntry['entityType'], action: 'updated', changes: { cap: { old: 1, new: 2 }, note: 'x', _source: 'job' } }))
    expect(d.lines).toEqual([
      { kind: 'text', text: 'something_new updated.' },
      { kind: 'change', label: 'cap', from: '1', to: '2' },
      { kind: 'text', text: 'note: x' },
    ])
    expect(d.unregistered).toEqual(['something_new'])
  })

  it('a sync that changed nothing still says what it read', () => {
    expect(lines(entry({ source: 'bid_config_history', entityType: 'bid_matrix', action: 'synced', matrix: { configId: 'c1', configName: null, source: 'salesforce_sync' }, changes: { rows_fetched: 3, added: [], removed: [], edited: [] } }))).toEqual([
      { kind: 'text', text: 'Bid matrix: no rows changed (3 rows read from Salesforce).' },
    ])
  })
})

describe('days and the pickup note', () => {
  it('groups by the Eastern day, newest first, so a change at 11 PM Eastern is on that day', () => {
    const a = entry({ key: 'a', at: '2026-10-15T03:30:00Z' }) // Oct 14, 11:30 PM ET
    const b = entry({ key: 'b', at: '2026-10-14T20:00:00Z' }) // Oct 14, 4:00 PM ET
    const c = entry({ key: 'c', at: '2026-10-13T13:00:00Z' })
    const now = Date.parse('2026-10-15T16:00:00Z')
    expect(groupByEtDay([a, b, c], now).map((d) => [d.heading, d.entries.map((e) => e.key)])).toEqual([
      ['Yesterday', ['a', 'b']],
      ['Tue, Oct 13', ['c']],
    ])
  })

  it('a change with no actor, still inside the pickup bound, says when bidding picks it up; a person\'s or an old one does not', () => {
    const at = '2026-10-15T16:00:00Z'
    const direct = entry({ at, editor: { kind: 'direct' }, editorLabel: 'Changed directly in the database' })
    expect(pickupNote(direct, Date.parse(at) + 60_000)).toBe('Bidding picks this up within about 8 minutes of that time while the database is reachable.')
    expect(pickupNote({ ...direct, entityType: 'buyer_profile' }, Date.parse(at) + 60_000)).toBe('Bidding picks this up within about 3 minutes of that time while the database is reachable.')
    expect(pickupNote({ ...direct, entityType: 'buyer_profile' }, Date.parse(at) + 3 * 60_000 + 1)).toBeNull()
    expect(pickupNote(direct, Date.parse(at) + 8 * 60_000 + 1)).toBeNull()
    expect(pickupNote(entry({ at }), Date.parse(at) + 60_000)).toBeNull()
    expect(pickupNote({ ...direct, entityType: 'held_click' }, Date.parse(at) + 60_000)).toBeNull()
  })
})
