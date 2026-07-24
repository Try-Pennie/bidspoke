# Dependency audit baseline (#263)

CI runs Trivy against `pnpm-lock.yaml` and fails the build on any **new** high or
critical advisory in a **production** dependency:

```
trivy fs --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
  --ignorefile .trivyignore --no-progress pnpm-lock.yaml
```

To make that gate green-but-strict against the dependency tree as it stands today,
a small set of pre-existing highs are either patched via `pnpm.overrides` (real
fixes) in the root `package.json`, or baselined per-advisory in `.trivyignore`.

The ignore list is **per-advisory, not blanket**: a brand-new high in any of these
same packages still trips the gate (verified: dropping any single id from
`.trivyignore` turns CI red again). Each entry below says why it is safe to
baseline. Revisit whenever a Dependabot PR bumps the parent tooling.

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
| `ws` | `>=8.21.0` | Pulled by `@supabase/supabase-js` (runtime) and `@cloudflare/next-on-pages`. Minor bump, backward compatible. |
| `glob` | `>=10.5.0` (the 10.x line only) | Pulled by `eslint-config-next` (lint tooling). Range-scoped override so other glob majors in the tree are untouched. |
| `postcss` | `>=8.5.12` (only versions below it) | CVE-2026-45623 (file read via `sourceMappingURL` during CSS processing). The vulnerable 8.4.31 was `next` 14's own pin; the app's direct dep was already on 8.5.x. Range-scoped so nothing already safe is touched. |

## Ignored (.trivyignore): present, but remediation is tracked

### next — needs the blocked 14 to 15 major upgrade (tracked separately)

```
CVE-2026-44573        # = GHSA-36qx-fr4f-26g5
CVE-2026-44578        # = GHSA-c4j6-fc7j-m34r
GHSA-8h8q-6873-q5fj
GHSA-h25m-26qc-wcjf
GHSA-q4gf-8mx6-v5v3
```

These five are all the same `next` advisories baselined before the tool swap;
Trivy just reports two of them by their CVE alias (noted inline above). They are
fixed only in Next 15.x. The app is on Next 14 (App Router), and the 14 to 15
upgrade is a tracked major migration (also blocks the ESLint 8 to 9 bump, #296).
The frontend is an internal, authenticated ops tool (small known user set), which
lowers the practical exposure of the SSRF / cache / DoS classes here. The
remediation is the Next 15 upgrade, tracked in #558 (which superseded the closed
#443), not an indefinite ignore. Remove all five the moment Next is upgraded.

Three more `next` advisories were published around 2026-07-24, in the same
fixed-only-in-15.x situation, and were verified non-applicable before baselining:

```
CVE-2026-64641        # DoS in App Router Server Actions
CVE-2026-64645        # SSRF in rewrites via attacker-controlled destination
CVE-2026-64649        # SSRF in Server Actions on custom servers
```

`apps/web` contains no Server Actions (`rg "use server"` returns nothing),
defines no rewrites in `next.config.js`, and deploys to Cloudflare Pages rather
than a custom server, so none of the three vulnerable code paths exist here.
Same remediation: remove them with the Next 15 upgrade (#558).

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
