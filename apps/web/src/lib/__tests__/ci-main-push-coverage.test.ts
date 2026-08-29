import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowJobIds } from './_scan-utils'

/**
 * Anything ci.yml stops running on a push to main must still be run on main by
 * deploy.yml's Verify job (#972).
 *
 * On every push to main, ci.yml ran Lint, Typecheck and the package suites while
 * deploy.yml's Verify job ran typecheck, lint and `pnpm -r test` on the same
 * commit at the same time. The deploy is gated on Verify, not on ci.yml, so the
 * ci.yml copies gated nothing Verify did not already gate: roughly 5 minutes of
 * paid compute per merge for no added protection.
 *
 * Making those jobs pull-request-only is safe ONLY while Verify keeps running
 * the same commands. That is a real coupling between two files, and it is the
 * kind that rots quietly: someone trims a step out of Verify to speed the deploy
 * up, and main silently stops being linted, tested or typechecked, with every
 * check still green because the ci.yml job that would have caught it is skipped
 * on exactly that event.
 *
 * So the coupling is asserted rather than remembered (L41). The jobs are DERIVED
 * from their own `if:` conditions rather than named, so a fourth job restricted
 * to pull requests later cannot slip past this (L247).
 */
const CI = '.github/workflows/ci.yml'
const DEPLOY = '.github/workflows/deploy.yml'

/** Strip YAML comments so prose about a command cannot stand in for it (L103). */
const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n')

/** ci.yml jobs whose job-level `if:` restricts them to pull requests. */
function pullRequestOnlyJobs(): Array<{ id: string; body: string }> {
  const yaml = readWorkflow(CI)
  return workflowJobIds(yaml)
    .map((id) => ({ id, body: workflowJobBody(yaml, id) }))
    .filter(({ body }) => {
      // Job-level `if:` sits at four spaces; a step's sits deeper.
      const jobIf = body.split('\n').find((l) => /^ {4}if:/.test(l))
      return jobIf !== undefined && /event_name\s*==\s*'pull_request'/.test(jobIf)
    })
}

/** Every `run:` command in a job body, single-line form. */
const runCommands = (body: string): string[] =>
  [...stripComments(body).matchAll(/^\s*run:\s*(\S.*)$/gm)].map((m) => m[1].trim())

const verifyBody = (): string => stripComments(workflowJobBody(readWorkflow(DEPLOY), 'verify'))

describe('what ci.yml skips on main, deploy.yml still runs on main (#972)', () => {
  it('finds jobs restricted to pull requests, so this cannot pass vacuously', () => {
    // If this drops to zero the guard below asserts nothing, which is exactly
    // the state it exists to make visible (L98).
    expect(pullRequestOnlyJobs().length).toBeGreaterThanOrEqual(4)
  })

  it('has Verify run the same checks those jobs run', () => {
    const verify = verifyBody()
    expect(verify.length, "deploy.yml has no `verify` job body to read").toBeGreaterThan(0)

    for (const { id, body } of pullRequestOnlyJobs()) {
      const commands = runCommands(body)
      expect(commands.length, `${id} runs no commands, so this cannot pass vacuously`).toBeGreaterThan(0)

      for (const command of commands) {
        // A per-package suite invocation is covered by Verify's recursive run,
        // which is a superset: `pnpm -r test` runs every workspace package's
        // own `test` script. Stated explicitly rather than pattern-matched
        // loosely, so a command that is NOT one of these two shapes fails here
        // instead of being waved through (L129).
        const isSuite = /--filter[= ][@\w/-]+ test(?::[\w-]+)?(?![\w:-])/.test(command)
        if (isSuite) {
          expect(
            verify,
            `ci.yml's ${id} job runs \`${command}\` only on pull requests, and deploy.yml's Verify does not run \`pnpm -r test\`, so nothing runs that suite on main`,
          ).toMatch(/pnpm -r test/)
          continue
        }

        // Setup commands are not checks and need no counterpart.
        if (/^pnpm install/.test(command)) continue

        expect(
          verify,
          `ci.yml's ${id} job runs \`${command}\` only on pull requests, and deploy.yml's Verify never runs it, so main is no longer covered by it`,
        ).toContain(command)
      }
    }
  })

  it('keeps the jobs unique to main running on main', () => {
    // The direct-push guard, the security scan and the db-types check exist to
    // watch main itself. Restricting one of them to pull requests would remove
    // the only place it ever runs, which is the opposite mistake and would look
    // identical in the diff.
    const yaml = readWorkflow(CI)
    for (const id of ['direct-push-guard', 'security', 'db-types-fresh']) {
      const body = workflowJobBody(yaml, id)
      const jobIf = body.split('\n').find((l) => /^ {4}if:/.test(l)) ?? ''
      expect(
        /event_name\s*==\s*'pull_request'/.test(jobIf),
        `ci.yml's ${id} job is restricted to pull requests, but it exists to watch main, so it would now never run there`,
      ).toBe(false)
    }
  })
})

describe('ci.yml reports a check on every pull request (#894)', () => {
  /**
   * #894 asked whether the accessibility job should skip outright, via a `paths`
   * filter, rather than starting and skipping its steps.
   *
   * The answer is that it must keep starting, and the reason is structural
   * rather than a preference. GitHub has no job-level `paths`: the only place it
   * is valid is under `on.<event>`, where it governs the WHOLE workflow. Adding
   * one to ci.yml to spare the a11y job would take the security scan, the
   * db-types check, lint, typecheck and both test jobs down with it on any pull
   * request that did not match, and a workflow that does not run reports no
   * check at all. This repo has no server-side required checks today (#266), so
   * that is currently a latent rather than an active hazard, which is precisely
   * why it needs to be written down: the cost of the mistake is invisible until
   * the plan is upgraded and then it is a merge button that never unblocks.
   *
   * The cost being avoided is about thirty seconds of runner time on a backend
   * pull request, now that the expensive steps are scoped (#968). That is a real
   * cost and it is the smaller one.
   */
  it('has no workflow-level paths filter, so every pull request gets a reported check', () => {
    const triggers = readWorkflow(CI).split('jobs:')[0]
    expect(
      triggers,
      'ci.yml now has a `paths` filter on its triggers, so on a pull request that does not match, the whole workflow does not run and reports no check at all. See #894.',
    ).not.toMatch(/^\s*paths(-ignore)?:/m)
  })
})
