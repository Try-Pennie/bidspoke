import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Deploy Drift checks three targets in one job, and every one of them must still
 * be checked, and alerted on, when an earlier one goes wrong (#1373, L73).
 *
 * A step that fails without `continue-on-error` ends the job for every step after
 * it that lacks `if: always()`. So a single missed answer from the main worker
 * used to skip its own alert, the site check and the tail worker check: the run
 * went red and nobody was told. A repository variable deleted by mistake did the
 * same from the site and tail steps.
 *
 * These guards are over the CLASS rather than the three instances (L30): any step
 * that can end the job early, other than the final gate that exists to fail the
 * run, is refused.
 */
const DRIFT = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-drift.yml'), 'utf8')
const GATE = 'Fail the run if any target is stranded'

type Step = { name: string; text: string }

/** Every step of the drift job, split on the step marker at the job's indentation. */
const steps = (): Step[] => {
  const parts = DRIFT.split(/\n(?= {6}- (?:name|uses|id):)/).slice(1)
  expect(parts.length, 'no steps were parsed, so every guard below would pass on nothing').toBeGreaterThan(10)
  return parts.map((text) => ({ name: text.match(/- name:\s*(.+)/)?.[1]?.trim() ?? '(unnamed)', text }))
}

const step = (name: string): Step => {
  const found = steps().find((s) => s.name === name)
  expect(found, `the drift workflow has no step named "${name}"`).toBeDefined()
  return found!
}

describe('no Deploy Drift step can end the job before every target is checked (#1373)', () => {
  it('gives every step that exits 1 its own failure boundary, except the final gate', () => {
    const offenders = steps()
      .filter((s) => s.name !== GATE)
      .filter((s) => /\bexit 1\b/.test(s.text))
      .filter((s) => !/continue-on-error:\s*true/.test(s.text))
      .map((s) => s.name)
    expect(offenders, 'these steps end the job, skipping every later target and its alert').toEqual([])
  })

  it('runs no step under set -e, where any failing command ends the job silently', () => {
    const offenders = steps()
      // Commands only: a comment explaining why a step avoids it is not a use.
      .filter((s) => /^\s*set -[a-z]*e[a-z]*\b/m.test(s.text))
      .map((s) => s.name)
    expect(offenders).toEqual([])
  })

  it('checks that the guard above can see a violation, so it is not passing on a parse that found nothing', () => {
    // The gate itself exits 1 with no boundary, by design. If the parser ever
    // stopped finding it, the first guard could not see an offender either.
    expect(/\bexit 1\b/.test(step(GATE).text)).toBe(true)
  })
})

describe('the main worker is probed and reported like the other targets (#1373)', () => {
  const compare = () => step('Compare live worker commit to the latest worker-touching commit')

  it('keeps its own failure boundary, because it runs first and a crash would skip every later target', () => {
    expect(compare().text).toMatch(/continue-on-error:\s*true/)
  })

  it('reads the worker through the second look, not a bare curl', () => {
    expect(compare().text).toContain('second-look-fetch.sh')
    expect(compare().text).not.toMatch(/curl\s/)
  })

  it('reports an unreachable, unstamped or unconfigured worker as a verdict rather than stopping', () => {
    for (const verdict of ['alert-unreachable', 'alert-unstamped', 'alert-unconfigured']) {
      expect(compare().text, `the compare step never records ${verdict}`).toContain(`verdict=${verdict}`)
    }
  })

  it('alerts on each of those verdicts, and on the compare step itself failing, in a step that cannot end the job', () => {
    const alert = steps().find((s) => /id:\s*worker_probe_alert/.test(s.text))
    expect(alert, 'there is no worker_probe_alert step').toBeDefined()
    expect(alert!.text).toMatch(/continue-on-error:\s*true/)
    const condition = alert!.text.match(/\n\s*if:\s*(.+)/)?.[1] ?? ''
    for (const verdict of ['alert-unreachable', 'alert-unstamped', 'alert-unconfigured']) {
      expect(condition, `the alert does not fire on ${verdict}`).toContain(verdict)
      expect(alert!.text, `the alert has no message for ${verdict}`).toMatch(new RegExp(`${verdict}\\)`))
    }
    expect(condition, 'a compare step that crashed would go unreported').toContain("steps.compare.outcome == 'failure'")
    // Posts to Slack through the reminder record since #1761, which owns the curl.
    expect(alert!.text).toContain('drift-alert-state.sh alert worker')
  })

  it('counts that alert in the final gate, so the run still goes red', () => {
    const gate = step(GATE).text
    expect(gate).toContain('steps.worker_probe_alert.outcome')
    expect(gate).toMatch(/WORKER_PROBE"?\s*=\s*"failure"/)
  })
})

describe('a missing target address is reported, not a silent stop (#1373)', () => {
  it('gives the tail worker an unconfigured alert of its own, not the stranded deploy copy', () => {
    const tailCompare = step('Compare the live tail worker to the latest tail commit').text
    expect(tailCompare).toContain('verdict=alert-unconfigured')
    const tailAlert = steps().find((s) => /id:\s*tail_alert/.test(s.text))!.text
    expect(tailAlert).toMatch(/alert-unconfigured\)/)
    expect(tailAlert).toContain('WORKER_TAIL_URL')
  })

  it('lets the site sampling fall through to its no-samples alert when the address is missing', () => {
    const sample = step('Sample the live site').text
    expect(sample).toMatch(/SITE_URL[^\n]*unset[\s\S]*?exit 0/)
  })
})
