import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowJobIds, workflowSteps, workflowStepBody } from './_scan-utils'

/**
 * The guards that take a few seconds run as steps of the Security scans job,
 * not as jobs of their own.
 *
 * Each of them was a job billed a full minute for under 15 seconds of work:
 * about 1,500 billed minutes a month across pull requests and pushes to main,
 * measured over 15 to 30 September 2026. Folding them into a job that already
 * checks out the full history costs nothing in coverage, PROVIDED two things
 * hold, and those are what this file asserts:
 *
 * 1. Each guard still runs on exactly the events it ran on as a job. The direct
 *    push guard must never run on a pull request (it would fail every one), and
 *    the issue closure guard has nothing to read on a push.
 * 2. One failing step does not stop the others. A job skips every step after a
 *    failed one by default, so a flaky scanner download would silently stop a
 *    guard running, and a red guard would stop the scanners. Every check step
 *    therefore carries `!cancelled()`, which runs it after a sibling's failure.
 */
const CI = '.github/workflows/ci.yml'

const GUARDS = [
  { name: 'DB types regenerated with schema migrations', script: 'db-types-regen-decision.sh', events: 'both' },
  { name: 'Main has no unreviewed direct push', script: 'main-push-decision.sh', events: 'push' },
  { name: 'Pull request closes the issue it names', script: 'issue-closure-decision.sh', events: 'pull_request' },
] as const

/** Blank YAML comment lines so prose about a command cannot stand in for it (L103). */
const code = (body: string): string => body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

const stepIf = (body: string): string => /^ {8}if:\s*(.+)$/m.exec(body)?.[1] ?? ''

describe('the short guards run as steps of Security scans', () => {
  const yaml = readWorkflow(CI)
  const security = workflowJobBody(yaml, 'security')

  it('no longer runs them as separate jobs, each billed a full minute', () => {
    const ids = workflowJobIds(yaml)
    for (const id of ['db-types-fresh', 'direct-push-guard', 'issue-closure-guard']) {
      expect(ids, `ci.yml still has a ${id} job`).not.toContain(id)
    }
  })

  it('has one named step per guard that calls its decision script and fails the job', () => {
    for (const guard of GUARDS) {
      const step = code(workflowStepBody(security, guard.name))
      expect(step).toContain(guard.script)
      expect(step).toContain('::error::')
      expect(step).toMatch(/exit 1/)
    }
  })

  it('runs each guard on exactly the events it ran on as a job', () => {
    for (const guard of GUARDS) {
      const cond = stepIf(workflowStepBody(security, guard.name))
      const push = /github\.event_name\s*==\s*'push'/.test(cond)
      const pr = /github\.event_name\s*==\s*'pull_request'/.test(cond)
      if (guard.events === 'both') expect(push || pr, `${guard.name} is limited to one event`).toBe(false)
      if (guard.events === 'push') {
        expect(push && !pr, `${guard.name} must run on push only`).toBe(true)
        expect(cond).toMatch(/github\.ref\s*==\s*'refs\/heads\/main'/)
      }
      if (guard.events === 'pull_request') expect(pr && !push, `${guard.name} must run on pull requests only`).toBe(true)
    }
  })

  it('runs every check step even after another step failed', () => {
    const checks = workflowSteps(security).filter((s) => /^ {8}run:/m.test(s.body))
    expect(checks.length).toBeGreaterThanOrEqual(GUARDS.length + 3)
    for (const step of checks) {
      expect(stepIf(step.body), `step '${step.name}' is skipped whenever an earlier step fails`).toContain('!cancelled()')
    }
  })

  it('grants the token the pull request read the direct push guard needs', () => {
    expect(security).toMatch(/^ {4}permissions:\s*\n(?: {6}.*\n)*? {6}pull-requests: read/m)
    expect(security).toMatch(/^ {4}permissions:\s*\n(?: {6}.*\n)*? {6}contents: read/m)
  })
})

describe('workflowSteps slices one step, not the comment introducing the next', () => {
  it('leaves the next step\'s comment block out of the previous step', () => {
    const job = [
      '  example:',
      '    steps:',
      '      - name: First',
      '        run: echo one',
      '',
      '      # The next step calls decision.sh and exits 1 on ::error::.',
      '      - name: Second',
      '        run: echo two',
    ].join('\n')
    const first = workflowStepBody(job, 'First')
    expect(first).not.toContain('decision.sh')
    expect(first.trimEnd().endsWith('run: echo one')).toBe(true)
  })
})
