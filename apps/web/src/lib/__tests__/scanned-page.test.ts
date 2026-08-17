import { describe, expect, it } from 'vitest'
import { checkScannedPage, MIN_VISIBLE_TEXT } from '../scanned-page'

/**
 * The rule that decides whether an accessibility scan is measuring anything
 * (#797).
 *
 * Every case below is one the gate would otherwise have reported as a clean
 * pass, because axe finds zero violations on all of them.
 */
describe('checkScannedPage: the page the scan asked for', () => {
  it('accepts the intended page with real content', () => {
    expect(checkScannedPage({ actualPath: '/dashboard', expectedPath: '/dashboard', visibleTextLength: 900 })).toEqual({
      ok: true,
    })
  })

  it('refuses a page the scan did not ask for', () => {
    // The broken-auth case: every authenticated page redirects to /login, axe
    // scans /login nine times, and nine clean passes are reported.
    const result = checkScannedPage({ actualPath: '/login', expectedPath: '/dashboard', visibleTextLength: 900 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('wrong-page')
  })

  it('names both the intended and the actual path, so the message is actionable', () => {
    const result = checkScannedPage({ actualPath: '/login', expectedPath: '/env', visibleTextLength: 900 })
    expect(result.ok === false && result.message).toContain('/env')
    expect(result.ok === false && result.message).toContain('landed on /login')
  })

  it('does not check the path when the caller did not name one', () => {
    // The public login test scans wherever it lands by design.
    expect(checkScannedPage({ actualPath: '/anywhere', visibleTextLength: 900 }).ok).toBe(true)
  })
})

describe('checkScannedPage: a page that rendered nothing', () => {
  it('refuses a blank document', () => {
    const result = checkScannedPage({ actualPath: '/dashboard', visibleTextLength: 0 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('empty-render')
  })

  it('refuses a near-empty render', () => {
    expect(checkScannedPage({ actualPath: '/dashboard', visibleTextLength: 5 }).ok).toBe(false)
  })

  it('accepts the smallest page the live site actually serves', () => {
    // /login measures 51 visible characters in production. A floor above that
    // would fail the gate on every run, which a first attempt at 100 did.
    expect(checkScannedPage({ actualPath: '/login', expectedPath: '/login', visibleTextLength: 51 }).ok).toBe(true)
  })

  it('keeps the floor below the smallest real page', () => {
    // The calibration itself, asserted rather than left in a comment. If someone
    // raises this floor past what /login renders, the gate breaks on every run.
    expect(MIN_VISIBLE_TEXT).toBeLessThan(51)
  })
})

describe('checkScannedPage: which refusal wins', () => {
  it('reports the wrong page ahead of the empty render', () => {
    // A redirect to a page that also happens to be sparse is still a redirect,
    // and that is the finding that tells the reader what to fix.
    const result = checkScannedPage({ actualPath: '/login', expectedPath: '/dashboard', visibleTextLength: 0 })
    expect(result.ok === false && result.reason).toBe('wrong-page')
  })
})
