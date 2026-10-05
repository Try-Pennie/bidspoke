import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow } from './_scan-utils'

/**
 * Every Deploy Drift alert that sends the reader to Deploy names a remedy that
 * actually ships the newest commit (#1761).
 *
 * All three drift alerts used to say "re-run the most recent Deploy run on main".
 * A re-run deploys that run's own commit (github.sha), which is the commit already
 * live, so on 2026-10-05 the advice could not have fixed the strand it was sent
 * about: the newest commit had never had a Deploy run at all, because the
 * Dependabot auto-merge started none. Starting Deploy on main (Actions, Deploy,
 * Run workflow) builds a fresh run at main's tip, which does.
 *
 * The remedy is ONE value on the job (L605, L613), so the six places it is used
 * cannot drift apart.
 */
const DRIFT = readWorkflow('.github/workflows/deploy-drift.yml')
const RECOVERY = readFileSync(path.join(REPO_ROOT, 'docs/disaster-recovery.md'), 'utf8')

/** The advice that only re-deploys what is already live, in each spelling it has had. */
const STALE_REMEDY = /re-?run (?:the )?(?:most recent )?Deploy|redeploy it from the most recent Deploy run|re-run the Deploy workflow/i

describe('the drift alerts send the reader to start Deploy on main (#1761)', () => {
  it('no longer tells anybody to re-run an old Deploy run, which redeploys the commit already live', () => {
    const offending = DRIFT.split('\n').filter((line) => STALE_REMEDY.test(line) && !line.trim().startsWith('#'))
    expect(offending).toEqual([])
  })

  it('defines the remedy once, on the job, naming Run workflow and linking the Deploy workflow', () => {
    const def = DRIFT.match(/\n {6}DEPLOY_REMEDY:\s*(.+)/)?.[1] ?? ''
    expect(def).toContain('Run workflow')
    expect(def).toContain('${{ github.server_url }}/${{ github.repository }}/actions/workflows/deploy.yml')
    expect(def).toMatch(/re-?running an old/i)
  })

  it('uses that one remedy at every alert that sends the reader to Deploy', () => {
    // worker stranded; site behind and on an unknown commit; tail stranded, on
    // an unknown commit, and down.
    const uses = DRIFT.match(/"\$DEPLOY_REMEDY"/g) ?? []
    expect(uses.length).toBe(6)
  })

  it('names both causes of a stranded worker, not only a failed Verify', () => {
    expect(DRIFT).toContain('This happens when a deploy failed at Verify, or when a merge started no Deploy.')
  })
})

describe('the recovery runbook gives the same remedy (#1761)', () => {
  it('does not tell anybody to re-run the Deploy workflow', () => {
    expect(RECOVERY.split('\n').filter((line) => STALE_REMEDY.test(line))).toEqual([])
  })

  it('says to start Deploy on main with Run workflow', () => {
    expect(RECOVERY).toMatch(/start Deploy on main[^\n]*Run workflow/i)
  })
})
