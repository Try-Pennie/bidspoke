# Dependency audit baseline (#263)

CI runs Trivy against `pnpm-lock.yaml` and fails the build on any **new** high or
critical advisory in a **production** dependency:

```
trivy fs --scanners vuln --severity HIGH,CRITICAL --exit-code 0 \
  --ignorefile .trivyignore --no-progress \
  --format json --output "$RUNNER_TEMP/trivy-report.json" pnpm-lock.yaml
node .github/scripts/scan-coverage.mjs trivy "$RUNNER_TEMP/trivy-report.json" pnpm-lock.yaml
```

Trivy's own `--exit-code` is disarmed on purpose (#779). It exits 0 both when the
lockfile is clean and when it could not parse the lockfile at all, and those are
not the same result. `scan-coverage.mjs` therefore owns both decisions: it fails
unless the report carries a result for `pnpm-lock.yaml` with a resolved ecosystem,
and then fails again if that result holds any advisory. Coverage is judged first,
because a scan that covered nothing has not earned the right to report clean.

This is not hypothetical: the job was green for the eighteen days from 2026-07-27
to 2026-08-14 having audited nothing, because a duplicated entry in the lockfile
made it unparseable. The same reasoning is applied to gitleaks (which is given a
canary secret it must find, since it emits no coverage signal at all) and to
semgrep (whose `paths.scanned` must cover every named source tree).

Pre-existing highs are fixed by forcing the patched version through
`pnpm.overrides` in the root `package.json`. A high that cannot be fixed yet may be
baselined per advisory in `.trivyignore`, never as a blanket rule, and only with
its reason written in the Ignored section below:
`apps/web/src/lib/__tests__/trivyignore-documented.test.ts` fails on an id that
section does not name. The list is empty today.

## Why Trivy, not `pnpm audit`

`pnpm audit` called npm's legacy audit endpoint (`/-/npm/v1/security/audits`),
which npm **retired** in July 2026. It now returns `410 Gone` and points to a
newer "bulk advisory" endpoint that `pnpm audit` does not use. The gate failed on
every push regardless of the code (reproduced on pnpm 9 and 10). Trivy reads the
lockfile directly against its own maintained vulnerability DB, so it has no
dependency on any npm endpoint.

**Behavior difference worth knowing:** Trivy excludes dev/test dependencies by
default, so the old `undici` and `vite` exceptions are gone (those never shipped,
which is exactly why they were baselined before). The gate now scopes to what
actually reaches production, which is stricter where it matters and quieter on
tooling noise.

## Patched (pnpm.overrides) — actually fixed, not ignored

| Package | Forced to | Why |
|---------|-----------|-----|
| `hono` | `^4.12.27` (direct dep) | The Worker's HTTP framework — the one advisory in real production runtime code. Bumped within the same major; full worker suite passes. |
| `ws` | `>=8.21.0 <9` | Pulled by `@supabase/supabase-js` (runtime) and `@cloudflare/next-on-pages`. Minor bump, backward compatible. |
| `glob` | `>=10.5.0 <11` | Pulled by `eslint-config-next` (lint tooling). Both ends are load-bearing: the lower bound patches the advisory, the upper keeps the override inside the 10.x line. |
| `postcss` | `>=8.5.12 <9` (replacing only versions below the floor) | CVE-2026-45623 (file read via `sourceMappingURL` during CSS processing). The vulnerable 8.4.31 was `next` 14's own pin; the app's direct dep was already on 8.5.x. Range-scoped so nothing already safe is touched. |
| `nanoid` | `>=3.3.18 <4` | CVE-2026-67213 (denial of service via an infinite loop in random ID generation). Reaches production only through `postcss`, which requires CommonJS; nanoid 5+ is ESM-only, hence the upper bound. |
| `dompurify` | `>=3.4.17 <4` (replacing only versions below the floor) | GHSA-mrv2-3pqr-j5jr (#2691). Pulled by `monaco-editor`, and also a direct web dependency. Monaco carries its own copy too, which the override cannot reach, so the canvas editor is served from our build and `apps/web/monaco-dompurify-swap.js` points Monaco's copy at this package (#2695); `monaco-self-hosted.test.ts` guards both. |

### Every override carries an upper bound

An override exists to force a vulnerable package up to its **patched** version, so
it is written with both ends of the range pinned. Left as a bare minimum it also
permits every future major, and pnpm resolves the newest release that satisfies
it, which is a major upgrade nobody asked for and nothing re-tested.

This is not theoretical. Patching nanoid on 2026-08-14, `">=3.3.18"` resolved to
nanoid **6.0.1**; nanoid 5+ is ESM-only and its only consumer here (`postcss`)
requires CommonJS, so the CSS build would have broken. Checking the siblings then
showed the same thing had already shipped silently: `glob` overridden to
`">=10.5.0"` had resolved to **13.0.6**, three majors past the 10.x line the table
above used to claim it pinned.

`apps/web/src/lib/__tests__/pnpm-override-major-drift.test.ts` now fails the suite
when any override resolves outside the major it patches to. Crossing a major is
still allowed, but as its own deliberate change with the consumer re-tested.

## Ignored (.trivyignore): none today

Nothing is ignored. An id added to `.trivyignore` must be named in this section,
with why it is safe to carry and what removes it.

## Removed from the ignore list

Eight `next` advisories were baselined while the app was on Next 14:
CVE-2026-44573, CVE-2026-44578, GHSA-8h8q-6873-q5fj, GHSA-h25m-26qc-wcjf,
GHSA-q4gf-8mx6-v5v3, CVE-2026-64641, CVE-2026-64645 and CVE-2026-64649. Each is
patched at or below 15.5.21 according to the GitHub advisory database, and the app
is on 15.5.28 (#2675), so they were removed on 2026-10-22. Trivy run locally with
an empty ignore file reported 0 findings on that day's lockfile, and the same run
on the lockfile from before the upgrade reported the next and dompurify advisories,
so the clean result is a real one.

> The old `undici` (build/dev tooling) and `vite` (test-runner) exceptions were
> dropped in the Trivy swap: Trivy does not scan dev/test deps by default, so they
> no longer surface. If a future prod-facing use pulls either in, it will trip the
> gate and must be reassessed then.

## How to refresh this baseline

1. Run the CI command above locally (`brew install trivy` first). Anything **not**
   in `.trivyignore` is a real new high in a production dep to fix.
2. When a Dependabot PR bumps a parent (next, next-on-pages), re-run and delete any
   id that no longer resolves.
3. Never add an id to `.trivyignore` without a one-line reason there and here.
   Use the id Trivy actually reports (it may be a CVE, not the GHSA).
