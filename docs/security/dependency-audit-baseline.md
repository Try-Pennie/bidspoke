# Dependency audit baseline (#263)

CI runs `pnpm audit --audit-level=high` and fails the build on any **new** high or
critical advisory. To make that gate green-but-strict against the dependency tree
as it stands today, a small set of pre-existing high advisories are either patched
via `pnpm.overrides` or explicitly ignored via `pnpm.auditConfig.ignoreGhsas` in
the root `package.json`.

The ignore list is **per-advisory (GHSA id), not blanket**: a brand-new high in any
of these same packages still trips the gate. Each entry below says why it is safe
to baseline. Revisit whenever a Dependabot PR bumps the parent tooling.

## Patched (pnpm.overrides) — actually fixed, not ignored

| Package | Forced to | Why |
|---------|-----------|-----|
| `hono` | `^4.12.27` (direct dep) | The Worker's HTTP framework — the one advisory in real production runtime code. Bumped within the same major; full worker suite passes. |
| `ws` | `>=8.21.0` | Pulled by `@supabase/supabase-js` (runtime) and `@cloudflare/next-on-pages`. Minor bump, backward compatible. |
| `glob` | `>=10.5.0` (the 10.x line only) | Pulled by `eslint-config-next` (lint tooling). Range-scoped override so other glob majors in the tree are untouched. |

## Ignored (pnpm.auditConfig.ignoreGhsas) — present, but not exploitable here

### undici — build/dev tooling only, never in the deployed Worker

`GHSA-vrm6-8vpv-qv8q`, `GHSA-v9p9-hfj2-hcw8`, `GHSA-vxpw-j846-p89q`,
`GHSA-vmh5-mc38-953g`, `GHSA-hm92-r4w5-c3mj`

`undici` is pulled transitively through `wrangler`, `miniflare`, and
`@cloudflare/next-on-pages` — all build/dev tooling. The **deployed** Worker uses
the Cloudflare runtime's built-in `fetch` (workerd), not the npm `undici` package,
so these (SOCKS5 proxy reuse, header/redirect issues) are not reachable in
production. Forcing a single `undici` version across the tree is unsafe: the tree
legitimately holds both the 6.x line (next-on-pages) and the 7.x line (wrangler),
and pinning either inside miniflare risks breaking the local-runtime emulation.
Cleared automatically when Cloudflare's tooling bumps its bundled undici.

### vite — test-runner tooling only, not shipped or built

`GHSA-fx2h-pf6j-xcff`

`vite` is pulled by `vitest` (the test runner). It is not part of any shipped
artifact or the production build output (Next builds via `next-on-pages`, the
Worker via `wrangler`). A scoped override would not re-resolve cleanly across the
vitest pin, so it is ignored. Cleared when `vitest` bumps its bundled vite.

### next — needs the blocked 14 to 15 major upgrade (tracked separately)

`GHSA-h25m-26qc-wcjf`, `GHSA-q4gf-8mx6-v5v3`, `GHSA-8h8q-6873-q5fj`,
`GHSA-c4j6-fc7j-m34r`, `GHSA-36qx-fr4f-26g5`

These are fixed only in Next 15.x. The app is on Next 14 (App Router), and the
14 to 15 upgrade is a tracked major migration (also blocks the ESLint 8 to 9 bump,
#296). The frontend is an internal, authenticated ops tool (small known user set),
which lowers the practical exposure of the SSRF / cache / DoS classes here. The
remediation is the Next 15 upgrade, tracked in #443 — not an indefinite
ignore. Remove these the moment Next is on 15.5.16+.

## How to refresh this baseline

1. Run `pnpm audit --audit-level=high`. Anything **not** ignored is a real new high to fix.
2. When a Dependabot PR bumps a parent (wrangler, next-on-pages, vitest, next), re-run audit and delete any GHSA that no longer resolves.
3. Never add a GHSA here without a one-line reason in this file.
