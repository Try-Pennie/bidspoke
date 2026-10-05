import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowSteps } from './_scan-utils'

/**
 * Deploy Drift routes every Slack alert through its reminder record (#1761).
 *
 * drift-alert-state.test.ts proves the script decides correctly. These prove the
 * workflow actually uses it: a curl left inline would post every hour again, a
 * record never uploaded would make every run look like the first, two runs in one
 * hour would both read the same old record and both post, and a healthy reading
 * that never cleared would leave the next occurrence held as a reminder.
 */
const DRIFT = readWorkflow('.github/workflows/deploy-drift.yml')
const JOB = workflowJobBody(DRIFT, 'drift')
const STEPS = workflowSteps(JOB)

/** A step's text without its comment lines: prose about a rule is not the rule (L103). */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

const stepWithId = (id: string) => {
  const found = STEPS.filter((s) => new RegExp(`\\n\\s+id:\\s*${id}\\s*\\n`).test(`${s.body}\n`))
  expect(found, `expected exactly one step with id ${id}`).toHaveLength(1)
  return code(found[0].body)
}

const indexOfId = (id: string) => STEPS.findIndex((s) => new RegExp(`\\n\\s+id:\\s*${id}\\s*\\n`).test(`${s.body}\n`))

describe('every drift alert goes through the reminder record (#1761)', () => {
  it('posts to Slack nowhere except through drift-alert-state.sh', () => {
    expect(code(DRIFT)).not.toMatch(/curl[^\n]*SLACK_WEBHOOK_URL/)
  })

  it.each([
    ['worker_probe_alert', 'worker'],
    ['worker_alert', 'worker'],
    ['pages_alert', 'site'],
    ['tail_alert', 'tail'],
  ])('%s alerts as the %s target', (id, target) => {
    expect(stepWithId(id)).toMatch(new RegExp(`drift-alert-state\\.sh alert ${target} `))
  })

  it('posts the site unconfigured alert through the record too, not only the main site path', () => {
    expect(stepWithId('pages_alert').match(/drift-alert-state\.sh alert site /g)).toHaveLength(2)
  })

  it.each([
    ['worker_alert', 'worker'],
    ['pages_alert', 'site'],
    ['tail_alert', 'tail'],
  ])('%s clears the %s record on a healthy reading, so the next occurrence starts the schedule again', (id, target) => {
    expect(stepWithId(id)).toMatch(new RegExp(`drift-alert-state\\.sh clear ${target}\\b`))
  })

  it('clears the worker record when the cheap check already finds it up to date', () => {
    const settled = code(STEPS.find((s) => s.name === 'Report the settled state')!.body)
    expect(settled).toMatch(/ok\)[^\n]*drift-alert-state\.sh clear worker/)
  })

  it('keys the tail worker on the commit it reports, which the compare step has to output', () => {
    expect(stepWithId('tail_compare')).toMatch(/tail_sha=\$TAIL_SHA" >> "\$GITHUB_OUTPUT"/)
    expect(stepWithId('tail_alert')).toContain('steps.tail_compare.outputs.tail_sha')
  })
})

describe('the record is read first and written last (#1761)', () => {
  it('reads the previous record before the first alert step can run', () => {
    const read = indexOfId('drift_state_read')
    expect(read).toBeGreaterThanOrEqual(0)
    expect(stepWithId('drift_state_read')).toContain('drift-alert-state.sh read')
    expect(read).toBeLessThan(indexOfId('worker_probe_alert'))
  })

  it('points every step at one state directory that survives the later checkouts', () => {
    expect(stepWithId('drift_state_read')).toMatch(/DRIFT_STATE_DIR=\$RUNNER_TEMP\/drift-state" >> "\$GITHUB_ENV"/)
  })

  it('reads the schedule from the same file the worker imports', () => {
    expect(stepWithId('drift_state_read')).toContain('apps/worker/src/lib/alert-backoff-schedule.json')
  })

  it('writes the next record whatever happened earlier in the run', () => {
    const finish = stepWithId('drift_finish')
    expect(finish).toMatch(/if:\s*always\(\)/)
    expect(finish).toContain('drift-alert-state.sh finish')
    for (const step of ['worker_alert', 'worker_probe_alert', 'pages_alert', 'tail_alert']) {
      expect(finish).toContain(`steps.${step}.outcome`)
    }
  })

  it('uploads that record whatever happened, from the path finish writes', () => {
    const upload = STEPS.find((s) => s.body.includes('actions/upload-artifact'))
    expect(upload, 'nothing uploads the record, so every run would read as the first').toBeDefined()
    const body = code(upload!.body)
    expect(body).toMatch(/if:\s*always\(\)/)
    expect(body).toContain('name: deploy-drift-alert-state')
    expect(body).toContain('path: ${{ runner.temp }}/drift-state/next.json')
    expect(body).toMatch(/overwrite:\s*true/)
    expect(STEPS.indexOf(upload!)).toBeGreaterThan(indexOfId('drift_finish'))
  })

  it('serialises runs, so two runs in one hour cannot both read the same old record and both post', () => {
    const top = DRIFT.slice(0, DRIFT.indexOf('\njobs:'))
    expect(top).toMatch(/\nconcurrency:\n {2}group: deploy-drift\n {2}cancel-in-progress: false\n/)
  })
})
