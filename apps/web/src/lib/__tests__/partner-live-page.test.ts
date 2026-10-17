/**
 * What the partners page does with the live channel (#2135, PR4 of #2114),
 * the parts that are rules rather than React: which notice it acts on, when its
 * versions probe has found a change no notice announced and what it reports,
 * the "Changed directly in the database" notes and how long they stand, and the
 * sentences the page says about another person's save.
 */
import { describe, expect, it } from 'vitest'
import type { PartnerPageNotice, PartnerPageVersions } from '@bidspoke/partner-page-live'
import { BIDDING_PICKUP } from '../bidding-pickup'
import {
  classifyNotice, directChangeNotes, liveConflictSentence, liveMissReport, liveTakenSentence, partitionRefusalReport, probeFindsGap, savedByName, tabClientId,
  updatedByNotes, askedOnly,
} from '../partner-live-page'
import type { MergeResult } from '../partner-page-merge'

const PARTNER = '2b0c6c39-1d1e-4a3f-9d0f-3c0b5a6e7f81'
const OTHER = '7e0c6c39-1d1e-4a3f-9d0f-3c0b5a6e7f82'
const MY_TAB = '11111111-1111-4111-8111-111111111111'
const MY_SAVE = '22222222-2222-4222-8222-222222222222'
const UNKNOWN_SAVE = '33333333-3333-4333-8333-333333333333'

const notice = (over: Partial<PartnerPageNotice> = {}): PartnerPageNotice => ({
  partnerId: PARTNER, partnerVersion: 8, profileVersion: 3, saveId: null, clientId: null, kind: 'partner', changedColumns: ['daily_cap'], direct: false, ...over,
})
const ctx = (over: Partial<Parameters<typeof classifyNotice>[1]> = {}) => ({
  partnerId: PARTNER, clientId: MY_TAB, ownSaveIds: new Set([MY_SAVE]), unknownSaveId: null, known: { partnerVersion: 7, profileVersion: 3 }, ...over,
})

describe('classifyNotice (#2135)', () => {
  it('refetches for another person\'s save of the open partner', () => {
    expect(classifyNotice(notice(), ctx())).toBe('refetch')
    expect(classifyNotice(notice({ kind: 'page', saveId: '44444444-4444-4444-8444-444444444444', clientId: '55555555-5555-4555-8555-555555555555' }), ctx())).toBe('refetch')
  })

  it('ignores another partner, and the delivery monitor\'s ping', () => {
    expect(classifyNotice(notice({ partnerId: OTHER }), ctx())).toBe('ignore')
    expect(classifyNotice(notice({ kind: 'monitor' }), ctx())).toBe('ignore')
  })

  it('knows its own echo only by this tab\'s client_id AND a save_id it sent, never by who saved (L747)', () => {
    expect(classifyNotice(notice({ kind: 'page', saveId: MY_SAVE, clientId: MY_TAB }), ctx())).toBe('echo')
    // The same person in another tab: a different client_id, so it is merged like anyone else's.
    expect(classifyNotice(notice({ kind: 'page', saveId: MY_SAVE, clientId: '66666666-6666-4666-8666-666666666666' }), ctx())).toBe('refetch')
    // This tab, but a save id it never sent.
    expect(classifyNotice(notice({ kind: 'page', saveId: '77777777-7777-4777-8777-777777777777', clientId: MY_TAB }), ctx())).toBe('refetch')
  })

  it('never ignores a save whose outcome is unknown: a notice carrying its save_id resolves it', () => {
    const c = ctx({ unknownSaveId: UNKNOWN_SAVE, ownSaveIds: new Set([MY_SAVE, UNKNOWN_SAVE]) })
    expect(classifyNotice(notice({ kind: 'page', saveId: UNKNOWN_SAVE, clientId: MY_TAB }), c)).toBe('resolves_unknown')
  })

  it('a sub-account ID change re-reads the list; a deleted partner is said; versions already held are not refetched', () => {
    expect(classifyNotice(notice({ kind: 'uuids', partnerVersion: 7 }), ctx())).toBe('uuids')
    expect(classifyNotice(notice({ kind: 'deleted', partnerVersion: null, profileVersion: null }), ctx())).toBe('deleted')
    expect(classifyNotice(notice({ partnerVersion: 7, profileVersion: 3 }), ctx())).toBe('already_held')
    // A profile the page never read is not compared on.
    expect(classifyNotice(notice({ kind: 'profile', partnerVersion: 7, profileVersion: 9 }), ctx({ known: { partnerVersion: 7, profileVersion: null } }))).toBe('already_held')
    expect(classifyNotice(notice({ kind: 'profile', partnerVersion: 7, profileVersion: 4 }), ctx())).toBe('refetch')
  })

  it('a notice whose partner version it cannot compare is read again, never taken as already held (L50)', () => {
    expect(classifyNotice(notice({ kind: 'partner', partnerVersion: null, profileVersion: 3 }), ctx())).toBe('refetch')
    // A profile notice with no profile version, for a page that read the profile.
    expect(classifyNotice(notice({ kind: 'profile', partnerVersion: 7, profileVersion: null }), ctx())).toBe('refetch')
    expect(classifyNotice(notice({ kind: 'profile', partnerVersion: 7, profileVersion: null }), ctx({ known: { partnerVersion: 7, profileVersion: null } }))).toBe('already_held')
  })
})

const versions = (over: Partial<PartnerPageVersions> = {}): PartnerPageVersions => ({
  partnerId: PARTNER, partnerVersion: 7, profileVersion: 3, lastSaveId: null, profileLastSaveId: null, latestChange: null, newest: { partner: null, profile: null }, ...over,
})

describe('the versions probe (#2135)', () => {
  it('finds a gap when either version is past the one the page holds, and none when the profile was never read', () => {
    expect(probeFindsGap({ partnerVersion: 7, profileVersion: 3 }, versions())).toBe(false)
    expect(probeFindsGap({ partnerVersion: 7, profileVersion: 3 }, versions({ partnerVersion: 8 }))).toBe(true)
    expect(probeFindsGap({ partnerVersion: 7, profileVersion: 3 }, versions({ profileVersion: 4 }))).toBe(true)
    expect(probeFindsGap({ partnerVersion: 7, profileVersion: null }, versions({ profileVersion: 4 }))).toBe(false)
  })

  it('reports a miss as direct_sql when the change had no actor, otherwise delivery, with the versions held, the versions seen and the gap', () => {
    const at = '2026-10-16T01:00:00.000Z'
    const direct = versions({ partnerVersion: 8, latestChange: { section: 'partner', changedAt: at, direct: true, fields: ['daily_cap'] } })
    expect(liveMissReport(direct, { partnerVersion: 7, profileVersion: 3 }, 1_000, 61_000)).toEqual({
      partner_id: PARTNER, cause: 'direct_sql',
      noticed: { partner_version: 7, profile_version: 3 }, observed: { partner_version: 8, profile_version: 3 },
      since_last_notice_ms: 60_000,
    })
    const r = liveMissReport(versions({ profileVersion: 4, latestChange: { section: 'profile', changedAt: at, direct: false, fields: ['debt_max'] } }), { partnerVersion: 7, profileVersion: null }, null, 61_000)
    expect(r.cause).toBe('delivery')
    expect(r.noticed).toEqual({ partner_version: 7, profile_version: null })
    expect(r.since_last_notice_ms).toBeNull()
    // A page open longer than a day reports the longest gap the route accepts, not a value it refuses.
    expect(liveMissReport(direct, { partnerVersion: 7, profileVersion: 3 }, 0, 3 * 86_400_000).since_last_notice_ms).toBe(86_400_000)
  })
})

describe('partitionRefusalReport (#2288)', () => {
  it('reports a join refused for a missing partition, with what the page last heard and nothing observed', () => {
    expect(partitionRefusalReport(PARTNER, { partnerVersion: 7, profileVersion: 3 }, 1_000, 61_000)).toEqual({
      partner_id: PARTNER, cause: 'missing_partition',
      noticed: { partner_version: 7, profile_version: 3 }, observed: { partner_version: null, profile_version: null },
      since_last_notice_ms: 60_000,
    })
    expect(partitionRefusalReport(PARTNER, { partnerVersion: 7, profileVersion: null }, null, 61_000).since_last_notice_ms).toBeNull()
  })
})

describe('directChangeNotes (#2135)', () => {
  const at = '2026-10-16T14:34:00.000Z'
  const atMs = Date.parse(at)

  it('a direct partner change younger than the constants bound is noted on the sections of its columns, with the constants figure, in ET', () => {
    const v = versions({ newest: { partner: { changedAt: at, direct: true, fields: ['daily_cap', 'sell_off_offer_title'] }, profile: null } })
    const notes = directChangeNotes(v, atMs + 60_000)
    expect(notes).toEqual([{
      // The sections the person sees the fields under: the sell-off offer is
      // "Sell-off offer" on the Workflow values tab (#2142).
      sections: ['Bidding limits', 'Sell-off offer'],
      text: `Changed directly in the database at 10:34 AM ET. Bidding picks this up within about ${BIDDING_PICKUP.partnerConstantsMinutes} minutes of that time while the database is reachable.`,
      expiresAt: atMs + BIDDING_PICKUP.partnerConstantsMinutes * 60_000,
    }])
    expect(directChangeNotes(v, atMs + BIDDING_PICKUP.partnerConstantsMinutes * 60_000)).toEqual([])
  })

  it('a direct profile change uses the profile figure; a child table names its list; a table it cannot place goes on the page', () => {
    const v = versions({ newest: { partner: null, profile: { changedAt: at, direct: true, fields: ['buyer_pricing_tiers'] } } })
    expect(directChangeNotes(v, atMs)).toEqual([{
      sections: ['Pricing'],
      text: `Changed directly in the database at 10:34 AM ET. Bidding picks this up within about ${BIDDING_PICKUP.buyerProfilesMinutes} minutes of that time while the database is reachable.`,
      expiresAt: atMs + BIDDING_PICKUP.buyerProfilesMinutes * 60_000,
    }])
    const whole = versions({ newest: { partner: null, profile: { changedAt: at, direct: true, fields: ['buyer_profiles'] } } })
    expect(directChangeNotes(whole, atMs)[0].sections).toEqual([])
    const column = versions({ newest: { partner: null, profile: { changedAt: at, direct: true, fields: ['debt_max', 'click_delivery'] } } })
    expect(directChangeNotes(column, atMs)[0].sections).toEqual(['Eligibility', 'Click delivery'])
  })

  it('an editor\'s change, or a direct one past its bound, notes nothing', () => {
    expect(directChangeNotes(versions({ newest: { partner: { changedAt: at, direct: false, fields: ['daily_cap'] }, profile: null } }), atMs)).toEqual([])
    expect(directChangeNotes(versions(), atMs)).toEqual([])
  })
})

describe('the sentences about another person\'s save (#2135)', () => {
  it('names them by name, by the email\'s first part, or not at all', () => {
    expect(savedByName({ updated_by_name: 'Brian Nelms', updated_by_email: 'b@x.com' })).toBe('Brian Nelms')
    expect(savedByName({ updated_by_name: null, updated_by_email: 'brian@x.com' })).toBe('brian')
    expect(savedByName({ updated_by_name: null, updated_by_email: null })).toBeNull()
  })

  it('the save bar sentence for fields both changed', () => {
    expect(liveConflictSentence('Brian Nelms', 2)).toBe('Brian Nelms changed 2 fields you are editing. You choose when you save.')
    expect(liveConflictSentence('Brian Nelms', 1)).toBe('Brian Nelms changed 1 field you are editing. You choose when you save.')
    expect(liveConflictSentence(null, 1)).toBe('Someone else changed 1 field you are editing. You choose when you save.')
  })

  it('the save bar sentence for a clean merge names what of theirs is now on screen', () => {
    const unit = (label: string) => ({ key: label, tab: 'partner' as const, section: 'Identity', label })
    expect(liveTakenSentence('Brian Nelms', [unit('Name')])).toBe('Brian Nelms saved this partner. Their change to Name is on screen.')
    expect(liveTakenSentence('Brian Nelms', [unit('Name'), unit('Status'), unit('List order')])).toBe('Brian Nelms saved this partner. Their changes to Name, Status and List order are on screen.')
    expect(liveTakenSentence(null, [])).toBe('Someone else saved this partner, with no change to anything shown here.')
  })

  it('a field no tab draws is never said to be on screen, nor noted on a section (#2137 offPage)', () => {
    const name = { key: 'name', tab: 'partner' as const, section: 'Identity', label: 'Name' }
    const listOrder = { key: 'priority', tab: 'partner' as const, section: 'Identity', label: 'List order (not shown on this page)' }
    expect(liveTakenSentence('Brian Nelms', [listOrder])).toBe('Brian Nelms saved this partner. They changed List order (not shown on this page).')
    expect(liveTakenSentence('Brian Nelms', [name, listOrder])).toBe('Brian Nelms saved this partner. Their change to Name is on screen. They also changed List order (not shown on this page).')
    expect(updatedByNotes('Brian Nelms', [name, listOrder])).toEqual([{ sections: ['Identity'], text: 'Updated by Brian Nelms: Name.' }])
    expect(updatedByNotes('Brian Nelms', [listOrder])).toEqual([])
  })

  it('Updated by notes go on the sections of what was taken, naming each field', () => {
    const notes = updatedByNotes('Brian Nelms', [
      { key: 'name', tab: 'partner', section: 'Identity', label: 'Name' },
      { key: 'is_active', tab: 'partner', section: 'Identity', label: 'Status' },
      { key: 'profile.debt_max', tab: 'buyer_profile', section: 'Eligibility', label: 'Debt maximum' },
    ])
    expect(notes).toEqual([
      { sections: ['Identity'], text: 'Updated by Brian Nelms: Name and Status.' },
      { sections: ['Eligibility'], text: 'Updated by Brian Nelms: Debt maximum.' },
    ])
  })
})

describe('askedOnly (#2135)', () => {
  it('keeps only the questions held from a live notice and any the validator raised, so a field edited after seeing theirs is not asked', () => {
    const c = (key: string, reason: string | null = null) => ({ key, tab: 'partner' as const, section: 'Identity', label: key, base: 1, mine: 2, theirs: 3, reason, choice: null })
    const result: MergeResult = {
      merged: { partner: {}, profile: null }, autoTaken: [], mineKept: [],
      conflicts: [{ section: 'Identity', tab: 'partner', conflicts: [c('name'), c('priority'), c('is_active', 'refused')] }, { section: 'Bidding limits', tab: 'bid_group', conflicts: [c('daily_cap')] }],
    }
    const kept = askedOnly(result, ['name'])
    expect(kept.conflicts).toEqual([{ section: 'Identity', tab: 'partner', conflicts: [c('name'), c('is_active', 'refused')] }])
  })
})

describe('tabClientId', () => {
  it('is one UUID for the life of the tab', () => {
    expect(tabClientId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(tabClientId()).toBe(tabClientId())
  })
})
