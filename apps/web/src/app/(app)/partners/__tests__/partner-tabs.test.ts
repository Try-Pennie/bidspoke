/**
 * Which tabs a partner shows, where it opens, and where its problems are
 * (#2137, PM-1, PM-12).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PartnerBody, PartnerUsage } from '@/lib/api'
import { REPO_ROOT } from '@/lib/__tests__/_scan-utils'
import { buildPartnerBody, PARTNER_BODY_KEYS, PARTNER_FIELD_REGISTRY, registryEntriesFor, snapshotOf } from '../partner-draft'
import {
  bidGroupSettingsSet, bidGroupShown, canAddBidGroup, confirmationWindowShown, openingTab, partnersUrl, problemsOf, problemTabs,
  tabFromParam, visibleTabs, TAB_ORDER, type TabInputs, type UsageState,
} from '../partner-tabs'
import { refusalPaths, validatorPaths } from './_validator-paths'

const blank = (): PartnerBody => buildPartnerBody(snapshotOf(undefined), { slug: 'x', isExisting: true })
const none: PartnerUsage = { bid_group: [], partner_bid: [], latency_gate: [] }
const found = (u: Partial<PartnerUsage> = {}): UsageState => ({ kind: 'found', usage: { ...none, ...u } })
const step = (over: Record<string, unknown> = {}) => ({ workflow_id: 'w', workflow_name: 'Main Flow', is_active: true, node_id: 'n', ...over })
const inputs = (over: Partial<TabInputs> = {}): TabInputs => ({ isBuyer: true, isNew: false, body: blank(), soldOn: null, usage: found(), bidGroupAdded: false, bidGroupNeeded: false, ...over })

describe('the URL', () => {
  it('one builder for the partner and the tab, every tab round trips', () => {
    for (const t of TAB_ORDER) expect(tabFromParam(new URL(`https://x${partnersUrl({ selected: 'tripoint', tab: t })}`).searchParams.get('tab'))).toBe(t)
    expect(partnersUrl({ selected: 'tripoint', tab: 'buyer_profile' })).toBe('/partners?selected=tripoint&tab=buyer-profile')
    expect(partnersUrl({ selected: 'tripoint', tab: null })).toBe('/partners?selected=tripoint')
    expect(partnersUrl({ selected: null, tab: 'history' })).toBe('/partners')
    expect(tabFromParam('nonsense')).toBeNull()
    expect(tabFromParam(null)).toBeNull()
  })
})

describe('Bid Group settings', () => {
  it('a new partner has none, and any one Bid Group field counts', () => {
    expect(bidGroupSettingsSet(blank())).toBe(false)
    expect(bidGroupSettingsSet({ ...blank(), min_bid: 3.08 })).toBe(true)
    expect(bidGroupSettingsSet({ ...blank(), api_endpoint: 'https://x' })).toBe(true)
    expect(bidGroupSettingsSet({ ...blank(), confirmation_window_ms: 5000 })).toBe(true)
    expect(bidGroupSettingsSet({ ...blank(), circuit_enabled: false })).toBe(true)
  })

  it('decline rules alone are the Buyer profile tab\'s, and do not make Bid Group apply', () => {
    expect(bidGroupSettingsSet({ ...blank(), response_classification: { rejection_signals: [{ field: 'ok', equals: false }] } })).toBe(false)
    expect(bidGroupSettingsSet({ ...blank(), response_classification: { transient_signals: [{ status_code: 503 }] } })).toBe(true)
  })

  it('values on another tab do not count', () => {
    expect(bidGroupSettingsSet({ ...blank(), click_url: 'https://x', sub_account_min_bids: { a: 1 }, name: 'Acme', is_active: false })).toBe(false)
  })
})

describe('which tabs show', () => {
  it('a source with nothing set: Partner, Workflow values and History', () => {
    expect(visibleTabs(inputs({ isBuyer: false }))).toEqual(['partner', 'workflow_values', 'history'])
  })

  it('a buyer always has Buyer profile, and a new partner no History', () => {
    expect(visibleTabs(inputs())).toEqual(['partner', 'buyer_profile', 'workflow_values', 'history'])
    expect(visibleTabs(inputs({ isNew: true }))).toEqual(['partner', 'buyer_profile', 'workflow_values'])
  })

  it('Bid Group shows when a Bid Group or Partner Bid step names the partner, a switched off workflow included', () => {
    expect(bidGroupShown(inputs({ usage: found({ bid_group: [{ ...step({ is_active: false }), mode: 'highest_bid', partner_ids: ['p'], fallback_partner_id: null }] }) }))).toBe(true)
    expect(bidGroupShown(inputs({ usage: found({ partner_bid: [step()] }) }))).toBe(true)
    expect(bidGroupShown(inputs({ usage: found({ latency_gate: [step()] }) }))).toBe(false)
    expect(bidGroupShown(inputs())).toBe(false)
  })

  it('Bid Group shows for a failed read, with its error, and not for one still running unless something else says so', () => {
    expect(bidGroupShown(inputs({ usage: { kind: 'failed', message: 'x' } }))).toBe(true)
    expect(bidGroupShown(inputs({ usage: { kind: 'loading' } }))).toBe(false)
    expect(bidGroupShown(inputs({ usage: { kind: 'loading' }, body: { ...blank(), min_bid: 1 } }))).toBe(true)
    expect(bidGroupShown(inputs({ usage: { kind: 'loading' }, bidGroupNeeded: true }))).toBe(true)
  })

  it('Bid Group shows after Set up for Bid Group, and for an offer buyer, whom buyer selection calls with these settings', () => {
    expect(bidGroupShown(inputs({ bidGroupAdded: true }))).toBe(true)
    expect(bidGroupShown(inputs({ soldOn: 'offer' }))).toBe(true)
    expect(bidGroupShown(inputs({ soldOn: 'click' }))).toBe(false)
  })

  it('Set up for Bid Group is offered to a buyer whose Bid Group tab is not shown, and never to a source', () => {
    expect(canAddBidGroup(inputs())).toBe(true)
    expect(canAddBidGroup(inputs({ bidGroupAdded: true }))).toBe(false)
    expect(canAddBidGroup(inputs({ isBuyer: false }))).toBe(false)
  })

  it('the confirmation window shows for a Latency Gate, a value or a set up, and whenever the read has not said none', () => {
    expect(confirmationWindowShown(found(), '', false)).toBe(false)
    expect(confirmationWindowShown(found({ latency_gate: [step()] }), '', false)).toBe(true)
    expect(confirmationWindowShown(found(), '5000', false)).toBe(true)
    expect(confirmationWindowShown(found(), '', true)).toBe(true)
    expect(confirmationWindowShown({ kind: 'loading' }, '', false)).toBe(true)
    expect(confirmationWindowShown({ kind: 'failed', message: 'x' }, '', false)).toBe(true)
  })
})

describe('problems (PM-12)', () => {
  it('a missing credential is about the secret field, on the Bid Group tab', () => {
    expect(problemsOf({ credentialWarning: "Credential 'X' is not set.", errors: [] })).toEqual([{ registryPath: 'cf_secret_key', tab: 'bid_group', message: "Credential 'X' is not set." }])
  })

  it('every path the validator can refuse, and every path a database refusal is named by, maps to a tab', () => {
    const paths = [...validatorPaths(), ...refusalPaths()]
    expect(refusalPaths().size).toBeGreaterThan(3)
    const unmapped = paths.filter((p) => problemsOf({ credentialWarning: null, errors: [{ path: p, message: 'm' }], routeNames: ['DV1'] })[0].tab === null)
    expect(unmapped).toEqual([])
  })

  it('a field the save refused as not editable is named by its own key, and every key maps to a tab', () => {
    for (const key of PARTNER_BODY_KEYS.filter((k) => !registryEntriesFor(k)[0]?.offPage)) expect(problemsOf({ credentialWarning: null, errors: [{ path: key, field: key, message: 'm' }] })[0].tab, key).not.toBeNull()
  })

  it('the server\'s registry path wins over the validator path, and a path no field matches is a page level problem, never nothing', () => {
    expect(problemsOf({ credentialWarning: null, errors: [{ path: 'clickUrl', field: 'click_url', message: 'm' }] })[0]).toMatchObject({ registryPath: 'click_url', tab: 'workflow_values' })
    expect(problemsOf({ credentialWarning: null, errors: [{ path: 'soldOn', message: 'm' }] })[0]).toMatchObject({ registryPath: 'profile.sold_on', tab: 'buyer_profile' })
    expect(problemsOf({ credentialWarning: null, errors: [{ path: 'nothingLikeThis', message: 'm' }] })[0]).toEqual({ registryPath: null, tab: null, message: 'm' })
    expect(problemsOf({ credentialWarning: null, errors: [{ path: '', message: 'm' }] })[0].tab).toBeNull()
  })

  // List order left the page with the alphabetical list (#2137): no tab draws
  // it, so a problem with it is said at page level rather than marking a tab
  // that has nothing to show, and its label says it is not on the page.
  it('a field no tab draws (List order) is a page level problem, labelled as off the page', () => {
    expect(registryEntriesFor('priority')[0]).toMatchObject({ offPage: true, label: 'List order (not shown on this page)' })
    expect(problemsOf({ credentialWarning: null, errors: [{ path: 'priority', field: 'priority', message: 'm' }] })[0]).toEqual({ registryPath: null, tab: null, message: 'm' })
    // The slug too (#2323): asked only on the new partner page, and fixed once the partner exists.
    expect(PARTNER_FIELD_REGISTRY.filter((e) => e.offPage).map((e) => e.pattern)).toEqual(['slug', 'priority'])
  })

  it('names each tab with a problem once, in the page order', () => {
    const problems = problemsOf({ credentialWarning: 'c', errors: [{ path: 'soldOn', message: 'm' }, { path: 'tiers', message: 'n' }] })
    expect(problemTabs(problems)).toEqual(['buyer_profile', 'bid_group'])
  })
})

describe('the tab a partner opens on', () => {
  const visible = ['partner', 'buyer_profile', 'bid_group', 'workflow_values', 'history'] as const

  it('a tab in the URL wins, even over a problem', () => {
    expect(openingTab({ requested: 'history', visible, problems: problemsOf({ credentialWarning: 'c', errors: [] }), isBuyer: true, isNew: false })).toBe('history')
  })

  it('a tab the partner does not show falls back to the first tab', () => {
    expect(openingTab({ requested: 'bid_group', visible: ['partner', 'workflow_values', 'history'], problems: [], isBuyer: false, isNew: false })).toBe('partner')
  })

  it('with no tab in the URL, the first tab holding a problem', () => {
    expect(openingTab({ requested: null, visible, problems: problemsOf({ credentialWarning: 'c', errors: [] }), isBuyer: true, isNew: false })).toBe('bid_group')
  })

  it('otherwise where the partner\'s settings live: a buyer\'s profile, a source\'s workflow values, a new partner on Partner', () => {
    expect(openingTab({ requested: null, visible, problems: [], isBuyer: true, isNew: false })).toBe('buyer_profile')
    expect(openingTab({ requested: null, visible: ['partner', 'workflow_values', 'history'], problems: [], isBuyer: false, isNew: false })).toBe('workflow_values')
    expect(openingTab({ requested: null, visible, problems: [], isBuyer: true, isNew: true })).toBe('partner')
  })
})

/**
 * Reachability before anything is hidden (L96): every partner field buyer
 * selection reads, from the loader's own select string, must be reachable for
 * every buyer however it is sold: its tab shown, or the Bid Group tab one press
 * of Set up for Bid Group away. Seen red by dropping the Set up offer for a
 * buyer, and by moving api_endpoint's registry entry to a tab a buyer lacks.
 */
describe('every field buyer selection reads is reachable', () => {
  const loader = readFileSync(path.join(REPO_ROOT, 'apps/worker/src/lib/buyer-profile-loader.ts'), 'utf8')
  const select = /partner_configs!inner\(([^)]*)\)/.exec(loader.replace(/'\s*\+\s*'/g, ''))?.[1] ?? ''
  const read = select.split(',').map((c) => c.trim()).filter((c) => c && c !== 'id' && c !== 'slug')

  it('reads the loader\'s columns (a positive control)', () => {
    expect(read).toEqual(expect.arrayContaining(['api_endpoint', 'cf_secret_key', 'outbound_field_mapping', 'extra_extraction', 'circuit_enabled']))
  })

  for (const soldOn of ['offer', 'click', null] as const) {
    it(`for a buyer sold on ${soldOn ?? 'nothing yet'}`, () => {
      const i = inputs({ soldOn })
      const shown = visibleTabs(i)
      const unreachable = read.filter((col) => {
        const tab = registryEntriesFor(col)[0]?.tab
        if (!tab) return true
        return !(shown.includes(tab) || (tab === 'bid_group' && canAddBidGroup(i)))
      })
      expect(unreachable).toEqual([])
    })
  }
})
