# @bidspoke/service-catalogue

The ops service catalogue (#2337, #1689 Phase 7).

## Two entry points, and no root one

- `@bidspoke/service-catalogue/schema` is declarative (services, actions,
  arguments, traits, the `(key, version)` lookup), for web, the validator and
  the MCP tool.
- `@bidspoke/service-catalogue/runtime` holds each action's `run` and the
  services' auth function slots, for the Workers only.

Web never imports `runtime`
(`apps/web/src/lib/__tests__/service-catalogue-runtime-stays-out-of-web.test.ts`,
which also scans every package web depends on), and `schema` never reaches it
(the package's own `catalogue.test.ts`).

## Actions are never edited once released (D1)

An action is `{ key, name, version, arguments[], sideEffect, idempotent, run }`.
`src/fingerprints.json` holds a sha256 per `key@version` over:

- its arguments and traits;
- the source of its run file `src/runtime/actions/<key>.v<version>.ts`, plus
  every file that run file reaches through relative value imports (type only
  imports are left out) or through a workspace package, followed into its
  source;
- the resolved version of every npm package reached, and its whole dependency
  closure in the lockfile.

A changed fingerprint fails, asking for a new version. A new version's
fingerprint line is printed by the failing test for you to add.

Every action decides `sideEffect` and `idempotent` itself, with
`idempotentBecause` saying why, never from a Pipedream annotation (R11). Steps
resolve an action by `(key, version)`, and a missing version is refused as
`action_version_missing`, never run on the newest.

An action that changes something says what a step test sends in its `realSend`
(display only, outside the fingerprint); the catalogue check refuses one without
it. See "Testing a step" in [docs/ops-worker.md](../../docs/ops-worker.md).

## Services

Snowflake (#2337) was the first service, then Slack (`slack.send-message`, the
ops bot of Dan's decision 6, never the alerts bot: the create and Reconnect
routes compare the bot ops verify measured with the alerts bot,
`lib/slack-alert-bot.ts`, #2654). HTTP (#2760) and Supabase (#2763) joined
Snowflake, Slack, Salesforce, Google, OpenAI and Anthropic later; their
refusal rules are in CLAUDE.md (Ops services) and
[docs/ops-connections-logins.md](../../docs/ops-connections-logins.md).

`src/__fixtures__/catalogue` is a test only service that proves the machinery.
