# Where CI jobs run: GitHub's runners or the Mac (#2768)

From 2026-10-23 GitHub refused every hosted Actions job in the Try-Pennie org over
billing, while self-hosted runners still got jobs. So every job in
`.github/workflows` reads one org variable, `PENNIE_CI_RUNNER`, as Slate's do
(Try-Pennie/slate#4208):

```yaml
runs-on: ${{ vars.PENNIE_CI_RUNNER == 'pennie-mac' && (!github.event.pull_request || github.event.pull_request.head.repo.full_name == github.repository) && 'pennie-mac' || 'ubuntu-latest' }}
```

The middle clause is there because the repository is public (since 2026-10-25):
anybody can fork it and open a pull request, and a pull request job runs that
code. With it, our own workflow files never send a fork's pull request, or one
whose head repository has been deleted, to Dan's Mac, whatever the variable says.
The check reads the event's pull request payload, not the event name, so a
`pull_request_target` or review trigger added later is held to it too.

It does NOT stop a stranger who means to reach the Mac (L805): a fork's pull
request runs the workflow files on the fork's own branch, so the fork can write
`runs-on: pennie-mac` itself. What stops that lives outside the repository:

- Actions requires approval for every outside contributor's pull request
  (`all_external_contributors`, set 2026-10-25), so nothing a stranger writes
  runs until someone in Try-Pennie approves it. Read the workflow diff before
  approving one.
- The org runner group holding the `pennie-mac` runners must not allow public
  repositories (organization Settings, Actions, Runner groups).

GitHub's own advice is never to give a public repository's untrusted pull
requests a self-hosted runner.

- **`pennie-mac`**: jobs run on the org runners on Dan's work MacBook. Their setup
  lives in Slate (`scripts/mac-runner/setup.sh`, `docs/workflows.md`), not here.
  Jobs queue while that Mac is asleep or offline.
- **Anything else** (`github`, empty, deleted, a typo): GitHub's `ubuntu-latest`.
  Switching back is that one org setting, with no code change.

A job that needs Docker would ask for `pennie-mac-docker` instead, the one runner
that has it. No Bidspoke job needs Docker today.

What a job must do to run on either machine:

- A Linux only step carries `if: runner.os == 'Linux'` and has a `(Mac runner)`
  twin beside it with `if: runner.os == 'macOS'`. Today those are the security
  scan's Trivy, gitleaks and Semgrep installs: the Mac runner user has no sudo, no
  write access to `/usr/local/bin`, and a Python that refuses a bare `pip install`.
- A sha256 goes through `.github/scripts/sha256.sh`, which uses `sha256sum` or
  `shasum -a 256`, whichever the machine has.
- Nothing listens on a fixed port, since every job on the Mac shares one machine
  (with Slate's jobs and a developer's dev server too). The browser checks serve the
  site through `.github/scripts/serve-pages-artifact.sh`, which picks a free port
  and sets `BASE_URL`.

- A test gets 30 seconds rather than vitest's 5 on a self-hosted runner, where it
  shares the machine: every vitest config spreads `runnerTimeouts` from
  `vitest.runner-timeouts.ts`, keyed on `RUNNER_ENVIRONMENT`, and
  `vitest-runner-timeouts.test.ts` holds every config to it. On GitHub and locally
  the limits are vitest's own.

`apps/web/src/lib/__tests__/ci-runner-routing.test.ts` pins the routing: every job
routed, a fork's pull request kept off the Mac, the Docker set, the twins, and a refusal of `sudo`, `sha256sum`, `timeout`,
`setsid`, `apt-get`, `pipx`, a bare `pip install` and a fixed port in a routed job.
