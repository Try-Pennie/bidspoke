# The partners page hears about another person's save over a private Supabase broadcast

## Status

**Proposed, results pending the live run** (#2131, PR0 of the partners page redesign #2114, 2026-10-15). The migration, the script and the local proof are merged with this ADR; the Results section is filled in from the live run against production, which needs the migration applied first. Nothing below the Results heading is a result until then.

## Context

PR4 of #2114 shows a person a notice, live, when somebody else saves the partner they have open (PM-2). That needs a channel from the moment a save commits to every browser of the same organization, and to no browser of any other organization.

Supabase Realtime broadcast on a **private** channel does this if two things hold on this project:

1. **Authorization.** Realtime admits a signed in person to a private channel only when Postgres lets that person `SELECT` a broadcast row of `realtime.messages` with `realtime.topic()` set to the channel's name. One policy decides it.
2. **A sender.** Either the database sends (`realtime.send` from a trigger, which covers every writer with no list of call sites, L247), or the Worker sends after each save (`POST /realtime/v1/api/broadcast` with the service key).

The database sender is preferred. Neither had been tried on this project, so it is proved first (L246), and a failure is held to the same controls as a success (L248).

## What this pull request adds

- **Migration `20261015000000_partner_page_realtime_auth.sql`.** One permissive `SELECT` policy on `realtime.messages` for `authenticated`: `extension = 'broadcast' AND realtime.topic() = 'partners:' || public.user_org_id()::text`. No `INSERT` policy, nothing for `anon`, nothing for presence. It applies as `postgres` through `supautils.policy_grants`, which names `realtime.messages` for `postgres` (read on production 2026-10-15); `postgres` is not a member of the table's owner, `supabase_realtime_admin`.
- **A `realtime` stub in `scripts/sql-suite/bootstrap.sql`**, copied from production: the table's columns, key, check and daily range partitioning, its owner, row level security and grants, and `realtime.send` and `realtime.topic()` verbatim. **The stub proves the SQL, not the platform**: the policy compiles, applies through the same policy grant, and decides correctly. Nothing in the stub delivers a message.
- **`supabase/tests/partner_page_realtime_auth.test.sql`**, eleven cases: the policy's shape; A reads A's topic; B is refused A's topic and A is refused B's (both directions, L497) while B reads its own; nothing with `realtime.topic` unset; no presence row; nothing for a signed in person with no users row; nothing for `anon`; no insert by `authenticated`; and `realtime.send` as `service_role` storing one private broadcast row with today's partition present, and storing nothing (a `WARNING` only) with it absent. Mutations tried, each failing the suite by name: no topic check, no broadcast check, the row's own topic instead of `realtime.topic()`, the policy granted to `public`, and an extra `INSERT` policy.
- **The spike: `scripts/realtime-spike/run.mjs`**, with its code and tests in `packages/realtime-spike`. Details below.

Two corrections to the SQL suite came out of this. The image's `auth.uid()` read only `request.jwt.claim.sub`, while production's also reads the `sub` inside `request.jwt.claims`; the bootstrap now carries production's definition verbatim. And the bootstrap now runs again whenever the file changes, because it used to run only on an empty container, so every machine with an existing container would have failed to replay the first migration needing the stub.

## Method of the live run

Run from a laptop against the live project. Every remote effect goes through `packages/realtime-spike/src/live.ts`; the order, controls and verdict live in `spike.ts` and are tested against doubles.

1. **Refusal.** Nothing is created without `--i-have-approval` (decision 1, Dan, 2026-10-15). A creating run also refuses a ledger path that already exists.
2. **Ledger first (L515).** The ledger file is written before anything is connected to or created, each entry is written before the thing it names is created and again once its id is known, and every key carries the run's marker `realtime-spike-<UTC timestamp>`. `--cleanup <ledger>` removes what a ledger names, dependants first, and prints what it removed, what was not there and what it could not remove; it refuses any key without the marker. SIGINT and SIGTERM run the cleanup and exit; the normal path cleans up too.
3. **Org A** is the hidden e2e user's organization. **Org B** is a new organization whose slug is derived from its user's email domain, `org-b@<marker>.example.com`, because the signup trigger files a new user under the organization whose slug matches that domain; the user's allowlist row is created first, since the trigger refuses an address not on it. Org B gets no partners, buyer profiles or workflows, and the run checks those three counts are zero before it cleans up (L261), because the buyer sale drain and the sales checks read buyers across every organization.
4. **The day's partition is read before anything connects**, then after the first joins, then every 5 s for up to 3 minutes if absent.
5. **Four joins, both organizations, both topics**: A and B to `partners:<A>` and `partners:<B>`. A on A and B on B must be admitted; B on A and A on B refused (the live two organization negative control, L714). A join refused with `MissingPartition` is made again once the partition exists.
6. **The database sender**: 20 sends of `realtime.send` as `service_role` (the role a Worker write runs as), each in its own transaction with `client_min_messages = warning`, timed from the start of the send to A's receipt, with the partition read at each send and every `WARNING` kept as raised. One more send on `partners:<B>` must reach B and not A.
7. **The fallback, measured the same way**: 20 REST broadcasts to the same private topic, sent with the service key by a Worker running under local `wrangler dev` (workerd, the production Worker's compatibility date and flags). This is also the control that proves the receive side, the policy and `setAuth` if the database sender fails.
8. **A subscriber outside the browser** (decision 2: a Worker): the same local Worker joins `partners:<A>` with A's token and reports the receipt of one message, sent by whichever sender was proved.
9. **The verdict names the failing step**: `partition` (missing at a send, or a join refused for it), `policy` (A refused its own topic as unauthorized), `subscribe` (A's join failed otherwise), `send` (a `WARNING` with the partition present) or `delivery` (clean sends, nothing received). A failure explained by the spike itself is fixed and the spike run again; only a failure that survives every control rules the database sender out.

The result is written beside the ledger as `<ledger>.result.json`.

## Facts measured before the live run

Read only, on production, 2026-10-15:

| Fact | Value |
|---|---|
| Policies on `realtime.messages` | none; row level security on |
| `realtime.messages` partitions | 2026-09-28 to 2026-10-02 only, none for today; 0 rows |
| `realtime.schema_migrations` newest | 20261002120000 |
| `supautils.policy_grants` for `postgres` | includes `realtime.messages` |
| `realtime.send`, `realtime.topic()` | executable by `PUBLIC`; `send` swallows any insert error into `WARNING: WarnSendingBroadcastMessage: <error>` |
| Grants on `realtime.messages` | `anon`, `authenticated`, `service_role`: `INSERT`, `SELECT`, `UPDATE` |
| Hand run SQL edits of the tables PR4 watches | 1 `audit_log` row with `_source: direct_sql` since that trigger shipped on 2026-09-21 (a `partner_config`, 2026-10-02), out of 11 `partner_config` audit rows in that time; none on the buyer profile tables |

A dry run of the whole script against a **local** Supabase stack (CLI 2.117.0, Realtime v2.130.0, GoTrue v2.196.0) with production's definitions of `organizations`, `users`, `user_allowlist`, `handle_new_auth_user` and `user_org_id`, and this migration. It proves the script, the Worker probe and the policy against a real Realtime server; it says nothing about the hosted platform, and its latencies are loopback figures.

| Check | Local result |
|---|---|
| Joins | A on A and B on B admitted; B on A and A on B refused: `Unauthorized: You do not have permissions to read from this Channel topic: partners:<id>` |
| Database sender, 5 samples | all received, p50 4 ms, max 23 ms, no `WARNING` |
| Worker REST sender, 5 samples | all `202`, all received, p50 12 ms |
| Subscriber in workerd | admitted, received 4 ms after the send |
| Org B rows | 0 partners, 0 buyer profiles, 0 workflows |
| Normal path cleanup | users row, auth user, organization and allowlist row removed |
| Deliberate interrupt (`--self-interrupt`, SIGINT once Org B existed) | cleanup ran, all four removed, exit 130, nothing left in any of the four tables, no `wrangler` or `workerd` left running |
| Today's partition dropped | **every private join refused**: `MissingPartition: Realtime was unable to find the expected messages partition`; the send raised `WarnSendingBroadcastMessage: no partition of relation "messages" found for row`; verdict `partition` |

The last row matters for both senders. Realtime authorizes a private join by writing a row into `realtime.messages`, so with no partition for the day **no private channel can be joined at all**, whichever sender is used. Locally the partitions (yesterday to three days ahead) were made when the Realtime service started; production's run from 2026-09-28 to 2026-10-02 fits the same pattern for a tenant started on 2026-09-29 and not running since. Whether the hosted platform makes today's partition when the spike's first join connects is the first thing the live run records.

## Results

**Pending the live run.** To be filled from `<ledger>.result.json` and the run's output:

| | Result |
|---|---|
| Sender chosen | pending |
| Partition before any connection, after the first joins, appeared after | pending |
| Join attempts | pending |
| A on A, B on A, B on B, A on B | pending |
| Database sender: received of 20, p50, p90, max | pending |
| Database sender: failing step and `WARNING` text, if any | pending |
| Worker REST sender: statuses, received of 20, p50, p90, max | pending |
| Subscriber in workerd: status, sender, receipt | pending |
| Org B empty before cleanup | pending |
| Interrupt run: exit code, what was removed | pending |
| Cleanup of the measured run: removed, not there, could not remove | pending |
| Failure controls (only if the database sender is not proved) | pending |

## Decision rule

- **Database sender proved**: PR4 sends the notice from a trigger with `realtime.send`.
- **Ruled out under the controls**: PR4 sends from the Worker after each save. The fallback may be chosen only once all of these are recorded above: the same subscribers received the Worker REST broadcast on the same private topic; the `WARNING` text `realtime.send` raised was captured, not inferred; the partition for the send date was shown to exist at send time (if it did not, the run is repeated once the platform has made it rather than concluded from); and the failing step is named.
- **What the fallback gets wrong (L93)**: it cannot see a hand run SQL edit, so no live notice is sent for one. Measured above: 1 such edit in 24 days. Bidding's pickup of such an edit does not depend on either sender (PR1).
- **Both senders fail**: PR4 escalates to a Durable Object WebSocket, as a new decision for Dan.

## What would reopen the question

- A change to how Realtime authorizes private channels or stores broadcasts (a `realtime.send` that no longer writes `realtime.messages`, or partitions no longer kept by the platform).
- More than a handful of hand run SQL edits a month on the watched tables, if the fallback is chosen.
- A delivery monitor (PR4, decision 2) reporting missed or late notices.

## How to run it

After the migration is applied to production. Run from the repository root of the main checkout (it reads `apps/worker/.dev.vars` and `apps/web/.env.test`), with Node 22.18 or later, after `pnpm install`:

1. Export the temporary database login without printing it: `eval "$(supabase db dump --dry-run --linked 2>/dev/null | grep '^export PG')"`. It lasts five minutes, so start the run straight away; the script connects once, before it creates anything, and keeps that connection. Restore `supabase/.temp/cli-latest` afterwards if the CLI rewrote it.
2. The interrupt run: `node scripts/realtime-spike/run.mjs --i-have-approval --ledger <scratchpad>/2131/realtime-spike-ledger-interrupt.json --self-interrupt`.
3. The measured run (a new login if more than five minutes have passed): `node scripts/realtime-spike/run.mjs --i-have-approval --ledger <scratchpad>/2131/realtime-spike-ledger.json`.
4. If either run was killed in a way no handler could catch: `node scripts/realtime-spike/run.mjs --cleanup <that ledger>`.

## Consequences

- `realtime.messages` carries one policy; any later policy on it (presence, another page) is a new migration and a new case in the SQL suite.
- The SQL suite now models production's realtime schema. A trigger calling `realtime.send` can be tested locally, with the same silent failure production has when the day's partition is missing.
