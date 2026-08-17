/**
 * Is the page under an accessibility scan actually worth scanning? (#797)
 *
 * axe finds zero violations on a blank page, on an error shell, and on a login
 * screen. So a broken auth fixture redirects all nine authenticated pages to
 * /login, axe scans /login nine times, and the gate reports a clean pass over a
 * scan that never saw the app. Nothing in a violation count could reveal that:
 * it is a recording defending a broken state (LESSONS L84).
 *
 * The decision lives here, as a pure function, rather than inline in the
 * Playwright helper. Inline it would only be testable by driving a browser, which
 * means in practice it would be verified once by hand and never again.
 */

export interface ScannedPage {
  /** The pathname the browser actually ended up on. */
  actualPath: string
  /** The pathname the scan intended, or undefined when any page is acceptable. */
  expectedPath?: string
  /** Length of the trimmed visible text the page rendered. */
  visibleTextLength: number
}

export type ScanRefusal =
  | { ok: true }
  | { ok: false; reason: 'wrong-page' | 'empty-render'; message: string }

/**
 * The smallest number of visible characters a real page renders here.
 *
 * MEASURED against the live site rather than guessed, which matters: a first
 * attempt used 100 and would have failed the gate on every run, because /login
 * renders 51. The live readings were /login 51, /access-denied 153, the
 * content-heavy pages around 4,000, and a blank document 0 (LESSONS L48).
 *
 * So this catches a page that rendered nothing. It does not pretend to catch a
 * page that rendered a short error message, and it does not need to: the failure
 * that actually happens is the redirect, which the path check above catches.
 */
export const MIN_VISIBLE_TEXT = 30

export function checkScannedPage(page: ScannedPage): ScanRefusal {
  if (page.expectedPath !== undefined && page.actualPath !== page.expectedPath) {
    return {
      ok: false,
      reason: 'wrong-page',
      message: `expected to scan ${page.expectedPath} but landed on ${page.actualPath}. A redirect here usually means the session is not being applied, in which case the scan is measuring the login page instead of the app.`,
    }
  }

  if (page.visibleTextLength <= MIN_VISIBLE_TEXT) {
    return {
      ok: false,
      reason: 'empty-render',
      message: `the page rendered almost no text (${page.visibleTextLength} characters), so axe would be scanning an empty shell and would report it clean`,
    }
  }

  return { ok: true }
}
