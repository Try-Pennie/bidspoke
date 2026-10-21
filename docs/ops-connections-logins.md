# Ops connection logins and the admin hand off (#2335)

How the ops Worker turns a sealed connection login into the credential a request
carries, what each login must contain, how a failing login is recorded, and what
an admin must set up outside the repo before a Salesforce or Google connection can
work. Phase 5 of #1689; plan: discussion #2329, part 2; Dan's decisions of
2026-10-17 (discussioncomment 19000411).

Nothing here is called in production yet. The minters are the `authorize` of each
catalogue service's runtime entry, which arrives with that service (Phase 7), and
connectionFetch, which calls them, is called by the OpsConnections entrypoint
(PR 8 of this phase, below), which nothing binds until PR 9, and later by the ops
executor (Phase 9). The services registered on ops are listed in
`apps/worker/src/ops/connections/services.ts`: Snowflake since the first service
pull request of Phase 7 (#2337, `snowflake-service.ts`), and Salesforce
(`salesforce-service.ts`, #2337) ahead of its catalogue actions. An OpsConnections
call that reaches any other service is refused `connection_service_unknown` until
that service's own Phase 7 pull request registers it.

**Salesforce is registered, and the pool is approved for the trypennie org only.**
Every ops Salesforce request takes a lease from `acquire_sf_lease` before its login
is opened into a token. Dan approved the trypennie numbers on 2026-10-19 (Decision
11, recorded on #2336), and ops migration 20261020010000 writes them, the only rows
these tables hold:

| Table | Row | Approved |
|---|---|---|
| `sf_pool_caps` | org `00DDp00000170r6MAA` (trypennie) | `cap` 3 at once, `workflow_share` 2 (so one lane always stays free for checks, the limits reading and lookups), `budget_floor` 250,000 remaining daily calls |
| `sf_bootstrap_caps` | host `trypennie.my.salesforce.com` | `cap` 1 |
| `sf_purpose_caps` | that org | share 1 each for `lookup`, `verify`, `connection_check`, `sf_limits` |

Partner orgs (tpl2, achieve) have no rows: each is approved by a migration of its
own when the first workflow using that org is ported, with no exemption from the
pool (the steps are under "Approving a cap for a new Salesforce org" below). An approval is changed only by a new migration; re-running 20261020010000
over a row holding other values refuses by name and overwrites nothing.
service_role can only read the three tables. A call without an approved row is
still refused by name and nothing is asked of Salesforce, not even a token:

| Call | State | Refused |
|---|---|---|
| `verify` | money's identity unmeasured, or older than 50 hours | `money_identity_unmeasured`, before any lease |
| `verify` | the connection not yet measured, no approved `sf_bootstrap_caps` row for its declared instance host | `sf_cap_unset` |
| `lookup` (and every other purpose) | the connection not yet measured | `sf_org_unmeasured` |
| any | measured, no approved `sf_pool_caps` row for the org | `sf_cap_unset` |
| any but `sf_limits` | measured and approved, no `sf_budget_readings` row for the org, or one older than 15 minutes | `sf_budget_unmeasured` |
| any but `sf_limits` | the org's latest reading is below its approved `budget_floor` | `sf_budget_floor` |

Once a host's bootstrap row is approved, verify asks the declared instance's token
endpoint and `/services/oauth2/userinfo`, refuses money's run as user, and records
the measured org and username under the generation, which is the row the org's
pool is keyed on from then on.

## The budget reading (#2336)

Every Salesforce REST response carries the org's daily API usage in its
`Sforce-Limit-Info` header (`api-usage=<used>/<max>`, fields separated by
semicolons, as in Salesforce's own example `api-usage=10018/100000;
api-bursts=1/750`; REST API Developer Guide, "Limit Info Header"). connectionFetch
reads it from every response a Salesforce call gets, whatever its status, and
hands the latest one to `recordSfBudget`, which writes it through
`record_sf_budget_reading` as source `sforce_limit_info` with remaining = max minus
used. The parser and the recorder are `apps/worker/src/ops/connections/sf-budget-reading.ts`.

- **Which org.** The org the connection generation MEASURED as
  (`connection_measured_identity`, read once per connection generation per
  isolate), the same key the call's lease was drawn from. Only a committed copy
  whose lease came from the org pool is read for: a bootstrap verify has no
  measured org yet, and a candidate is not the committed generation.
- **How often.** At most once per Salesforce org a minute per isolate
  (`SF_BUDGET_READING_MIN_INTERVAL_MS`). A reading is fresh for 15 minutes, so a
  minute old one serves the pool as well as a new one, while a write per response
  would add an ops database round trip and a subrequest to every Salesforce call,
  out of the 10,000 per invocation a dispatched run shares with its own work
  (docs/ops-ceilings-spike.md, P3). A failed write gives its minute back, so the
  next response tries again.
- **Never in the way.** The write runs beside the lease release, so it adds no
  wait unless it is the slower of the two, and then at most
  `SF_BUDGET_READING_DEADLINE_MS` (1 s). A write that fails or passes the bound is
  reported as `sf_budget_reading_unrecorded` (cause `write_failed` or
  `deadline`), and a header present but unreadable as `sf_limit_info_unreadable`
  with the parser's reason (`no_api_usage`, `malformed`, `not_finite`,
  `out_of_range`, `max_not_positive`). Neither carries a value, and neither
  changes the call's answer.
- **Used above max is a reading.** Salesforce lets an org run past its allocation
  for a while; that is written as remaining below zero, which the table allows,
  so the pool refuses at once as `sf_budget_floor`.
- **measured_at is the database's clock**, as `record_sf_budget_reading` has
  always stamped it, because `acquire_sf_lease` judges the 15 minutes on the
  database's own `now()`. The Worker's clock decides only the minute between
  writes.
- **It cannot start the pool on its own.** Every call but `sf_limits` is refused
  `sf_budget_unmeasured` until a reading exists, and a refused call gets no
  response to read. The first reading, and one after any quiet spell of more than
  15 minutes, comes from the `sf_limits` sweep (below), which is exempt from the
  budget and writes source `limits`. From then on the calls themselves keep the
  reading fresh while they flow, and the sweep is the floor under it when they
  do not; whichever reading is later stands.

## The sf_limits sweep (#2336)

One of the ops minute tick's claimed sweeps (`apps/worker/src/ops/sf-limits.ts`,
wired in `tick.ts` `TICK_SWEEPS`), which runs beside the rest of the tick and is
awaited before its report.

- **Which orgs.** `sf_limits_targets` (ops migration 20261019230000): one row per
  Salesforce org a connection's verify MEASURED as, never a declared target, each
  naming one connection whose copy can serve now (service `salesforce`, the
  measured generation, not withdrawn, not expired, no tombstone), a healthy one
  before one in `needs_reauth`. At most 10 a sweep. With no measured org, which
  is today until the first ops Salesforce connection is verified, the sweep
  claims, finds nothing and reports nothing.
- **The read.** `GET <instance_url>/services/data/v60.0/limits` through
  connectionFetch, purpose `sf_limits`, the committed copy only, recording
  nothing (a GET by the tick, no step). Salesforce documents the body as one
  object per limit, each `{ "Max": n, "Remaining": n }` (REST API Developer
  Guide v68.0, "Limits"; available to a user with View Setup and Configuration,
  so one without it is a 403). Only `DailyApiRequests` is read; a missing,
  non numeric, fractional, out of range or inconsistent value is refused by name
  (`no_daily_api_requests`, `not_whole`, `out_of_range`, `max_not_positive`,
  `remaining_above_max`, and `not_json` or `too_large` for the body), never
  written. Remaining below zero is written. Each read costs one API call.
- **How often.** Claimed every 240 s, so every 4 to 5 minutes. A floor refusal
  answers retry_at = the reading's measured_at plus 5 minutes, so the reading is
  renewed by then; a reading goes stale at 15 minutes, so three renewals in a row
  must fail first. Salesforce says the figures are accurate within five minutes
  and asks not to be polled rapidly, so faster gains nothing.
- **Failures** page through the tick's report: a refusal the next read meets
  again (a 4xx, a refusal by rule or state such as `sf_cap_unset` or
  `connection_needs_reauth`, an unreadable body) at once. A passing one (a
  timeout, a busy pool, a 5xx, a rate limit, a write the ops database missed)
  pages at once once the org's reading is 7 minutes old or more
  (`sf_limits_read_failed`), which only a second failure in a row leaves it
  when nothing else renews the reading. While the reading is younger it is
  `sf_limits_read_failing` (#2340), which pages on the third run of the sweep
  in a row whatever the reading's age: other ops Salesforce calls renew the
  reading through `Sforce-Limit-Info` (#2507), so a read that fails every time
  would otherwise never page. Three failed runs leave the last good read at
  least 12 minutes old, inside the 15 a reading is fresh for, and a fourth
  would put it at 16, past the moment the pool would already be refused had no
  other call kept the reading fresh, so three is the most that still pages
  first. Two would page on a passing Salesforce blip while the pool is
  measured and nothing is refused. The count lives on the bidding Worker, in
  the same record as the tick's three ticks in a row, and counts runs of the
  sweep, not ticks: a tick that did not run the sweep carries every sf_limits
  problem as it stood, so the page stands between runs and its all clear goes
  out once a run no longer reports it. docs/reference/observability.md has the
  kinds and how the count is kept.
- **Its heartbeat** is `ops-sf-limits` in the bidding Worker's `CRON_JOBS`,
  stamped through `OpsGateway.opsJobStarted` and `opsJobCompleted` (#2340), which
  accept only the ids in `OPS_GATEWAY_JOBS` and are reached only by the ops
  Worker's `OPS_GATEWAY` binding.

## The connection_check sweep and the login page (#2340)

Another of the tick's claimed sweeps (`apps/worker/src/ops/connection-check.ts`),
run beside the rest of the tick and awaited before its report.

- **Which connections.** `connection_check_targets` (ops migration
  20261020030000, additive): every copy not withdrawn and not covered by a
  tombstone, across organizations, in three bands (each login state that may
  page, `needs_reauth` or `refresh_failing`, first; then the other servable
  copies; then the expired ones), least recently checked first within each, with its
  derived status (connection_status's own rule), its refresh streak, the
  identity verify measured for its generation, and the database clock. The
  sweep and the tick's login states read this one list, up to 500. A copy past
  its serve window, and one in `needs_reauth`, are not probed, and at most 50 of
  the rest are probed a sweep. With no ops connection, which is today, the sweep claims, finds
  nothing and reports nothing.
- **The probe.** The service's identity probe, the one verify uses
  (Salesforce `/services/oauth2/userinfo`, which must still be the org and user
  verify measured; Snowflake `CURRENT_USER()` and the account, which must be the
  declared ones), through connectionFetch, purpose `connection_check`, the
  committed copy only, recording nothing. A Salesforce probe takes a lease under
  the `connection_check` share of 1 (Decision 11), so the connections of one org
  are probed one after another. Each check, its record included, has its own
  30 second deadline, and no check starts once 10 seconds have passed since the
  sweep began (before its stamp and its read), so a whole sweep takes at most 55
  seconds; a connection not reached is counted as deferred, held or paged as a
  check that could not be made (cause `sweep_budget`), and goes first next sweep.
- **What it writes.** `record_connection_check` only, so the `last_check_*`
  columns: a passing check, or a failed one with a cause that is a name (a
  refusal code, `http_<status>`, `identity_changed`, `identity_mismatch`), never
  a message. A busy pool, a budget floor, a rate limit or a copy that could not
  be read is not a failed check and writes nothing.
- **How often.** Claimed every 14 minutes, so every 14 or 15 (16 with a missed
  tick): inside the hourly or slower schedules ops workflows run on, and, since
  a probe is a sign in whenever no token is held, often enough that a token
  endpoint outage nothing else meets reaches Dan's decision 2 bound within about
  an hour rather than standing below it unpaged.
- **Failures** page through the tick's report: a refusal the next probe meets
  again at once, a failure it may not meet only once the connection's last
  passing check is older than 20 minutes (the second in a row). A refused login
  or a failing token endpoint is recorded and paged by the login page below
  instead. `docs/reference/observability.md` has the kinds.
- **Its heartbeat** is `ops-connection-check` in the bidding Worker's
  `CRON_JOBS`, stamped through `OpsGateway.opsJobStarted` and `opsJobCompleted`.
- **The login page.** Every tick reads the same list and reports each
  connection in `needs_reauth`, and each in `refresh_failing` with 5 failures
  the first at least 15 minutes old (the bound `record_connection_refresh`
  escalates by). The bidding Worker pages each to the connection's
  organization through the `ops-connection-login` signal, naming it by its name
  and service, and sends the all clear once a complete list no longer names it.

## OpsConnections (`apps/worker/src/ops/ops-connections-entrypoint.ts`)

The ops Worker's named entrypoint for the bidding Worker's `OPS_CONNECTIONS`
binding (PR 9), and nothing else: the public edge reaches only the default export.
Each request names one organization (from the caller's JWT, on bidding) and is
parsed by `apps/worker/src/lib/ops-connections-contract.ts`; every answer is a
value, a refusal naming its cause. Each method has a ceiling
(`OPS_CONNECTIONS_CEILINGS_MS`) past which its work is stopped and it answers
`ops_connections_timeout`; the bidding Worker's own deadline must be longer.

| Method | Does | Writes |
|---|---|---|
| `verify` | Measures what the credential authenticates as through connectionFetch (Salesforce: `/services/oauth2/userinfo`; Snowflake: `CURRENT_USER()` and the account, which must be the declared ones or it is refused `verify_identity_mismatch`, and which records nothing, `snowflake-service.ts` says why); refuses money's run as user (`money_identity_match`), a sealed client id other than the declared one (`verify_client_id_mismatch`), a person bound candidate (`candidate_not_refreshable`: it is proven by its code exchange), and a service with no measurement yet (`verify_identity_unmeasurable`). | Salesforce: the measured identity, under the generation the request carried. Snowflake: nothing |
| `clearReauth` | Reconnect: `verify` of the candidate, then the clearing. Bidding calls it after its compare and set committed the candidate's generation. | `reauth_cleared_at` |
| `revoke` | A removal. | the ops tombstone |
| `health` | Each connection's status (`connection_status`). | nothing |
| `lookup` | One level of a connection's schema, behind 60 lookups a minute per organization (`take_lookup_allowance`). | the allowance |
| `exchangeOAuthCode` | A person bound login's consent, to its ConnectionTokenObject. | the object's storage |

- **No copy is written by any of these (F116, F126).** verify and clearReauth use
  the candidate (the bidding row's sealed envelope at its new generation) for
  their one call; the committed copy arrives only by the minute serve of the
  committed row. A failed verify or a lost compare and set leaves ops on the
  committed generation, and the next serve of it is accepted.
- **Money's Salesforce identity** is read from `OPS_GATEWAY.moneyIdentities`,
  measured daily on bidding. A reading more than 50 hours old (one missed daily
  run plus two hours) is treated as unmeasured, and with no reading verify
  refuses every Salesforce connection (`money_identity_unmeasured`) before any
  Salesforce call.
- A candidate's measured identity is replaced by the next candidate's at the same
  generation (ops migration 20261019010000); a generation ops holds is never
  overwritten (`identity_changed`).
- **Salesforce lease purposes** (`SF_LEASE_PURPOSES` in `run-vocabulary.ts`, and
  the CHECKs on `sf_leases` and `sf_purpose_caps`): `step`, `lookup`, `verify`,
  `connection_check` and `sf_limits`. Each but `step` needs a share of its own in
  `sf_purpose_caps` that Dan approves. Reconnect has no purpose of its own:
  clearReauth's call is a `verify`, because only verify takes the bootstrap slot
  a new generation needs, so the `reconnect` purpose was retired as having no
  caller (#2336, ops migration 20261019200000, which refuses to run while any row
  holds it).

## The minters (`apps/worker/src/ops/connections/minters/`)

| Minter | Services | Login (sealed JSON) | Target (declared, public) | Expiry signal |
|---|---|---|---|---|
| `staticKeyAuth` | Slack ops bot (decision 6), OpenAI, Anthropic, Supabase, HTTP | `{ "api_key" }`, or `bot_token` for Slack, `service_key` for Supabase | the service's hosts | 401 |
| `snowflakeKeyPairAuth` | Snowflake | `{ "private_key": "<PEM>" }` | `{ account, user }`, and optionally `warehouse`, `role`, `database`, `schema` for the session (a lookup needs `database`) | 401 |
| `salesforceClientCredentialsAuth` | Salesforce | `{ client_id, client_secret }` of the org's ops connected app | `{ instance_url, client_id }` | 401 (INVALID_SESSION_ID), the money path's own rule |
| `googleDelegationAuth` | Google (Sheets, Gmail, Calendar, Drive) | the service account key JSON Google issues | `{ subject: "<mailbox>", drives?: ["<shared drive id>"] }` | 401 |

- Tokens are held per isolate in a `TokenMemo` keyed by connection, generation,
  mailbox and scope, so two mailboxes never share a token and a reconnect never
  meets the old credential's token. A credential bidding has not committed yet
  (verify, Reconnect) mints for its one call and never touches the memo.
- On the expiry signal connectionFetch renews once and retries once. The renewal
  evicts the memo entry only if it still holds the rejected token (compared by
  identity), so concurrent rejections cause one mint. A second refusal is
  `needs_reauth`.
- A minter holds no fetch of its own. It asks its token endpoint with the fetch
  connectionFetch hands it (`AuthorizeInput.fetch`, #2337), which sends only to
  an https URL on one of the connection's declared hosts, on port 443 with no
  credentials in the URL, and never follows a redirect; anything else is refused
  before it is sent (`connection_not_allowed`, `token_host_not_declared`). So the
  platform's fetch is reached only through connectionFetch, the token request
  included.
- Salesforce asks only the declared instance's `/services/oauth2/token`, and only
  an https `*.salesforce.com` host. A login whose client id is not the declared
  one is refused before anything is sent. The money path's `getSalesforceToken`
  and its KV cache are not used.
- Google asks only `https://oauth2.googleapis.com/token`; a key naming any other
  `token_uri` is refused, so the signed assertion goes nowhere else. A Google
  service's entry must therefore declare `oauth2.googleapis.com` beside the API
  host it calls.
- Every failure is a `LoginMintError` whose message is its kind and reason alone
  (F120), and connectionFetch forwards none of it.

## A failing login (Dan's decision 2)

| What happened | Recorded | The caller gets |
|---|---|---|
| The provider refused the login (`invalid_grant`, `invalid_client`, `unauthorized_client`, ...), or the stored login is malformed | `needs_reauth` at once, cause `login_refused: <reason>` | `connection_needs_reauth` |
| The token endpoint timed out, could not be reached, answered 5xx or an edge page | one more failure in the connection's refresh streak (`record_connection_refresh`); status `refresh_failing` | `connection_auth_unavailable` |
| The streak reaches 5 failures AND began 15 minutes ago | `needs_reauth`, cause `refresh_failing_exhausted: <reason>`, written by the database through `record_connection_needs_reauth` | `connection_needs_reauth` |
| The token endpoint answered 429 | nothing | a `RequeueAt` at its Retry-After |
| A token endpoint answered a token | the streak ends | the response |
| A rule of ours refused the mint (below) | nothing | `connection_not_allowed`, naming the rule |

Both bounds, because either alone is wrong: a count alone sends a connection to
`needs_reauth` on a 30 second outage that a burst of parallel steps meets five
times, and a span alone lets one slow failure an hour later do it. They live once,
in `record_connection_refresh` (supabase-ops migration 20261018170000). A
Reconnect starts a new streak. Nothing is recorded for a credential that is only
being verified.

## Google: delegation scopes and the mailbox allowlist (F129, decision 11)

Domain wide delegation lets the ops service account act as any mailbox in the
Workspace for the scopes the admin grants, and decision 11 grants broad ones once.
So two things hold the account in:

1. **Scopes.** The admin grants decision 11's four:
   `https://www.googleapis.com/auth/gmail.modify`,
   `https://www.googleapis.com/auth/calendar`,
   `https://www.googleapis.com/auth/drive`,
   `https://www.googleapis.com/auth/spreadsheets`
   (`GOOGLE_DELEGATION_GRANTED_SCOPES` in `packages/service-catalogue`). The
   minter asks Google only for the union of what the catalogue's Google actions
   declare (`googleDelegationScopes(CATALOGUE)`), and a catalogue check refuses an
   action declaring a scope outside the grant. While no Google action ships, the
   list is empty and every Google mint is refused (`no_delegation_scopes`).
2. **The allowlist.** `google_delegation_subjects` on the ops database names, per
   organization, each mailbox a Google connection may act as and each shared drive
   it may name. The minter checks it on every request, before a token is minted or
   reused, so an entry taken off the list stops at once. A mailbox or drive outside
   it is refused by name (`mailbox_not_allowed`, `drive_not_allowed`); a list that
   cannot be read refuses the call (`connection_auth_check_unavailable`). Verify
   checks it again at save (PR 8). Entries are added by signed-in users of the
   organization through the Connections page (#2338, Dan's decision on #2411,
   2026-10-18), every change audited with who made it and when; each row records
   who added it and when (`added_by`, `added_at`), and a shared drive may carry
   its name (`display_name`), which the page shows in place of its id.

   The write path (#2338, ops migration `20261020190000`). The ops database's
   `add_google_delegation_subject` and `remove_google_delegation_subject` are its
   only writers (the ops Worker's `service_role` still only reads the table), and
   each writes its change record in `ops_audit_log` (the person's id and email,
   the time, the old and new values) in the same transaction, so a change whose
   record fails is rolled back. A mailbox is trimmed and stored lower case; a
   malformed address or drive id is refused by name, and nothing is written. A
   mailbox or drive is on one organization's list at most, since every
   organization's connections act through the one service account. A remove of
   an entry the organization does not hold answers `not_listed`, never a silent
   success. `list_google_delegation_subjects` reads the list. The ops Worker's
   `OpsConnections` entrypoint answers them as `addDelegationSubject`,
   `removeDelegationSubject` and `listDelegationSubjects`
   (`src/ops/connections/delegation-list.ts`), each taking the organization and
   the signed in person from the bidding Worker. The create route (build plan PR
   5) reads the list through `callOpsConnections` in
   `lib/ops-connections-client.ts` and refuses, before verify is asked, a Google
   delegation connection naming a mailbox or drive not on it
   (`google_subject_not_listed`), or any when the list cannot be read
   (`google_list_unavailable`). Any signed in user of the organization reads,
   adds and removes entries through `GET`, `POST` and `DELETE`
   `/api/connections/google/subjects` (build plan PR 6), which pass that person
   to ops as the actor its change record names; the three are among the methods
   the deployed ops check requires since then. Until someone adds an entry,
   every Google mint is refused. An entry a saved connection acts as (its
   target names the mailbox, or the drive among its drives) cannot be removed
   until that connection is (`delegation_subject_in_use`, Dan's decision of
   2026-10-20).

## Admin hand off

Each step is a person's, outside the repo, and goes on the manual steps card
before the first connection of that kind is saved.

### Salesforce, per org (trypennie first, then pennie)

1. Create a **dedicated integration user** (a free Salesforce Integration User
   licence where the org has one, decision 5). It is the connected app's run as
   user and nothing else: no person signs in as it.
2. Create the permission set **`Bidspoke Ops Integration`** (API name
   `Bidspoke_Ops_Integration`), with the permission set licence "Salesforce API
   Integration" where the Integration User licence is used, and assign it to that
   user and to no one else. It grants:
   - system permission **API Enabled**, and nothing else at the system level: not
     Modify All Data, View All Data, View Setup and Configuration, Manage Users,
     Customize Application or Author Apex;
   - object and field access **only** as each ported action needs it, named in
     that action's pull request (Phase 7), never ahead of it. It starts with none.
3. Create the connected app **`Bidspoke Ops`** with OAuth enabled, the OAuth scope
   **`api`** only (not `full`, not `refresh_token`), and **Enable Client
   Credentials Flow** with the run as user set to the user from step 1.
4. Give its consumer key and secret to the person adding the connection: the key
   is the connection's declared `client_id` (and goes in the login too), the
   secret goes only in the sealed login. It must not be the money connected app:
   bidding refuses money's client id at save.
5. Prove it by attempting what it must not do: with the connection verified, send
   one write the permission set does not grant (for example, create an Account).
   It must fail with an insufficient access error. Success is a finding, filed
   before the connection is used.

### Approving a cap for a new Salesforce org (#2556)

Saving a connection for an org that has no approved cap fails on the Add
connection form with (design round 33, 2026-10-21): "Bidspoke has no limit set
yet on how many Salesforce calls its workflows may make to
lendco.my.salesforce.com, so it cannot connect to that org. Nothing was saved.
Ask Dan to set a limit for this org, then save again." That is verify's `sf_cap_unset`
(`POST /api/connections`, the refusal sentences in
`apps/worker/src/lib/connection-create-refusals.ts`), and it is the right answer
until the org is approved: nothing is asked of Salesforce, not even a token. The
trypennie org is the only one approved so far (table above). To approve another:

1. **Measure the org.** Its address is the host the form named
   (`lendco.my.salesforce.com`). Its 18 character org id is read from the org
   itself, never typed from Setup's Company Information page, which shows the 15
   character form that the tables' CHECK refuses: `sf data query --query "SELECT
   Id, Name, OrganizationType, IsSandbox FROM Organization" --target-org <alias>`,
   with a read only login to that org. Record the edition and that it is not a
   sandbox, as the trypennie approval does.
2. **Measure its room.** From the org's `/services/data/vXX.X/limits`, its
   `DailyApiRequests` maximum and what it used on a normal day, and from the
   partner how many long requests it allows at once, so the numbers below are
   chosen against the real ceiling (Phase 0 did this for trypennie).
3. **Dan decides the numbers and records the decision** on the issue that ports
   the first workflow using the org, as a comment naming the org id, the host and
   each number: `cap` and `workflow_share` for `sf_pool_caps`, `budget_floor`
   (remaining daily calls below which ops stops), `cap` 1 for the host's
   `sf_bootstrap_caps` row, and a `share` for each of `lookup`, `verify`,
   `connection_check` and `sf_limits` in `sf_purpose_caps`. That comment's time is
   the approval's `approved_at`.
4. **A migration of its own writes the rows**, modelled on
   `supabase-ops/supabase/migrations/20261020010000_sf_lane_approval_2336.sql`:
   rows only, every one on the nil uuid lane, `approved_by` naming Dan and the
   decision (`'Dan Wright (<the decision>, #<issue>)'`), safe to re-run and never
   an overwrite, with a test in `supabase-ops/supabase/tests` like
   `sf_lane_approval.test.sql`. Prove it with `SQL_SUITE_PROJECT=ops bash
   scripts/sql-suite/run.sh`. Dan signs the approval by approving that pull
   request; nobody else's review stands in for it.
5. **Apply it only after Dan says Apply**: `supabase --workdir supabase-ops db push
   --linked`, never from the repo root, which is linked to the bidding project.
6. Save the connection again. Its first verify takes the bootstrap slot of the
   host, measures the org and records it, and from then on the org's pool caps it.

### Google Workspace

1. A Workspace super admin, in Security, API controls, Domain wide delegation,
   adds the ops service account's client id with exactly the four scopes above.
2. A signed-in user of the organization adds each mailbox and shared drive its
   Google connections may name, on the Connections page (#2338), which audits
   every change.
3. Prove it by attempting the forbidden case on the live ops Worker: a connection
   naming a mailbox not on the list must be refused with `mailbox_not_allowed`
   before any token is asked for.
