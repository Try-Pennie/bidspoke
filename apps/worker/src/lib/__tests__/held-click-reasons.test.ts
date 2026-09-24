/**
 * The held click reasons are one vocabulary (#1552, L41): the shared list the
 * node records and the partner page explains is also a subset of the Slack page
 * reasons. That the held_click_claims CHECK constraint lists exactly these is
 * asserted by the web guard held-click-reasons-match-table.test.ts, which can
 * read the migration.
 */
import { describe, expect, it } from 'vitest'
import { HELD_CLICK_REASONS, HELD_CLICK_REASON_LABELS } from '@bidspoke/buyer-profile'
import { CLICK_PAGE_REASONS } from '../buyer-click-alert'

describe('held click reasons', () => {
  it('every held reason is also a page reason, so the Slack page and the partner page name one set', () => {
    for (const r of HELD_CLICK_REASONS) expect(CLICK_PAGE_REASONS).toContain(r)
  })

  it('every reason has its own explanation', () => {
    expect(Object.keys(HELD_CLICK_REASON_LABELS).sort()).toEqual([...HELD_CLICK_REASONS].sort())
    expect(new Set(Object.values(HELD_CLICK_REASON_LABELS)).size).toBe(HELD_CLICK_REASONS.length)
  })
})
