/**
 * One lookup of a buyer_select reason code's words (#3087). The run page, the
 * canvas card and the live share Slack line each carried their own copy of it;
 * they now read this one, so a reason cannot be worded on one surface and shown
 * as its code on another (L605, L613).
 */
import { describe, expect, it } from 'vitest'
import { NODE_REASONS, NODE_REASON_LABELS, OUT_REASONS, OUT_REASON_LABELS, reasonLabel } from '../vocab'

describe('reasonLabel', () => {
  it('words every per buyer reason from its list', () => {
    for (const r of OUT_REASONS) expect(reasonLabel(r)).toBe(OUT_REASON_LABELS[r])
  })

  it('words every node level reason from its list', () => {
    for (const r of NODE_REASONS) expect(reasonLabel(r)).toBe(NODE_REASON_LABELS[r])
  })

  it('shows a code in neither list as itself, never as nothing', () => {
    expect(reasonLabel('a_reason_from_a_newer_engine')).toBe('a_reason_from_a_newer_engine')
  })

  it('is empty when there is no reason', () => {
    expect(reasonLabel(undefined)).toBe('')
    expect(reasonLabel('')).toBe('')
  })

  it('never reads an inherited member as a label', () => {
    expect(reasonLabel('constructor')).toBe('constructor')
    expect(reasonLabel('toString')).toBe('toString')
  })
})
