/**
 * The two checks on the bidding Worker's OPS_CONNECTIONS binding are wired
 * where they act (#2335, PR 9 of phase 5 of #1689). Cloudflare deploys a binding
 * to an entrypoint the deployed ops Worker does not export green, and every call
 * then throws (spike #2330), so:
 *
 *  - before merge, CI's Security scans job reads the DEPLOYED ops script
 *    (ops-exports-entrypoint.mjs) on a pull request changing the binding or the
 *    ops Worker, skipping a fork or Dependabot (no token) and, with a warning,
 *    a pull request whose files could not be read;
 *  - after deploy, Deploy makes a real call through the binding
 *    (ops-connections-probe.mjs) once either Worker deployed, and fails the run
 *    unless it is answered.
 */
import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowStepBody } from './_scan-utils'

describe('before merge: the deployed ops Worker is read', () => {
  const security = workflowJobBody(readWorkflow('.github/workflows/ci.yml'), 'security')
  const step = workflowStepBody(security, 'Deployed ops Worker exports OpsConnections (live)')

  it('runs on pull requests, after a failed step too, with the Cloudflare token', () => {
    expect(step).toMatch(/if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' \}\}/)
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(step).toContain('node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON .github/scripts/ops-exports-entrypoint.mjs')
  })

  it('hands the script each file\'s patch and whether the list could be read, so it can skip a money only change and an unreadable list', () => {
    expect(step).toContain(`gh api "repos/\${GITHUB_REPOSITORY}/pulls/\${PR}/files" --paginate --jq '.[] | {filename, patch} | @json' > "\${PR_FILES}"`)
    expect(step).toContain('PR_FILES_READ=false')
    expect(step).toContain('export PR_FILES PR_FILES_READ')
  })

  it('skips only a fork or a Dependabot pull request with no token, and says so', () => {
    expect(step).toMatch(/\[ -z "\$\{CLOUDFLARE_API_TOKEN\}" \] && \{ \[ "\$\{IS_FORK\}" = "true" \] \|\| \[ "\$\{GITHUB_ACTOR\}" = "dependabot\[bot\]" \]; \}/)
    expect(step).toContain('::notice::')
  })
})

describe('after deploy: a real call through the binding', () => {
  const job = workflowJobBody(readWorkflow('.github/workflows/deploy.yml'), 'ops-connections-probe')

  it('waits for both Workers and runs when either deployed and neither failed', () => {
    expect(job).toMatch(/^ {4}needs: \[deploy-worker, deploy-ops-worker\]$/m)
    expect(job).toContain("&& needs.deploy-worker.result != 'failure'")
    expect(job).toContain("&& needs.deploy-ops-worker.result != 'failure'")
    expect(job).toContain("&& (needs.deploy-worker.result == 'success' || needs.deploy-ops-worker.result == 'success')")
    expect(job).toMatch(/^ {4}timeout-minutes: \d+$/m)
  })

  it('calls the deployed bidding Worker as the e2e user and gates on the answer', () => {
    expect(job).toContain('run: node .github/scripts/ops-connections-probe.mjs')
    expect(job).toContain('WORKER_URL: ${{ vars.NEXT_PUBLIC_WORKER_URL }}')
    expect(job).toContain('E2E_PASSWORD: ${{ secrets.E2E_PASSWORD }}')
    expect(job).not.toMatch(/continue-on-error/)
  })
})
