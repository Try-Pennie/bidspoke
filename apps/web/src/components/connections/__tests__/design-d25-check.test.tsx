/**
 * The settled Connections design's D25 check (docs/design/connections-page.checks.js), run on
 * planted pages (#2338): red is the app's failure red, read from the colour FieldError draws,
 * beside the problem status's; every element in either red must be one that is wrong or destroys,
 * and every failed line must be drawn in one of them. The old check matched only #B42318, so a
 * FieldError line was never looked at, and a failed line in grey passed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
// vitest runs from apps/web, so the repository is two folders up.
const REPO_ROOT = path.resolve(process.cwd(), '../..')

type Check = { id: string; check: (doc: Document, ctx: unknown) => { ok: boolean; detail: string } }

let d25: Check

beforeAll(() => {
  const src = readFileSync(path.join(REPO_ROOT, 'docs/design/connections-page.checks.js'), 'utf8')
  // The checks file sets window.DESIGN_CHECKS, as the score loads it into the page.
  window.eval(src)
  d25 = (window as unknown as { DESIGN_CHECKS: Check[] }).DESIGN_CHECKS.find((c) => c.id === 'D25')!
})

/** A page with the app's failure red on .field-error (Tailwind's red-700, as the app draws it) and the given main content. */
function page(main: string): Document {
  document.head.innerHTML = '<style>.field-error { color: rgb(185, 28, 28) } .grey { color: rgb(105, 112, 129) } .status-red { color: rgb(180, 35, 24) }</style>'
  document.body.innerHTML = `<main id="main-content" style="color: rgb(29, 33, 47)">${main}</main>`
  return document
}

describe('D25 judges every failed line in the app red (#2338)', () => {
  it('passes a failed Try again line drawn in the failure red', () => {
    const r = d25.check(page('<div data-part="stale-strip"><span>Login checks are not answering.</span><span class="field-error">Trying again did not work: no answer.</span></div>'), {})
    expect(r.ok, r.detail).toBe(true)
    expect(r.detail).toContain('1 failed line(s)')
  })

  it('refuses a failed Try again line drawn in plain grey', () => {
    const r = d25.check(page('<div><span class="grey">Trying again did not work: no answer.</span></div>'), {})
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('a failed line is not red')
  })

  it('refuses the failure red on a sentence that is not a failure, the red the old check never looked at', () => {
    const r = d25.check(page('<p class="field-error">The connections could not be read.</p>'), {})
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('red on something not wrong')
  })

  it("passes a problem's status in the status red, and refuses that red elsewhere", () => {
    expect(d25.check(page('<span data-part="status" data-status="reauth"><span class="status-red">Needs reconnecting</span></span>'), {}).ok).toBe(true)
    expect(d25.check(page('<div class="status-red">Service</div>'), {}).ok).toBe(false)
  })
})
