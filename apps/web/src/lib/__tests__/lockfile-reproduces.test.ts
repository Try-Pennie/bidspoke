import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REPO_ROOT,
  declaredPnpmVersion,
  readWorkflow,
  workflowJobBody,
  workflowStepBody,
} from './_scan-utils'

/**
 * The committed pnpm-lock.yaml must be exactly what the documented regeneration
 * command writes, and CI checks that on every pull request (#2363).
 *
 * pnpm 9.15.9 writes the circular peer between eslint-plugin-import and
 * eslint-import-resolver-typescript (and eslint-module-utils, which carries
 * both) in three different forms depending on which command last resolved it.
 * Measured 2026-10-17 on d62c1afc: a lockfile only resolve always lands on the
 * short form, a full `pnpm install` always lands on a fully expanded form, and
 * main held a third, mixed one. `--frozen-lockfile` accepts all three, so no
 * install anywhere noticed, and `git log -S` showed the short key flipping 18
 * times on main between 2026-07-08 and 2026-10-17, Dependabot included. Every
 * pull request that added a package carried that churn, and two in flight at
 * once collided on it.
 *
 * `install --lockfile-only --resolution-only` re-resolves even when the
 * lockfile already satisfies every manifest, and it converged on the same short
 * form from all three starting points, with node_modules present or absent.
 * Plain `--lockfile-only` (the command CLAUDE.md documents) converges on that
 * same form whenever it resolves, which it does after any manifest change, but
 * returns at once and writes nothing when the manifests are already satisfied,
 * so it cannot SEE a drifted lockfile. CI therefore runs the forcing variant,
 * and these tests hold CI and the docs together:
 *
 *  1. CI runs it on pull requests and fails on any difference it makes.
 *  2. CLAUDE.md documents one of the two, at the version packageManager
 *     declares, so following the docs cannot produce a lockfile CI refuses.
 */
const COMMAND_ARGS = 'install --lockfile-only --resolution-only'
const STEP = 'Lockfile is what the documented command writes'

const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n')

function guardStep(): string {
  const job = workflowJobBody(readWorkflow('.github/workflows/ci.yml'), 'lint')
  return stripComments(workflowStepBody(job, STEP))
}

describe('pnpm-lock.yaml is what the documented command writes (#2363)', () => {
  it('the CI job carrying the check runs on pull requests', () => {
    // Every change reaches main through a pull request, so this is where a
    // drifted lockfile has to be stopped. A job gated off pull requests would
    // carry a check that never runs.
    const job = workflowJobBody(readWorkflow('.github/workflows/ci.yml'), 'lint')
    expect(job).toMatch(/^\s*if:\s*github\.event_name == 'pull_request'\s*$/m)
  })

  it('CI re-resolves the lockfile with the forcing command', () => {
    expect(guardStep(), `the '${STEP}' step must run \`pnpm ${COMMAND_ARGS}\``).toMatch(
      /^\s*pnpm install --lockfile-only --resolution-only\s*$/m,
    )
  })

  it('CI fails when re-resolving changed the lockfile, and says how to fix it', () => {
    const step = guardStep()
    // The comparison, then a non-zero exit on difference. Without the exit the
    // step prints a diff and passes, which is the silence this replaces.
    expect(step).toMatch(/git diff --quiet -- pnpm-lock\.yaml/)
    expect(step).toMatch(/^\s*exit 1\s*$/m)
    // The step resolves BEFORE it compares; the other order compares the
    // committed file with itself and always passes.
    expect(step.indexOf('--resolution-only')).toBeLessThan(step.indexOf('git diff --quiet'))
    // A person reading the red needs the command, not just the fact.
    expect(step).toContain(`npx -y pnpm@${declaredPnpmVersion()!} ${COMMAND_ARGS}`)
  })

  it('CLAUDE.md documents a command that writes the same form, at the declared pnpm version', () => {
    const doc = readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8')
    const documented = [...doc.matchAll(/`(CI=true npx -y pnpm@[^`]*)`/g)].map((m) => m[1])
    expect(documented.length, 'CLAUDE.md names no lockfile regeneration command').toBeGreaterThan(0)
    const version = declaredPnpmVersion()!.replace(/\./g, '\\.')
    const sameForm = new RegExp(`^CI=true npx -y pnpm@${version} install --lockfile-only( --resolution-only)?$`)
    for (const command of documented) {
      expect(
        sameForm.test(command),
        `CLAUDE.md documents \`${command}\`. Every lockfile command it documents must be one CI's ` +
          `check agrees with (\`npx -y pnpm@${declaredPnpmVersion()!} ${COMMAND_ARGS}\`, or the same without ` +
          '--resolution-only), or a person following the docs writes a lockfile CI refuses. A full ' +
          'install writes the eslint-plugin-import peer keys in a different form (#2363).',
      ).toBe(true)
    }
  })
})
