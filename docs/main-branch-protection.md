# How main is protected (#266)

The rule, which CLAUDE.md states: every change to main goes through a pull
request that CI has passed. This page is how that is enforced, what it depends
on, and what stands behind it.

## The `Protect main` ruleset

Since the repository went public on 2026-10-25, GitHub enforces the rule: the
`Protect main` ruleset (id 25746493) requires a pull request and the nine CI
checks (Typecheck, Lint, Test (worker), Test (web), Money gate, Accessibility
(axe), Auth gate fails closed, Security scans, Outage drill), and refuses force
pushes and deleting main. Nobody bypasses it, and no approving review is
required, because an author cannot approve their own pull request (Dan,
2026-10-25).

A renamed check is still required under its old name, so a pull request that
renames one of those checks renames it in the ruleset in the same change
(L305), or every later pull request waits for a check that never reports.

## It holds only while the repository is public

On the free plan a private repository's rulesets are not enforced (both
`/rulesets` and `/branches/main/protection` answered 403, "Upgrade to GitHub Pro
or make this repository public"), so going private again turns this back into a
rule nothing enforces.

## The detection behind it

The `Main has no unreviewed direct push` step of the Security scans job in
`ci.yml` (#760) runs on every push to main and reports a commit that arrived
without a reviewed pull request. It is fail safe towards staying quiet, because
GitHub's commit to pull request association can be empty for a genuinely
reviewed merge.

## The local hooks are rules, not constraints

The husky pre-push hooks (test gate, style gate) are rules rather than
constraints: `--no-verify`, `SKIP_TEST_CHECK` and `SKIP_STYLE_CHECK` each bypass
them, which is by design for the rare justified case and useless as a barrier.
