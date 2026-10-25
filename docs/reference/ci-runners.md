# Where CI jobs run: GitHub's runners or the Mac (#2768)

From 2026-10-23 GitHub refused every hosted Actions job in the Try-Pennie org over
billing, while self-hosted runners still got jobs. So every job in
`.github/workflows` reads one org variable, `PENNIE_CI_RUNNER`, as Slate's do
(Try-Pennie/slate#4208):

```yaml
runs-on: ${{ vars.PENNIE_CI_RUNNER == 'pennie-mac' && 'pennie-mac' || 'ubuntu-latest' }}
```

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

`apps/web/src/lib/__tests__/ci-runner-routing.test.ts` pins all of it: every job
routed, the Docker set, the twins, and a refusal of `sudo`, `sha256sum`, `timeout`,
`setsid`, `apt-get`, `pipx`, a bare `pip install` and a fixed port in a routed job.
