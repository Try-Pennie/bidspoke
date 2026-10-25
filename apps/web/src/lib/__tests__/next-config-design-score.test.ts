/**
 * The design score's preview run (#2338): Next's development badge is drawn
 * on every page of `next dev` and in no settled design, so a picture of the
 * built page can never match one while it shows. DESIGN_SCORE_PREVIEW=1, set
 * only for a score run, turns it off; every other run keeps Next's default.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const CONFIG = path.resolve(__dirname, '../../../next.config.js')

function load(): Record<string, unknown> {
  delete require.cache[CONFIG]
  return require(CONFIG) as Record<string, unknown>
}

describe('next.config.js and the design score', () => {
  const before = process.env.DESIGN_SCORE_PREVIEW
  afterEach(() => {
    if (before === undefined) delete process.env.DESIGN_SCORE_PREVIEW
    else process.env.DESIGN_SCORE_PREVIEW = before
  })

  it('turns the development badge off only for a score run', () => {
    process.env.DESIGN_SCORE_PREVIEW = '1'
    expect(load().devIndicators).toBe(false)
  })

  it('leaves Next\'s default everywhere else', () => {
    delete process.env.DESIGN_SCORE_PREVIEW
    expect(Object.hasOwn(load(), 'devIndicators')).toBe(false)
    process.env.DESIGN_SCORE_PREVIEW = 'yes'
    expect(Object.hasOwn(load(), 'devIndicators')).toBe(false)
  })
})
