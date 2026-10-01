import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowJobIds } from './_scan-utils'

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
const CI_YML = '.github/workflows/ci.yml'

/**
 * A job's body with YAML comments blanked.
 *
 * Used wherever a job is identified by a command it RUNS. Without it, the
 * deploy's `verify-release` job counted as an artifact builder because its docs
 * comment mentions `pages:build`, and the guard then demanded a build cache on a
 * job that never builds. Prose about a thing is not the thing (L103).
 */
const jobCode = (yaml: string, id: string): string =>
  workflowJobBody(yaml, id)
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n')


/**
 * The a11y job's own body. Sliced by job key (#1066), never by naming the job
 * that follows: this used to run from `a11y:` to `auth-gate:`, so inserting a
 * job between them would have quietly widened every assertion below.
 */
const a11ySection = (): string => workflowJobBody(readWorkflow(CI_YML), 'a11y')

describe('accessibility scan scoping', () => {
  it('decides whether web code changed before doing the expensive work', () => {
    const section = a11ySection()

    expect(section).toMatch(/id:\s*web/)
    expect(section).toMatch(/apps\/web/)
  })

  it('delegates the decision to the shared fail-closed script', () => {
    // The fail-closed logic itself lives in .github/scripts/web-code-changed.sh
    // and is exercised by web-code-changed-decision.test.ts, which drives the
    // real script through every way the lookup can go wrong. What has to be
    // asserted HERE is only that this job actually consults it: a script nothing
    // calls is indistinguishable from no script (L3).
    expect(a11ySection()).toContain('.github/scripts/web-code-changed.sh')
  })

  it('reports the lookup failing to the script instead of swallowing it', () => {
    // The script can only fail closed on a failed lookup if the job TELLS it the
    // lookup failed. A run block that let `gh api` fail silently and passed the
    // empty output along as a success would leave the script deciding "nothing
    // matched" on no evidence, with every run still green (L215).
    const detect = a11ySection().slice(a11ySection().indexOf('id: web'))
    expect(detect).toMatch(/if files=\$\(gh api/)
    expect(detect).toMatch(/ok=false/)
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

  it('grants the job the pull-requests read permission its detection depends on', () => {
    // The repo default workflow token grants contents and packages read, NOT
    // pull-requests. Without an explicit grant the changed-files API call fails,
    // the job fails closed, and the scan runs on every pull request while
    // reporting success: the optimisation is silently inert and nothing says so
    // (L90, L98). Measured 2026-08-19 on #885, which emitted "Could not
    // determine the changed files, so the accessibility scan runs."
    //
    // The security job declares exactly this for its direct push step.
    const section = a11ySection()
    const beforeSteps = section.slice(0, section.indexOf('steps:'))

    expect(beforeSteps).toMatch(/permissions:/)
    expect(beforeSteps).toMatch(/pull-requests:\s*read/)
  })

  it('is not the only job whose expensive build is scoped this way (#968)', () => {
    // Both jobs build the identical next-on-pages artifact on every pull
    // request. Scoping one and not the other leaves the unscoped one as the
    // critical path of every backend pull request, which is the whole of #968.
    //
    // Derived by looking for jobs that BUILD, rather than by naming them, so a
    // third artifact-building job cannot be added without either being scoped
    // or failing here (L247).
    const yaml = readWorkflow(CI_YML)
    const builders = workflowJobIds(yaml).filter((id) => jobCode(yaml, id).includes('pages:build'))
    expect(builders.length, 'no job builds the artifact, so this cannot pass vacuously').toBeGreaterThanOrEqual(2)
    for (const id of builders) {
      expect(
        workflowJobBody(yaml, id),
        `ci.yml's ${id} job builds the Pages artifact without consulting web-code-changed.sh, so it runs in full on pull requests that cannot affect it`,
      ).toContain('.github/scripts/web-code-changed.sh')
    }
  })

  it('caches the Next.js build cache in every job that builds the artifact (#970, #974)', () => {
    // Across BOTH workflows, not just ci.yml. The deploy's Pages build is the
    // same cold build on the merged-to-live wait, and scoping this guard to one
    // file is how that one stayed cold while the rule read as enforced (L135).
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']) {
      const yaml = readWorkflow(workflow)
      const builders = workflowJobIds(yaml).filter((id) => jobCode(yaml, id).includes('pages:build'))
      expect(
        builders.length,
        `${workflow} has no job building the artifact, so this cannot pass vacuously`,
      ).toBeGreaterThanOrEqual(1)
      for (const id of builders) {
        const body = workflowJobBody(yaml, id)
        expect(body, `${workflow}'s ${id} builds from cold every time`).toContain('apps/web/.next/cache')
        expect(
          body,
          `${workflow}'s ${id} caches without a restore-keys fallback, so a source change gets no warm start`,
        ).toMatch(/restore-keys:/)
      }
    }
  })

  it('installs the browser without the operating system package step', () => {
    // `--with-deps` runs a package-manager install that no cache can hold, and
    // it is what stalled: five times on 2026-08-19, ~20 minutes each, resolved
    // only by the job timeout. The runner image already carries the libraries
    // Chromium needs, so the plain install is a pure download and the cache
    // above covers it completely.
    //
    // If a future runner image drops a library, Playwright fails at browser
    // LAUNCH naming the missing library, which is a legible failure rather than
    // a hang. That trade is the point: a clear error beats an indefinite wait.
    // Read the COMMAND, not the surrounding prose. Scanning the whole step
    // catches the comment that explains why the flag is absent, which is the
    // classic text-guard defeat (L103): the remedy must not be to stop
    // explaining, so the guard gets more precise instead.
    const section = a11ySection()
    const install = section.slice(section.indexOf('name: Install Chromium'))
    const runLine = install.split('\n').find((l) => /^\s*run:/.test(l))

    expect(runLine, 'the install step has a run command').toBeDefined()
    expect(runLine).toMatch(/playwright install .*chromium/)
    expect(runLine).not.toMatch(/--with-deps/)
  })
})
