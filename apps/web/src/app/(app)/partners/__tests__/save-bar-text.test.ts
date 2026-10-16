/**
 * The words of the partners page save bar and leave dialog (#2138, PM-4,
 * PM-5, PM-6): the change named from registry labels, a click delivery change
 * said as what it does, a refused save naming the field and its tab, and each
 * destination the leave dialog can name.
 */
import { describe, it, expect } from 'vitest'
import type { MergeUnit } from '@/lib/partner-page-merge'
import { leaveActionWords, leaveDescription, leaveTitle, namedAsShown, refusedSentence, unsavedSentence, SESSION_EXPIRED, UNCONFIRMED, UNCONFIRMED_DISCARD_REASON, UNCONFIRMED_GAVE_UP } from '../save-bar-text'

const unit = (key: string, label: string): MergeUnit => ({ key, label, tab: 'partner', section: 'Identity' })
const NAME = unit('name', 'Name')
const STATUS = unit('is_active', 'Status')
const ROUTES = unit('profile.click_delivery.routes', 'Routes')
const CD = 'Clicks from WY will go to DI4 instead of DV1.'

describe('the unsaved change sentence (PM-4, PM-6)', () => {
  it('counts and names the changes by their labels', () => {
    expect(unsavedSentence([NAME], [])).toBe('1 unsaved change: Name')
    expect(unsavedSentence([NAME, STATUS, unit('min_bid', 'Minimum bid ($)')], [])).toBe('3 unsaved changes: Name, Status and Minimum bid ($)')
  })

  it('says a click delivery change as what it does, in place of its label (PM-6)', () => {
    expect(unsavedSentence([ROUTES], [CD])).toBe(`1 unsaved change: ${CD}`)
    expect(unsavedSentence([NAME, ROUTES], [CD])).toBe(`2 unsaved changes: Name. ${CD}`)
    // Several consequences are sentences of their own, one full stop each.
    const REPLY = 'A click counts as sent only when the reply matches X instead of Y.'
    expect(unsavedSentence([ROUTES], [CD, REPLY])).toBe(`1 unsaved change: ${CD} ${REPLY}`)
    expect(unsavedSentence([NAME, ROUTES], [CD, REPLY])).toBe(`2 unsaved changes: Name. ${CD} ${REPLY}`)
  })

  it('keeps the label of a click delivery edit that moves no click', () => {
    expect(unsavedSentence([ROUTES], [])).toBe('1 unsaved change: Routes')
  })

  it('a click buyer\'s cap is named for clicks, as its field is (L118)', () => {
    const cap = { key: 'profile.daily_lead_cap', label: 'Leads per day', tab: 'buyer_profile' as const, section: 'Caps' }
    expect(unsavedSentence(namedAsShown([cap], 'click'), [])).toBe('1 unsaved change: Clicks per day')
    expect(unsavedSentence(namedAsShown([cap], 'offer'), [])).toBe('1 unsaved change: Leads per day')
    expect(refusedSentence([{ registryPath: 'profile.daily_lead_cap', tab: 'buyer_profile', message: 'x' }], 'click')).toBe('Nothing saved: fix Clicks per day in Buyer profile.')
  })

  it('an edit that names no stored field still says something is unsaved', () => {
    expect(unsavedSentence([], [])).toBe('Unsaved changes')
  })
})

describe('a refused save names the field and its tab', () => {
  it('names the first refused field by its registry label, on its tab', () => {
    expect(refusedSentence([{ registryPath: 'click_url', tab: 'workflow_values', message: 'needs {prospect_id}' }])).toBe('Nothing saved: fix Click URL in Workflow values.')
  })

  it('counts the rest', () => {
    const problems = [
      { registryPath: 'profile.debt_max', tab: 'buyer_profile' as const, message: 'a' },
      { registryPath: 'profile.windows[*]', tab: 'buyer_profile' as const, message: 'b' },
      { registryPath: 'click_url', tab: 'workflow_values' as const, message: 'c' },
    ]
    expect(refusedSentence(problems)).toBe('Nothing saved: fix Debt maximum in Buyer profile, and 2 more.')
  })

  it('names nothing when no refused field is on a tab, so the caller keeps the reason', () => {
    expect(refusedSentence([{ registryPath: null, tab: null, message: 'x' }])).toBeNull()
  })
})

describe('the leave dialog (PM-5)', () => {
  it('names the partner, how many changes, and which', () => {
    expect(leaveTitle('Liberty1', [NAME], false)).toBe('Leave Liberty1 with an unsaved change?')
    expect(leaveTitle('Liberty1', [NAME, STATUS], false)).toBe('Leave Liberty1 with 2 unsaved changes?')
    expect(leaveDescription([NAME], false)).toBe('You changed Name and have not saved it.')
    expect(leaveDescription([NAME, STATUS], false)).toBe('You changed Name and Status and have not saved them.')
    expect(leaveDescription([], false)).toBe('Your changes are not saved.')
  })

  it('a save not yet confirmed is said as such, with why Discard waits', () => {
    expect(leaveTitle('Liberty1', [], true)).toBe('Leave Liberty1 before its save is confirmed?')
    expect(leaveDescription([], true)).toBe(UNCONFIRMED_DISCARD_REASON)
    expect(leaveDescription([NAME], true)).toBe(`You changed Name and have not saved it. ${UNCONFIRMED_DISCARD_REASON}`)
  })

  it('names the destination: another partner or page by name, and back, close and sign out in words', () => {
    expect(leaveActionWords({ kind: 'partner', name: 'AmOne' })).toEqual({ discard: 'Discard and open AmOne', save: 'Save and open AmOne' })
    expect(leaveActionWords({ kind: 'page', name: 'Workflows' })).toEqual({ discard: 'Discard and open Workflows', save: 'Save and open Workflows' })
    expect(leaveActionWords({ kind: 'back' })).toEqual({ discard: 'Discard and go back', save: 'Save and go back' })
    expect(leaveActionWords({ kind: 'close' })).toEqual({ discard: 'Discard and close', save: 'Save and close' })
    expect(leaveActionWords({ kind: 'sign-out' })).toEqual({ discard: 'Discard and sign out', save: 'Save and sign out' })
  })
})

describe('the unconfirmed save says unknown, never failed (L766)', () => {
  it('in every sentence', () => {
    for (const s of [UNCONFIRMED, UNCONFIRMED_GAVE_UP, UNCONFIRMED_DISCARD_REASON]) expect(s).not.toMatch(/fail/i)
    expect(UNCONFIRMED).toBe('Not confirmed yet, checking.')
    expect(UNCONFIRMED_GAVE_UP).toBe('Still not confirmed. It may have saved. Reload to see what is stored.')
    expect(SESSION_EXPIRED).toMatch(/sign in again in a new tab/i)
  })
})
