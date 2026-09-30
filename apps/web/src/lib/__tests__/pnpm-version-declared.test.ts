import { describe, expect, it } from 'vitest'
import {
  declaredPnpmVersion,
  readWorkflow,
  workflowFiles,
  workflowJobBody,
  workflowJobIds,
} from './_scan-utils'

/**
 * The repo's pnpm version is declared ONCE, in the root package.json
 * `packageManager`, and it is pnpm 9 (#1677).
 *
 * Until #1677 the version lived only in each workflow's `pnpm/action-setup`
 * `version: 9` input, and nothing in the repo itself said which pnpm it wanted.
 * Dependabot, reading no declaration, resolved lockfiles with the newest pnpm,
 * which by 2026-09 was pnpm 11. Measured 2026-09-30: regenerating the lockfile
 * from main with pnpm 9.15.9 and 10.34.6 keeps the `overrides` block that the
 * root package.json `pnpm.overrides` puts there (the ws, glob, postcss and
 * nanoid security floors), and pnpm 11.28.3 drops it. So every Dependabot PR,
 * security updates included, carried a lockfile CI's pnpm 9 refused with
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH, and none was ever built or tested.
 *
 * Declaring the version once fixes that and keeps it fixed, which is what the
 * three tests below hold:
 *
 *  1. The declaration exists and is an exact pnpm 9 (why 9, and not merely
 *     "some version", is in the message: next-on-pages only finds the pinned
 *     Vercel CLI under pnpm 9, see vercel-cli-pinned.test.ts).
 *  2. No workflow names a version of its own. pnpm/action-setup v6 THROWS
 *     "Multiple versions of pnpm specified" when a `version` input and
 *     `packageManager` differ, and it compares them as strings, so even `9`
 *     against `9.15.9` fails every job. A second declaration is also a second
 *     source of truth, which drifts (L41).
 *  3. Every setup step can actually READ the declaration. action-setup reads
 *     `package_json_file` (default `package.json`) relative to the workspace
 *     root; a job whose only checkout sits in a subdirectory has no root
 *     package.json, and the step then fails with "No pnpm version is
 *     specified". That is a failure only a real run would otherwise find.
 *
 * Workflows are enumerated from disk, so one added later is covered the day it
 * lands (L96).
 */

interface Step {
  text: string
}

/** Split a job body into its steps, by the indentation of the `steps:` list. */
function stepsOf(jobBody: string): Step[] {
  const lines = jobBody.split('\n')
  const stepsAt = lines.findIndex((l) => /^\s*steps:\s*$/.test(l))
  if (stepsAt < 0) return []
  const dashIndent = (() => {
    for (const l of lines.slice(stepsAt + 1)) {
      const m = /^(\s*)- /.exec(l)
      if (m) return m[1].length
    }
    return -1
  })()
  if (dashIndent < 0) return []

  const steps: Step[] = []
  let current: string[] | null = null
  for (const line of lines.slice(stepsAt + 1)) {
    const lead = /^(\s*)/.exec(line)![1].length
    if (line.trim() !== '' && !line.trim().startsWith('#') && lead < dashIndent) break
    if (lead === dashIndent && line.slice(lead).startsWith('- ')) {
      if (current) steps.push({ text: current.join('\n') })
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) steps.push({ text: current.join('\n') })
  return steps
}

const usesAction = (step: Step, action: string): boolean =>
  new RegExp(`^\\s*-?\\s*uses:\\s*${action.replace('/', '\\/')}@`, 'm').test(step.text)

const keyValue = (step: Step, key: string): string | undefined =>
  new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm').exec(step.text)?.[1]

interface PnpmSetup {
  where: string
  step: Step
  /**
   * Directories this repo was checked out into before this step, '' meaning the
   * workspace root, each mapped to whether that checkout pinned a `ref:`.
   */
  checkoutsBefore: Map<string, boolean>
}

function pnpmSetups(): PnpmSetup[] {
  const out: PnpmSetup[] = []
  for (const file of workflowFiles()) {
    const yaml = readWorkflow(file)
    for (const job of workflowJobIds(yaml)) {
      const checkouts = new Map<string, boolean>()
      for (const step of stepsOf(workflowJobBody(yaml, job))) {
        if (usesAction(step, 'actions/checkout') && keyValue(step, 'repository') === undefined) {
          checkouts.set((keyValue(step, 'path') ?? '').replace(/\/$/, ''), keyValue(step, 'ref') !== undefined)
        }
        if (usesAction(step, 'pnpm/action-setup')) {
          out.push({ where: `${file} job '${job}'`, step, checkoutsBefore: new Map(checkouts) })
        }
      }
    }
  }
  return out
}

describe('pnpm version is declared once, as pnpm 9 (#1677)', () => {
  it('the root package.json declares an exact pnpm 9 as its packageManager', () => {
    const version = declaredPnpmVersion()
    expect(
      version,
      'The root package.json has no `"packageManager": "pnpm@9.x.y"`. Without it Dependabot resolves ' +
        'lockfiles with the newest pnpm, and pnpm 11 drops the package.json pnpm.overrides from the ' +
        'lockfile, so CI refuses every Dependabot PR at install (#1677).',
    ).toBeDefined()
    expect(
      /^9\.\d+\.\d+$/.test(version!),
      `The root package.json declares pnpm@${version!}. It must be an exact pnpm 9 (9.x.y, no range, ` +
        'no hash suffix): pnpm 11 drops the package.json pnpm.overrides from the lockfile (#1677), and ' +
        'next-on-pages only finds the pinned Vercel CLI under pnpm 9, so on pnpm 10 the Pages build ' +
        'silently downloads an arbitrary one (#1064).',
    ).toBe(true)
  })

  it('finds pnpm setup steps in both CI and Deploy, so the checks below cannot pass by reading nothing', () => {
    const files = new Set(pnpmSetups().map((s) => s.where.split(' ')[0]))
    expect([...files]).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/deploy.yml']))
  })

  it('no workflow names a pnpm version of its own', () => {
    const offenders = pnpmSetups()
      .filter((s) => keyValue(s.step, 'version') !== undefined)
      .map((s) => `${s.where} sets version: ${keyValue(s.step, 'version')!}`)
    expect(
      offenders,
      'pnpm/action-setup reads the version from package.json packageManager. A `version:` input as ' +
        'well is a second source of truth, and action-setup v6 refuses the job ("Multiple versions of ' +
        'pnpm specified") whenever the two strings differ, `9` against `9.15.9` included. Delete the input.',
    ).toEqual([])
  })

  it('every pnpm setup step can read the package.json that declares the version', () => {
    const offenders: string[] = []
    for (const s of pnpmSetups()) {
      const file = keyValue(s.step, 'package_json_file') ?? 'package.json'
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
      const pinnedRef = s.checkoutsBefore.get(dir)
      if (file.slice(dir.length).replace(/^\//, '') !== 'package.json' || pinnedRef !== false) {
        const seen =
          [...s.checkoutsBefore]
            .map(([d, ref]) => `${d === '' ? '(root)' : d}${ref ? ' (at a pinned ref)' : ''}`)
            .join(', ') || 'none'
        offenders.push(`${s.where} reads '${file}', but this repo is checked out before it at: ${seen}`)
      }
    }
    expect(
      offenders,
      'action-setup resolves package_json_file against the workspace root. A job that checks the repo ' +
        'out into a subdirectory must point package_json_file at that checkout (for example ' +
        'head/package.json), or the step fails with "No pnpm version is specified". It must be the ' +
        "checkout of the commit under test, never one pinned to another `ref:` (a live commit): that one " +
        'can predate the declaration, and both sides of a comparison should be built by the same pnpm.',
    ).toEqual([])
  })
})
