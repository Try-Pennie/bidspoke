/**
 * Per test time limits for every vitest config in the repo (#2768).
 *
 * Vitest gives a test 5 seconds and a hook 10. CI runs on GitHub's runners or on
 * the Mac runners (the org variable PENNIE_CI_RUNNER, docs/ci-runners.md). A Mac
 * runner shares Dan's work MacBook with the other runner, Slate's jobs and
 * everything else on it, so a test that takes a fraction of a second alone can
 * pass 5 seconds there: three did on 2026-10-25, with the load average at 24 on
 * 14 cores. The limit guards against a hang, so on a self-hosted runner it
 * widens; on GitHub and locally it stays exactly the default.
 *
 * Keyed on RUNNER_ENVIRONMENT, which the runner sets itself ("github-hosted" or
 * "self-hosted"), so it follows where the job actually runs.
 * apps/web/src/lib/__tests__/vitest-runner-timeouts.test.ts holds every config to it.
 */
export function timeoutsFor(runnerEnvironment: string | undefined): { testTimeout?: number; hookTimeout?: number } {
  return runnerEnvironment === 'self-hosted' ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}
}

export const runnerTimeouts = timeoutsFor(process.env.RUNNER_ENVIRONMENT)
