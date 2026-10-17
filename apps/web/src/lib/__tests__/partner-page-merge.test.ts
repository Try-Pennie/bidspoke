/**
 * mergeThreeWay (#2134, PM-3): the one three way merge of the partners page.
 *
 * A save refused because someone else saved first carries both halves as they
 * are stored now. The page merges them with what it loaded (base) and what is
 * on screen (mine): a field only one person changed takes that change, and only
 * a field or row group both changed to different values asks a question. Row
 * lists merge by row group, because a window's key contains its opening minute
 * and a tier's its lower bound, so moving either would otherwise read as a
 * delete plus an add. The rebuilt profile is judged the way the save judges it,
 * against the partner rules as the merge leaves them.
 */
import { describe, expect, it } from 'vitest'
import { parseProfileDocument, type BuyerProfileDocument } from '@bidspoke/buyer-profile'
import type { PartnerBody } from '@/lib/api'
import { PARTNER_FIELD_REGISTRY } from '@/app/(app)/partners/partner-draft'
import { changedUnits, mergeThreeWay, type PageHalves } from '../partner-page-merge'

const ACCEPT = [{ field: 'ok', equals: true }]

const partner: PartnerBody = {
  name: 'Tripoint', partner_type: 'buyer', api_endpoint: 'https://tripoint.example/leads', cf_secret_key: null, click_url: 'https://trypennie.com/portal/tpl',
  is_active: true, priority: 2, daily_cap: 250, min_bid: null, bid_formula: null, bid_resolver_type: 'api', bid_resolver_config: {},
  outbound_field_mapping: { first_name: 'fname' }, bid_comparison_source: 'auto', extra_extraction: null, last_probe_response: null,
  dedup_endpoint: null, circuit_enabled: true, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 300,
  response_classification: null, accept_signals: ACCEPT, duplicate_signals: [], external_routing_code: 2,
  alert_config: { transient_errors: { alert: true }, permanent_errors: { alert: true } }, sell_off_offer_title: null, sell_off_offer_details: null,
  sub_account_min_bids: null, confirmation_window_ms: null,
}

const profile: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1020 }],
  blackout_dates: [{ date: '2027-12-25', note: 'Christmas' }],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: 30000, multiplier: 0.0012 }, { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 }],
  click_delivery: null,
}

const base: PageHalves = { partner, profile }
const side = (p: Partial<PartnerBody> = {}, doc: Partial<BuyerProfileDocument> = {}): PageHalves => ({ partner: { ...partner, ...p }, profile: { ...profile, ...doc } })
const theirsAt = (p: Partial<PartnerBody> = {}, doc: Partial<BuyerProfileDocument> = {}): PageHalves => side(p, { version: 4, ...doc })

const conflictKeys = (r: ReturnType<typeof mergeThreeWay>) => r.conflicts.flatMap((s) => s.conflicts.map((c) => c.key))

describe('mergeThreeWay', () => {
  it('disjoint edits merge with no question, keeping both', () => {
    const r = mergeThreeWay(base, side({ name: 'Tripoint 2' }, { daily_lead_cap: 600 }), theirsAt({ is_active: false }, { debt_min: 20000 }), PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual([])
    expect(r.merged.partner).toMatchObject({ name: 'Tripoint 2', is_active: false })
    expect(r.merged.profile).toMatchObject({ daily_lead_cap: 600, debt_min: 20000, version: 4 })
    expect(r.autoTaken.map((k) => k.label)).toEqual(['Status', 'Debt minimum'])
    expect(r.mineKept.map((k) => k.label)).toEqual(['Name', 'Leads per day'])
  })

  it('the same field edited by both to different values asks once, showing all three values', () => {
    const r = mergeThreeWay(base, side({}, { daily_lead_cap: 600 }), theirsAt({}, { daily_lead_cap: 250 }), PARTNER_FIELD_REGISTRY)
    expect(r.conflicts).toEqual([{ section: 'Caps', tab: 'buyer_profile', conflicts: [expect.objectContaining({ key: 'profile.daily_lead_cap', label: 'Leads per day', base: 500, mine: 600, theirs: 250, reason: null })] }])
    // Undecided, the merge keeps yours; a choice of theirs takes theirs.
    expect(r.merged.profile?.daily_lead_cap).toBe(600)
    const chosen = mergeThreeWay(base, side({}, { daily_lead_cap: 600 }), theirsAt({}, { daily_lead_cap: 250 }), PARTNER_FIELD_REGISTRY, { 'profile.daily_lead_cap': 'theirs' })
    expect(chosen.merged.profile?.daily_lead_cap).toBe(250)
    expect(conflictKeys(chosen)).toEqual(['profile.daily_lead_cap'])
  })

  it('the same value on both sides is not a conflict', () => {
    const r = mergeThreeWay(base, side({ name: 'TPL' }, { daily_lead_cap: 600 }), theirsAt({ name: 'TPL' }, { daily_lead_cap: 600 }), PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual([])
    expect(r.autoTaken).toEqual([])
    expect(r.merged.partner.name).toBe('TPL')
  })

  it('the display time zone (#2143) merges as a profile scalar: one side changed is taken, both changed asks', () => {
    const one = mergeThreeWay(base, side({}, { daily_lead_cap: 600 }), theirsAt({}, { display_time_zone: 'America/Chicago' }), PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(one)).toEqual([])
    expect(one.merged.profile).toMatchObject({ daily_lead_cap: 600, display_time_zone: 'America/Chicago' })
    expect(one.autoTaken.map((k) => k.label)).toEqual(['Time zone'])
    const both = mergeThreeWay(base, side({}, { display_time_zone: 'America/Denver' }), theirsAt({}, { display_time_zone: 'America/Chicago' }), PARTNER_FIELD_REGISTRY)
    expect(both.conflicts.flatMap((sec) => sec.conflicts).map((c) => [c.key, c.label, c.mine, c.theirs])).toEqual([['profile.display_time_zone', 'Time zone', 'America/Denver', 'America/Chicago']])
  })

  it('a whole JSON column is one field, compared regardless of key order', () => {
    const r = mergeThreeWay(base, side({ outbound_field_mapping: { first_name: 'fn', last_name: 'ln' } }), theirsAt({ outbound_field_mapping: { last_name: 'ln', first_name: 'fn' } }), PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual([])
    const clash = mergeThreeWay(base, side({ outbound_field_mapping: { first_name: 'a' } }), theirsAt({ outbound_field_mapping: { first_name: 'b' } }), PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(clash)).toEqual(['outbound_field_mapping'])
  })

  it('both people moving the same tier\'s lower bound to different values is one conflict, never two tiers', () => {
    const mine = side({}, { tiers: [{ population: 'engine', debt_from: 15000, debt_to: 32000, multiplier: 0.0012 }, { population: 'engine', debt_from: 32000, debt_to: null, multiplier: 0.001 }] })
    const theirs = theirsAt({}, { tiers: [{ population: 'engine', debt_from: 15000, debt_to: 28000, multiplier: 0.0012 }, { population: 'engine', debt_from: 28000, debt_to: null, multiplier: 0.001 }] })
    const r = mergeThreeWay(base, mine, theirs, PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual(['profile.tiers@engine'])
    const [c] = r.conflicts[0].conflicts
    expect(c.label).toBe('Pricing, Engine')
    expect(c.mine).toEqual(mine.profile!.tiers)
    expect(c.theirs).toEqual(theirs.profile!.tiers)
    expect(r.merged.profile?.tiers).toEqual(mine.profile!.tiers)
    expect(mergeThreeWay(base, mine, theirs, PARTNER_FIELD_REGISTRY, { 'profile.tiers@engine': 'theirs' }).merged.profile?.tiers).toEqual(theirs.profile!.tiers)
  })

  it('one person moving a Monday window\'s opening time while the other adds a Tuesday window keeps both, with no question', () => {
    const mine = side({}, { windows: [{ day_of_week: 1, opens_minute: 600, closes_minute: 1020 }] })
    const theirs = theirsAt({}, { windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1020 }, { day_of_week: 2, opens_minute: 540, closes_minute: 1020 }] })
    const r = mergeThreeWay(base, mine, theirs, PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual([])
    expect(r.merged.profile?.windows).toEqual([{ day_of_week: 1, opens_minute: 600, closes_minute: 1020 }, { day_of_week: 2, opens_minute: 540, closes_minute: 1020 }])
    expect(r.autoTaken.map((k) => k.label)).toEqual(['Hours (Eastern), Tuesday'])
  })

  it('one person moving a window\'s opening time while the other deletes it is one conflict', () => {
    const r = mergeThreeWay(base, side({}, { windows: [{ day_of_week: 1, opens_minute: 600, closes_minute: 1020 }] }), theirsAt({}, { windows: [] }), PARTNER_FIELD_REGISTRY)
    expect(r.conflicts).toEqual([{ section: 'Hours', tab: 'buyer_profile', conflicts: [expect.objectContaining({ key: 'profile.windows@1', label: 'Hours (Eastern), Monday', mine: [{ day_of_week: 1, opens_minute: 600, closes_minute: 1020 }], theirs: [] })] }])
  })

  it('a merge the validator refuses becomes a conflict, judged against the partner rules as the merge leaves them', () => {
    // Base is a disabled profile with accept rules; I enable it, they clear the
    // accept rules. Each side alone is valid; together an enabled offer buyer
    // has no accept rules, which save_buyer_profile refuses.
    const disabled = { ...base, profile: { ...profile, is_enabled: false } }
    const mine: PageHalves = { partner, profile: { ...profile, is_enabled: true } }
    const theirs: PageHalves = { partner: { ...partner, accept_signals: [] }, profile: { ...profile, is_enabled: false, version: 4 } }
    const r = mergeThreeWay(disabled, mine, theirs, PARTNER_FIELD_REGISTRY)
    const all = r.conflicts.flatMap((s) => s.conflicts)
    expect(all.map((c) => c.key)).toEqual(['accept_signals'])
    expect(all[0]).toMatchObject({ section: 'Outcome rules', mine: ACCEPT, theirs: [], reason: expect.stringMatching(/accept/i) })
    expect(r.autoTaken).toEqual([])
    // The same merge with their rules kept is still not offered as clean.
    expect(mergeThreeWay(disabled, mine, { ...theirs, partner }, PARTNER_FIELD_REGISTRY).conflicts).toEqual([])
  })

  it('a refused merge names the field one side changed: raising the hourly cap while they lower the daily one', () => {
    const r = mergeThreeWay(base, side({}, { hourly_lead_cap: 100 }), theirsAt({}, { daily_lead_cap: 50 }), PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual(['profile.hourly_lead_cap'])
    expect(r.conflicts[0].conflicts[0]).toMatchObject({ mine: 100, theirs: null, reason: expect.stringMatching(/hourly/i) })
    expect(r.autoTaken.map((k) => k.label)).toEqual(['Leads per day'])
  })

  it('a refused merge whose named field both sides agree on asks about every one sided change instead', () => {
    // A stored profile with two Monday windows that overlap (saved outside the
    // page, or before the rule): the validator names Hours, which neither
    // person changed, so the changes each made become the questions. PR4's (#2135)
    // live merge reaches this with edits still in progress.
    const overlapping = [{ day_of_week: 1, opens_minute: 540, closes_minute: 1020 }, { day_of_week: 1, opens_minute: 600, closes_minute: 700 }]
    const start: PageHalves = { partner, profile: { ...profile, windows: overlapping } }
    const r = mergeThreeWay(start, { partner, profile: { ...profile, windows: overlapping, daily_lead_cap: 600 } }, { partner, profile: { ...profile, windows: overlapping, debt_min: 20000, version: 4 } }, PARTNER_FIELD_REGISTRY)
    const all = r.conflicts.flatMap((s) => s.conflicts)
    expect(all.map((c) => c.key).sort()).toEqual(['profile.daily_lead_cap', 'profile.debt_min'])
    expect(all.every((c) => /overlap/i.test(c.reason ?? ''))).toBe(true)
    expect(r.autoTaken).toEqual([])
    expect(r.mineKept).toEqual([])
  })

  it('judges a change of kind against what their save stored, which is the version this save is made against', () => {
    // Nothing stored that locks the kind when I switched to click; they then
    // stored a tier. The merged save is made at their version, where that tier
    // locks the kind, so the switch is a question, not a clean merge.
    const offer = { ...profile, is_enabled: false, tiers: [] }
    const bare: PageHalves = { partner: { ...partner, accept_signals: [] }, profile: offer }
    const mine: PageHalves = { partner: { ...partner, accept_signals: [] }, profile: { ...offer, sold_on: 'click', priority: null } }
    const theirs: PageHalves = { partner: { ...partner, accept_signals: [] }, profile: { ...offer, version: 4, tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.001 }] } }
    const r = mergeThreeWay(bare, mine, theirs, PARTNER_FIELD_REGISTRY)
    const soldOn = r.conflicts.flatMap((sec) => sec.conflicts).find((c) => c.key === 'profile.sold_on')
    expect(soldOn?.reason).toMatch(/Remove the stored pricing/)
  })

  it('two edits to different tier populations rebuild one document that parses', () => {
    const r = mergeThreeWay(
      base,
      side({}, { tiers: [...profile.tiers.slice(0, 1), { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.002 }] }),
      theirsAt({}, { tiers: [...profile.tiers, { population: 'main_flow', debt_from: 0, debt_to: null, multiplier: 0.001 }] }),
      PARTNER_FIELD_REGISTRY,
    )
    // Main Flow is not sold through buyer selection yet, so the validator asks
    // about the pricing; the rebuild still holds both people's tiers.
    const tiers = r.merged.profile!.tiers
    expect(tiers).toContainEqual({ population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.002 })
    expect(tiers).toContainEqual({ population: 'main_flow', debt_from: 0, debt_to: null, multiplier: 0.001 })
    expect(tiers).toHaveLength(3)
    expect(parseProfileDocument(r.merged.profile)).toMatchObject({ ok: true })
  })

  it('click routes merge as one list and the success line on its own: one each, no question', () => {
    const delivery = { success_pattern: '(?<id>\\w+)', routes: [{ name: 'DV1', url: 'https://a.example/dv1', states: ['WA'] }, { name: 'DI4', url: 'https://a.example/di4', states: [] }] }
    const click = { ...profile, sold_on: 'click' as const, priority: null, tiers: [], click_delivery: delivery }
    const clickPartner = { ...partner, accept_signals: [], click_url: 'https://trypennie.com/portal/x/{prospect_id}' }
    const b: PageHalves = { partner: clickPartner, profile: click }
    const moved = { ...delivery, routes: [{ ...delivery.routes[0], url: 'https://b.example/dv1' }, delivery.routes[1]] }
    const r = mergeThreeWay(b, { partner: clickPartner, profile: { ...click, click_delivery: { ...delivery, success_pattern: '(?<id>\\d+)' } } }, { partner: clickPartner, profile: { ...click, version: 4, click_delivery: moved } }, PARTNER_FIELD_REGISTRY)
    expect(conflictKeys(r)).toEqual([])
    expect(r.merged.profile?.click_delivery).toEqual({ success_pattern: '(?<id>\\d+)', routes: moved.routes })
    const both = mergeThreeWay(b, { partner: clickPartner, profile: { ...click, click_delivery: { ...delivery, routes: [delivery.routes[1]] } } }, { partner: clickPartner, profile: { ...click, version: 4, click_delivery: moved } }, PARTNER_FIELD_REGISTRY)
    expect(both.conflicts.flatMap((s) => s.conflicts.map((c) => [c.key, c.label]))).toEqual([['profile.click_delivery.routes', 'Routes']])
  })

  it('takes their whole profile object when nothing of mine goes into it, so it does not read as an edit', () => {
    const theirs = theirsAt({}, { daily_lead_cap: 250 })
    const r = mergeThreeWay(base, side({ name: 'TPL' }), theirs, PARTNER_FIELD_REGISTRY)
    expect(r.merged.profile).toBe(theirs.profile)
  })

  it('groups conflicts by section in the order the registry lists them', () => {
    const r = mergeThreeWay(base, side({ name: 'A' }, { daily_lead_cap: 1, debt_min: 1 }), theirsAt({ name: 'B' }, { daily_lead_cap: 2, debt_min: 2 }), PARTNER_FIELD_REGISTRY)
    expect(r.conflicts.map((s) => s.section)).toEqual(['Identity', 'Eligibility', 'Caps'])
  })

  it('leaves a profile alone when the page never read one', () => {
    const r = mergeThreeWay({ partner, profile: null }, { partner: { ...partner, name: 'A' }, profile: null }, { partner: { ...partner, is_active: false }, profile: null }, PARTNER_FIELD_REGISTRY)
    expect(r.merged).toEqual({ partner: { ...partner, name: 'A', is_active: false }, profile: null })
  })
})

describe('changedUnits (#2138): what the save bar and the leave dialog name', () => {
  it('names every unit changed from base, by the page\'s labels, in registry order, a row group by its day', () => {
    const mine = side({ name: 'Tripoint 2', is_active: false }, { daily_lead_cap: 600, windows: [{ day_of_week: 1, opens_minute: 600, closes_minute: 1020 }] })
    expect(changedUnits(base, mine, PARTNER_FIELD_REGISTRY).map((u) => u.label)).toEqual(['Name', 'Status', 'Leads per day', 'Hours (Eastern), Monday'])
  })

  it('names nothing for a page equal to base, whatever order the database left an object\'s keys in', () => {
    const reordered = { ...partner, alert_config: { permanent_errors: { alert: true }, transient_errors: { alert: true } } }
    expect(changedUnits(base, { partner: reordered, profile: { ...profile } }, PARTNER_FIELD_REGISTRY)).toEqual([])
  })

  it('a row added where there were none, and click delivery set up, each count once', () => {
    const delivery = { success_pattern: 'OK', routes: [{ name: 'All', url: 'https://x.example/a', states: [] }] }
    const mine = side({}, { blackout_dates: [...profile.blackout_dates, { date: '2027-01-01', note: null }], click_delivery: delivery })
    expect(changedUnits(base, mine, PARTNER_FIELD_REGISTRY).map((u) => u.label)).toEqual(['Blackout dates', 'Success reply', 'Routes'])
  })

  it('a draft mid edit that no registry path names yet (a route with no name) names the profile whole, never throws', () => {
    const mine = side({ name: 'Tripoint 2' }, { click_delivery: { success_pattern: 'OK', routes: [{ name: '', url: 'https://x.example/a', states: [] }] } })
    expect(changedUnits(base, mine, PARTNER_FIELD_REGISTRY).map((u) => u.label)).toEqual(['Name', 'Buyer profile'])
  })

  it('never throws in render: a partner key the registry does not name once is named by its key', () => {
    const withoutName = PARTNER_FIELD_REGISTRY.filter((e) => e.pattern !== 'name')
    const units = changedUnits({ partner, profile: null }, { partner: { ...partner, name: 'X', min_bid: 5 }, profile: null }, withoutName)
    expect(units.map((u) => u.label)).toEqual(['Minimum bid ($)', 'name'])
  })

  it('compares the partner alone when the page never read a profile', () => {
    expect(changedUnits({ partner, profile: null }, { partner: { ...partner, min_bid: 5 }, profile: null }, PARTNER_FIELD_REGISTRY).map((u) => u.key)).toEqual(['min_bid'])
  })
})
