import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

/**
 * The scheduled-workflow dead-man's-switch (#805) is driven by a hand-written
 * registry in the worker, and a hand-written registry checks only what it lists.
 *
 * That is LESSONS L96 exactly: anything missing from the registry is exempt from
 * the very check meant to catch it, and the guard reports green while blind. The
 * entries someone remembered to add are precisely the ones already being thought
 * about; the one that matters is the workflow added six months from now by
 * somebody who has never read that file.
 *
 * So this closes the loop in the code-to-registry direction: every workflow in
 * `.github/workflows` that runs on a schedule must be watched. The worker cannot
 * do this itself, because it compiles against the Workers runtime and has no
 * filesystem, which is why it lives here with the other build-time guards.
 */
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows')
const REGISTRY = path.join(REPO_ROOT, 'apps/worker/src/lib/workflow-schedule-watch.ts')

/** Every workflow file that declares a `schedule:` trigger. */
const scheduledWorkflows = (): string[] => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  expect(files.length, 'no workflow files found, so this guard is asserting nothing').toBeGreaterThan(0)

  return files.filter((file) => {
    const lines = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').split('\n')
    // Strip comments before matching, so a workflow that only MENTIONS a schedule
    // in prose is not counted as having one (L103).
    return lines.some((line) => /^\s{2}schedule:\s*$/.test(line.replace(/#.*$/, '')))
  })
}

describe('every scheduled workflow is watched (#805)', () => {
  it('finds at least one scheduled workflow to check', () => {
    // Without this, a change that renamed the directory or the trigger syntax
    // would leave the assertion below trivially satisfied by an empty list, which
    // is the shape of a guard that passes while measuring nothing (L98).
    expect(scheduledWorkflows().length).toBeGreaterThan(0)
  })

  it('lists every one of them in the worker registry', () => {
    const registry = readFileSync(REGISTRY, 'utf8')
    for (const file of scheduledWorkflows()) {
      expect(
        registry,
        `${file} runs on a schedule but is not in WATCHED_WORKFLOWS, so nothing would notice if it stopped firing`,
      ).toContain(`file: '${file}'`)
    }
  })

  it('does not keep watching a workflow the repo no longer has', () => {
    // The other direction, and the one the code-to-registry check above cannot
    // see: a deleted or renamed workflow simply stops appearing in the list this
    // guard scans, so a stale registry entry would sit there for ever. At runtime
    // that entry now reports `missing` and alerts about itself (#844), which is
    // honest but is a message nobody can act on except by editing this file.
    const registry = readFileSync(REGISTRY, 'utf8')
    const present = new Set(readdirSync(WORKFLOW_DIR))
    const watched = [...registry.matchAll(/^\s*file: '([^']+)',$/gm)].map((m) => m[1])
    expect(watched.length, 'no registry entries were found, so this guard is asserting nothing').toBeGreaterThan(0)
    for (const file of watched) {
      expect(present.has(file), `WATCHED_WORKFLOWS names ${file}, which is not in .github/workflows`).toBe(true)
    }
  })

  it('records each watched workflow with the cron it actually declares', () => {
    // A window is chosen against a cadence, so a registry entry carrying a cron
    // the workflow no longer runs on is a window sized for a schedule that does
    // not exist.
    const registry = readFileSync(REGISTRY, 'utf8')
    for (const file of scheduledWorkflows()) {
      const yml = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')
      const crons = [...yml.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1])
      expect(crons.length, `${file} declares a schedule with no cron expression`).toBeGreaterThan(0)

      const entry = registry.slice(registry.indexOf(`file: '${file}'`))
      const declared = entry.match(/cron: '([^']+)'/)
      expect(declared, `${file} has no cron recorded in the registry`).not.toBeNull()
      expect(
        crons,
        `the registry says ${file} runs on ${declared![1]}, which is not one of its declared schedules`,
      ).toContain(declared![1])
    }
  })
})
