# The partners page hears about another person's save over a private Supabase broadcast

## Status

**Accepted: the database sender is proved on production** (#2131, PR0 of the partners page redesign #2114). Live run 2026-10-15 at 16:51 UTC against project `xvrmivmpfykwwtriqwpg`, after the migration was applied. PR4 sends the notice from a trigger with `realtime.send`, under the condition the Decision rule states: a day can start with no partition, so the subscriber retries a join refused as `MissingPartition`, and a notice sent before the day's first join can be lost.

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

Two corrections to the SQL suite came out of this. The image's `auth.uid()` read only `request.jwt.claim.sub`, while production's also reads the `sub` inside `request.jwt.claims`; the bootstrap now carries production's definition verbatim. And a container built by a different bootstrap file is now rebuilt from empty by `run.sh`, because the bootstrap used to run only on an empty container, so every machine with an existing container would have failed to replay the first migration needing the stub. It is rebuilt rather than patched because rerunning a bootstrap over a migrated database undoes what migrations did after it: tried first, it put back the `USAGE` on `public` that an ops migration revokes, and the ops suite failed.

## Method of the live run

Run from a laptop against the live project. Every remote effect goes through `packages/realtime-spike/src/live.ts`; the order, controls and verdict live in `spike.ts` and are tested against doubles.

1. **Refusal.** Nothing is created without `--i-have-approval` (decision 1, Dan, 2026-10-15). A creating run also refuses a ledger path that already exists.
2. **Ledger first (L515).** The ledger file is written before anything is connected to or created, each entry is written before the thing it names is created and again once its id is known, and every key carries the run's marker `realtime-spike-<UTC timestamp>`. `--cleanup <ledger>` removes what a ledger names, dependants first, and prints what it removed, what was not there and what it could not remove; it refuses any key without the marker. SIGINT and SIGTERM stop any new remote call, wait up to 15 s for one already in flight to land (so a create cannot land behind the cleanup), run the cleanup and exit; the normal path runs the same cleanup, and a signal arriving during it waits for it rather than cutting it short.
   The one database connection is made before anything is created, verified against Supabase's root CA (bundled as `packages/realtime-spike/certs/supabase-root-2021-ca.crt`, which the production host verified against on 2026-10-15) and its host name, and refused unless its `PG*` settings name the same project as `SUPABASE_URL`.
3. **Org A** is the hidden e2e user's organization. **Org B** is a new organization whose slug is derived from its user's email domain, `org-b@<marker>.example.com`, because the signup trigger files a new user under the organization whose slug matches that domain; the user's allowlist row is created first, since the trigger refuses an address not on it. Org B gets no partners, buyer profiles or workflows, and the run checks those three counts are zero before it cleans up (L261), because the buyer sale drain and the sales checks read buyers across every organization.
4. **The day's partition is read before anything connects**, then after the first joins, then every 5 s for up to 3 minutes if absent.
5. **Four joins, both organizations, both topics**: A and B to `partners:<A>` and `partners:<B>`. A on A and B on B must be admitted; B on A and A on B refused (the live two organization negative control, L714). A join refused with `MissingPartition` is made again once the partition exists.
6. **The database sender**: 20 sends of `realtime.send` as `service_role` (the role a Worker write runs as), each in its own transaction with `client_min_messages = warning`, timed from the start of the send to A's receipt, with the partition read at each send and every `WARNING` kept as raised. A send that throws (a role or statement error) is recorded as the `send` step with its error, and the run goes on to the controls. One more send on `partners:<B>` must reach B, which is recorded, and not A; if B did not receive it, A not receiving it proves nothing and the run says so.
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
| Database sender, 20 samples | 20 received, p50 4 ms, p90 6 ms, max 31 ms, no `WARNING`; B received the send on its own topic and A did not |
| Worker REST sender, 20 samples | all `202`, 20 received, p50 11 ms, p90 18 ms, max 44 ms |
| Subscriber in workerd | admitted, received 4 ms after the send |
| Org B rows | 0 partners, 0 buyer profiles, 0 workflows |
| Normal path cleanup | users row, auth user, organization and allowlist row removed |
| Deliberate interrupt (`--self-interrupt`, SIGINT once Org B existed) | cleanup ran, all four removed, exit 130, nothing left in any of the four tables, no `wrangler` or `workerd` left running |
| Today's partition dropped | **every private join refused**: `MissingPartition: Realtime was unable to find the expected messages partition`; the send raised `WarnSendingBroadcastMessage: no partition of relation "messages" found for row`; verdict `partition` |

The last row matters for both senders. Realtime authorizes a private join by writing a row into `realtime.messages`, so with no partition for the day **no private channel can be joined at all**, whichever sender is used. Locally the partitions (yesterday to three days ahead) were made when the Realtime service started; production's run from 2026-09-28 to 2026-10-02 fits the same pattern for a tenant started on 2026-09-29 and not running since. Whether the hosted platform makes today's partition when the spike's first join connects is the first thing the live run records.

## Results

Measured on production 2026-10-15, 16:51 UTC (measured run, marker `realtime-spike-20261015t165145z`; interrupt run `realtime-spike-20261015t165127z`), 20 samples per sender.

| | Result |
|---|---|
| Sender chosen | **Database** (`realtime.send` from the database), proved |
| Partition before any connection, after the first joins, appeared after | Absent before connecting; present after the first joins (0 ms after they were refused). The newest partition before the run was `messages_2026_10_02`. One run cannot say what made it (the refused join, or something else at that moment), so PR4 must assume a day can start with no partition: its subscriber retries a join refused as `MissingPartition`, as this script did, and a notice sent before the day's first join may be lost with only a `WARNING` |
| Join attempts | 2: the first joins were refused for the missing partition, the second succeeded |
| A on A, B on A, B on B, A on B | SUBSCRIBED; refused ("You do not have permissions to read from this Channel topic"); SUBSCRIBED; refused. The organization boundary held both ways |
| Database sender: received of 20, p50, p90, max | 20 of 20, 0 lost; p50 90 ms, p90 105 ms, max 114 ms (min 87 ms). The partition existed at every send |
| Database sender: failing step and `WARNING` text, if any | None; no warning, no send error |
| Worker REST sender: statuses, received of 20, p50, p90, max | HTTP 202 on all 20; 20 of 20 received, 0 lost; p50 160 ms, p90 212 ms, max 402 ms |
| Subscriber in workerd: status, sender, receipt | SUBSCRIBED; database sender; received after 106 ms |
| Org B empty before cleanup | Yes: 0 partner configs, 0 buyer profiles, 0 workflows, and no cross topic leak either way |
| Interrupt run: exit code, what was removed | Exit 130; removed the users row, the auth user, the organization and the allowlist row |
| Cleanup of the measured run: removed, not there, could not remove | Removed all four (users row, auth user, organization, allowlist row); nothing not there, nothing failed. A read of production afterwards found no row carrying the marker |
| Failure controls (only if the database sender is not proved) | Not needed |

## Decision rule

- **Database sender proved**: PR4 sends the notice from a trigger with `realtime.send`, on the condition the Results record: a day can start with no `realtime.messages` partition, so the subscriber retries a join refused as `MissingPartition`, and a notice sent before the day's first join can be lost with only a `WARNING` (nobody is subscribed then).
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

## The sender as built (PR4, #2135)

Migration `20261016170000_partner_page_notice_2135.sql`:

- `notify_partner_page(org, partner, kind, changed_columns, direct, save_id, client_id)` sends one private broadcast, event `partner_changed`, on `partners:<org>`, carrying ids, the two versions as they stand, column names and whether the change had no actor, never a field value. Any failure becomes a `WARNING`, so a notice never fails the write it describes. No grant to anyone, service role included.
- Three AFTER STATEMENT triggers on each table `partner_page_notice_tables()` names (`partner_configs`, `buyer_profiles` and its three child tables, `partner_uuid_map`), sending once per partner per statement when a version moved, a partner or profile came or went, or a sub-account ID mapping changed. A `last_probe_response` only change moves no version and sends nothing. A partner delete sends one `deleted`; the profile rows its cascade removes are skipped as rows of a partner that no longer exists (a cascade runs at trigger depth 1, so depth cannot tell it from a hand write).
- `save_partner_page` gains `p_client_id` (an overload; the ten argument form calls it with NULL) and sends the page save's one notice at its end, when either version moved; its own statements run under `bidspoke.audit_handled = 'save_partner_page'`, which keeps the triggers quiet.
- `change_partner_uuid` makes the sub-account ID add and remove with `bidspoke.actor_*` set, so a `partner_uuid_map` notice is `direct` only for a hand run SQL write.
- The notice's shape, its kinds and its parser live once, in `packages/partner-page-live`, read by the Worker's monitor and by the page.

`supabase/tests/partner_page_notice.test.sql` proves each table's triggers by `pg_trigger`, every other table keyed to a partner against a written exclusion list (by foreign key, by column name, and by the columns a production sample found holding a partner id or slug), and who sends what, with the mutations it was seen to fail on in its header.

## Delivery monitor (PR4, #2135, decision 2)

A Worker check on the existing five minute cron (`lib/partner-page-monitor.ts`, heartbeat `partner-page-monitor`): it signs in as the one user of the one organization marked `is_synthetic`, joins `partners:<that organization>` (retrying a join refused as `MissingPartition` or during an idle shutdown), calls `monitor_partner_page_ping`, which sends through `notify_partner_page` without writing a setting, and waits up to 10 seconds from that first ping for its own notice, sending the same ping again every 2.5 seconds until it arrives (see the cold start below). A round whose notice never arrives is tried once more on a fresh join with a new save id before the run counts as a miss (see the idle shutdown below).

- **Pages** (signal `partner-page-live`): the notice did not arrive in either round, or the join was refused on every attempt, on two measured runs in a row (`CONSECUTIVE_MISSES_TO_PAGE`, #2579; Dan, 2026-10-21: two misses in a row, at any hour). A not received and a refused join both count as a miss. One miss followed by a receipt is recorded in `job_runs` and pages nothing; a run that could not measure, or sent while today's partition was absent, neither counts nor breaks the streak. The streak lives in the check's KV state; when that state cannot be read, or this miss cannot be saved for the next run to see, the run pages on the one miss and the alert says why, because waiting for a second miss it cannot see would swallow an outage. The incident starts at the first miss of the pair. Inside a standing incident a lone miss pages nothing but holds the all-clear back 30 minutes from it. The alert says how many runs missed out of how many since the first miss of the pair, from a window kept in the same state until the all-clear, or until 25 hours after its last miss; it is kept apart from the alert's records, so a muted alert does not reset it. A lone miss that opened no incident is dropped from the window by the next receipt, so it never stretches a later alert's "since". The check unable to run (no secret, no monitor organization, sign in or the ping failing) for 30 minutes on the clock, as its own message. Both stand down with an all-clear.
- **Records, never pages:** each run's outcome, latency and whether today's and tomorrow's `realtime.messages` partitions exist, in `job_runs` (job `partner-page-monitor`), and the live misses pages post to `POST /api/partners/live-miss`, in `partner_page_live_misses`. A send made while today's partition was absent is `partition_missing_at_send`, never a failure. No miss threshold ships; the issue that sets one from a measured week is filed with #2135.
- `monitor_partner_page_ping` refuses any organization that is not `is_synthetic`, and a monitor organization holding anything but one source partner (no buyer profile, workflow, service connection or environment variable), by name. That refusal is what keeps the monitor organization out of every job that lists workflows, Slack connections or credentials across organizations; the two jobs that list buyer profiles across organizations (the buyer sale drain and the buyer sales checks) filter `organizations.is_synthetic = false` themselves.

**A cold Realtime can lose the first notice (#2135, measured 2026-10-16).** Realtime can answer a private join `SUBSCRIBED` before it is streaming database broadcasts. After an idle shutdown (this project's Realtime tenant was shut down at 17:01:50 UTC on 2026-10-15), the join that wakes it starts the tenant, and the reader that streams `realtime.messages` is created only afterwards: on the 01:45 UTC run the tenant logged `is initializing` at 01:45:09.165, the monitor's ping row was stored at 01:45:09.580, and `Create replication slot ...` followed at 01:45:10.239, so that notice was never streamed and the run recorded `not_received` and paged. The 01:50 run, with the same code, received in 211 ms. So a notice sent within about a second of the join that wakes Realtime can be lost. The spike never sent straight after such a join, so it did not see this. A page is unaffected in practice (its notices come from other people's saves, long after its join), but the monitor sends straight after joining, so it re-pings with the same save id every `PING_RETRY_MS` (2.5 s) within its 10 second deadline, times latency from the first send, keeps the first ping's partition figures, and records how many pings it took as `pings` in `job_runs.summary`. A run with `pings` above 1 is a startup race the re-ping absorbed; a count of them stays readable. To check a future `not_received`, look in the Realtime logs around the run's `started_at` for the tenant starting:

```sql
-- Supabase logs (query_logs), a window of a few minutes around the run
select timestamp, event_message from logs
where source = 'realtime_logs' and (event_message like '%is initializing%' or event_message like '%replication slot%')
order by timestamp
```

A `Tenant <ref> is initializing` line at the run's minute, with `Create replication slot` after the run's ping, means the channel was starting. A `not_received` whose later pings were sent after the replication slot was created is not explained by a cold start, whatever else the logs show.

**Realtime shuts an idle tenant down, and a run can land on it (#2263, measured 2026-10-16).** Realtime closes this project's database connection ten minutes after it starts when nobody stays connected (`Tenant has no connected users, database connection will be terminated`). With no page open, the monitor's few seconds every five minutes keep waking it, so the shutdowns drift around the five minute grid and a run lands on one now and then. Two things follow, and the monitor absorbs both:

- A join whose authorization query loses its connection to the shutdown is refused, and Realtime words it as a pool shortage: at 04:45:14 UTC the shutdown at .453 was followed by `{:shutdown, {DBConnection.Holder, :checkout, ... realtime_authorize}}` at .744 and `IncreaseConnectionPool: Please increase your connection pool size` at .817. It is not a pool size setting. The monitor retries that refusal like `MissingPartition` (`isIdleShutdownRefusal` in `packages/partner-page-live`), and the alert says what the wording means when every retry was refused. The page already rejoins after any refusal.
- A run joined a second before the shutdown streams nothing: at 20:35:35 UTC the run joined, the tenant shut down at 20:35:36.431, and none of its pings arrived; the next run, on a fresh connection, received. So a round with no notice is tried once more on a fresh join (`MEASURE_ROUNDS`, 2), and `rounds` in `job_runs.summary` says how many ran. A `received` with `rounds` 2 is a shutdown the second round absorbed.

**A wake up can outlast both rounds, once (#2579, measured 2026-10-21).** The 08:00:38 UTC run recorded `not_received` with `rounds` 2, `pings` 3 and `join_attempts` 1. Realtime logged the tenant initializing at 08:00:39.614, but its replication connection started only at 08:01:23.950 and the slot was created at 08:01:24.225, 44 seconds after the wake, where the woken runs #2263 measured had the slot about 0.6 seconds after the first ping and both rounds give it about 20 to 25 seconds. The 08:05 run received. It was the only miss in 1,361 runs since 2026-10-16 21:00 UTC, and it paged at 4:01 AM ET. Lengthening the receipt deadline only moves that edge and keeps each run connected longer, so the alert instead pages on two misses in a row (above), and a single miss stays countable in `job_runs`.

Pass and fail counts, on production:

```sql
SELECT outcome, count(*), percentile_disc(0.5) WITHIN GROUP (ORDER BY (summary ->> 'latency_ms')::int) AS p50_ms
FROM job_runs WHERE job = 'partner-page-monitor' AND started_at > now() - interval '7 days' GROUP BY 1;
```

### Setting it up (once, after the migration is applied)

1. Generate the monitor's password and keep it in the `Bidspoke recovery keys` 1Password item: `openssl rand -base64 32`.
2. Create the organization and allow the address, through `/db-apply`. The signup trigger files a new user under the organization whose slug is the email domain with every character outside `a-z0-9` turned into `-`, so the slug below is the one `monitor@partner-page-monitor.trypennie.dev` lands in:
   ```sql
   INSERT INTO public.organizations (name, slug, is_synthetic) VALUES ('Partners page delivery monitor', 'partner-page-monitor-trypennie-dev', true);
   INSERT INTO public.user_allowlist (email, added_by) VALUES ('monitor@partner-page-monitor.trypennie.dev', 'partners page delivery monitor (#2135)');
   ```
3. Create the user in Supabase, Authentication, Users, Add user, Create new user: that address, the password, Auto Confirm User on. Confirm its `public.users` row has the monitor organization's id.
4. Give the organization its one source partner, inactive so nothing ever uses it:
   ```sql
   INSERT INTO public.partner_configs (organization_id, name, slug, partner_type, is_active)
   SELECT id, 'Delivery monitor source', 'partner-page-monitor-source', 'source', false FROM public.organizations WHERE slug = 'partner-page-monitor-trypennie-dev';
   ```
5. Set the Worker secret from `apps/worker`, pasting the password at the prompt: `npx wrangler secret put PARTNER_PAGE_MONITOR_PASSWORD --name bidspoke-worker`.
6. Within ten minutes `job_runs` shows `partner-page-monitor` runs with outcome `received`.

Until steps 1 to 5 are done the check records `unmeasured` with the step it stopped at, and pages that it cannot run after 30 minutes.

## The page as built (PR4 page half, #2135)

- `apps/web/src/lib/partner-live-channel.ts` keeps the join and the header's three states (Live; paused with the seconds since it dropped; failed with Retry after `FAIL_AFTER_MS`, two minutes, not live). A join refused as `MissingPartition` is retried after a second and counted; any other refusal or drop rejoins with backoff. `partner-live-join.ts` joins as the signed in person, setting the session's JWT before each join and again on every token refresh.
- `PartnerForm.tsx` acts on a notice of the open partner: its own save is known by this tab's `client_id` (one UUID per tab, sent on every page save) plus a `save_id` it sent, never by who saved; anything else is read again through `GET /api/partners/:id` and merged with `mergeThreeWay`. A field only they changed updates in place with "Updated by <Name>" on its section; a field both changed waits, the save bar says how many, and Save asks in the merge dialog. It reads again on rejoining and when the tab comes back to the front.
- Realtime can answer a join `SUBSCRIBED` a moment before it streams after an idle shutdown (measured 2026-10-16), and a socket can drop while the header still says Live, so the page has a backstop: while the draft is dirty it reads `GET /api/partners/:id/versions` every 60 seconds (`PROBE_EVERY_MS`). A version past the one held, found while the header said Live, sets the header to paused while it rejoins, merges the save, and posts `/api/partners/live-miss` (`direct_sql` when the change had no actor). The same read, on open and after every refetch, shows "Changed directly in the database at ..." on the section a hand edit touched, until the half's `BIDDING_PICKUP` bound has passed.
- The accessibility job answers the page's socket in the browser (`realtimeReplies`, `apps/web/e2e/partner-live-fixtures.ts`), so the scan never joins production's Realtime.

## Consequences

- `realtime.messages` carries one policy; any later policy on it (presence, another page) is a new migration and a new case in the SQL suite.
- The SQL suite now models production's realtime schema. A trigger calling `realtime.send` can be tested locally, with the same silent failure production has when the day's partition is missing.
