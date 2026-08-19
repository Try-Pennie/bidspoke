import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The accessibility scan runs only when web code changed, and FAILS CLOSED.
 *
 * It is the only job that installs a browser, builds the production artifact and
 * boots the app, so it costs minutes while everything else costs seconds. On
 * 2026-08-19 it blocked #885, a branch touching only `apps/worker/src/archive/`,
 * three separate times without ever examining anything (#887).
 *
 * The danger in scoping it is the one its own comments already name: "a gate
 * that quietly switches itself off is the exact rot this job exists to stop".
 * So the skip is only legitimate when the job can PROVE nothing web-facing
 * changed. If it cannot tell, it runs. A wasted seven minutes is cheap; an
 * accessibility regression waved through by a detection bug is not (L42, L72).
 */
const CI_YML = path.join(REPO_ROOT, '.github/workflows/ci.yml')

function a11ySection(): string {
  const yaml = readFileSync(CI_YML, 'utf8')
  const start = yaml.indexOf('\n  a11y:')
  const end = yaml.indexOf('\n  auth-gate:')
  expect(start, 'a11y job found').toBeGreaterThan(0)
  expect(end, 'next job found, so the slice is bounded').toBeGreaterThan(start)
  return yaml.slice(start, end)
}

describe('accessibility scan scoping', () => {
  it('decides whether web code changed before doing the expensive work', () => {
    const section = a11ySection()

    expect(section).toMatch(/id:\s*web/)
    expect(section).toMatch(/apps\/web/)
  })

  it('runs the scan when it cannot tell what changed, rather than skipping', () => {
    // The whole risk of this optimisation is a detection bug silently disabling
    // the gate, so indeterminate must mean run.
    //
    // Asserting "a changed=true appears before the first changed=false" is
    // VACUOUS: any earlier branch's changed=true satisfies it while a later
    // branch fails open, and this test passed against exactly that defect until
    // it was mutation-checked (L178). Count instead, and pin where the single
    // skip lives.
    const detect = a11ySection()
    const script = detect.slice(detect.indexOf('id: web'), detect.indexOf('Check for e2e credentials'))
    const lines = script.split('\n')

    const skips = lines.filter((l) => l.includes('changed=false'))
    expect(skips, 'exactly one branch may skip the scan').toHaveLength(1)

    // That one skip is the else of the path-match, never an error path.
    const skipAt = lines.findIndex((l) => l.includes('changed=false'))
    const preceding = lines.slice(0, skipAt).reverse().find((l) => /^\s*(if|else|fi)\b/.test(l.trim()))
    expect(preceding?.trim(), 'the only skip is the else of the apps/web match').toBe('else')

    expect(script).toMatch(/could not determine/i)
  })

  it('gates the expensive steps on that decision, not just the final assertion', () => {
    const section = a11ySection()

    for (const step of ['Install Chromium', 'Build the production artifact', 'Run accessibility specs']) {
      const at = section.indexOf(step)
      expect(at, `${step} exists`).toBeGreaterThan(0)
      const window = section.slice(at, at + 400)
      expect(window, `${step} is gated on steps.web.outputs.changed`).toMatch(/steps\.web\.outputs\.changed/)
    }
  })
})
