/**
 * Guard (#2553): the design files a tool writes are marked `linguist-generated` in the root
 * `.gitattributes`, and the hand written design pages beside them are not.
 *
 * A settled design page (written by the design rounds' make-settled.py) and each captured
 * `chrome.html` carry the app's real fonts and logo inlined, so each is about 1 MB. The PR lessons
 * review leaves a file out only when `.gitattributes` marks it generated, so without the mark every
 * settled design PR is refused for size. The mark must name those files only: a hand written page
 * in docs/design/ marked generated would be left out of review too.
 *
 * Every page carrying a decision map (the block make-settled.py writes) and every captured chrome
 * must be marked, found from the tree rather than listed here, so the next settled design fails
 * this test until it is added. Positive control (L1): the hand written pages read unmarked.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

const DESIGN_DIR = path.join(REPO_ROOT, 'docs/design')

/** The value git reports for linguist-generated on a path: set, unset, unspecified, or a value. */
function generatedAttr(relPath: string): string {
  const out = execFileSync('git', ['check-attr', 'linguist-generated', '--', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return out.trim().split(': ').pop() ?? ''
}

/** Settled pages: every docs/design/*.html holding the decision map make-settled.py writes. */
function settledPages(): string[] {
  return readdirSync(DESIGN_DIR)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => readFileSync(path.join(DESIGN_DIR, f), 'utf8').includes('<script type="application/json" id="decision-map">'))
    .map((f) => `docs/design/${f}`)
}

/** Captured chrome: every docs/design/<name>/chrome.html. */
function capturedChrome(): string[] {
  return readdirSync(DESIGN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(DESIGN_DIR, d.name, 'chrome.html')))
    .map((d) => `docs/design/${d.name}/chrome.html`)
}

describe('generated design files are marked for review (#2553)', () => {
  it('finds the settled pages and captured chrome it guards', () => {
    expect(settledPages()).toEqual(expect.arrayContaining(['docs/design/connections-page.html', 'docs/design/connections-step-form.html']))
    expect(capturedChrome()).toEqual(expect.arrayContaining(['docs/design/connections-page/chrome.html', 'docs/design/connections-step-form/chrome.html']))
  })

  it('marks every settled page and every captured chrome as generated', () => {
    const unmarked = [...settledPages(), ...capturedChrome()].filter((p) => generatedAttr(p) !== 'set')
    expect(unmarked).toEqual([])
  })

  // The review only leaves out a file marked generated on the base branch as well as the head, so a
  // settled page's mark lands on main before the page does (#2590): marked here, the next change can
  // carry the page itself.
  it('marks the lead validation settled pages before they land (#2590)', () => {
    for (const p of ['docs/design/lead-validation-node.html', 'docs/design/lead-validation-node-card.html']) {
      expect(generatedAttr(p), p).toBe('set')
    }
  })

  it('leaves the hand written design pages and the regeneration sources unmarked', () => {
    const handWritten = [
      'docs/design/bid-matrix-alert.html',
      'docs/design/partners-page.html',
      'docs/design/connections-page.checks.js',
      'docs/design/connections-page/builder.js',
      'docs/design/connections-page/settled.json',
    ]
    for (const p of handWritten) expect(existsSync(path.join(REPO_ROOT, p)), p).toBe(true)
    const marked = handWritten.filter((p) => generatedAttr(p) !== 'unspecified')
    expect(marked).toEqual([])
  })
})
