# Data classification and retention

What personal data Bidspoke holds, where each kind lives, how long it survives,
and what actually deletes it.

Written for #257. Every window and mechanism below was **measured** from the live
database and the shipping code on 2026-08-17, not copied from a policy anyone
intended. Where the intent and the mechanism disagree, this records the
mechanism, and says so.

## How to re-measure this

Nothing here is a number to trust on sight. Each row can be re-derived:

| Question | How to answer it |
|---|---|
| Which columns hold personal data | `information_schema.columns` in the `public` schema, filtered on column name |
| What deletes execution history, and when | `SELECT jobname, schedule, command FROM cron.job` |
| How old the oldest execution row can be | The earliest partition in `pg_inherits` for `execution_steps` |
| What deletes lead sightings, and when | `apps/worker/src/lib/sightings-export.ts`, the purge half |
| What is in Snowflake | `apps/worker/src/lib/sightings-export.ts` and `achieve-export.ts` |

A guard test (`apps/web/src/lib/__guards__/worker/pii-inventory.test.ts`) fails
when a migration adds a personal-data column that this document does not name. It
covers the schema half only. The retention half is prose, and prose goes stale,
so re-run the queries above before relying on a window in an answer to anyone
outside the team.

## Classification

Three tiers, by what a leak would cost.

**Tier 1, identity and financial.** Social security number, date of birth, credit
score, income. A leak is reportable and individually harmful. FCRA and GLBA both
bite here.

**Tier 2, contact and location.** Name, email, phone, street, city, state, zip. A
leak is harmful in aggregate and is what most consumer privacy law is written
about.

**Tier 3, staff and operational.** Team member email addresses on config rows,
audit trails, workflow definitions. Not consumer data, still not public.

## Where consumer data lives

### `lead_sightings` and `lead_sighting_bids` (Supabase)

The main store of Tier 1 data. `ssn` is held **in the clear**, formatted
`XXX-XX-XXXX`, and is indexed. Also `annual_income`, `income_pmt_frequency`,
`state`, `zip`. Monthly partitions, currently 2026-04 and 2026-07 through
2026-11 (`lead_sightings_2026_05` and `_2026_06` have been dropped).

**Retention: about 24 hours after a successful Snowflake export.** Supabase is a
write buffer, not the record. Export runs every two hours at :37; the purge runs
at :47, on odd hours for sightings and even hours for bids, in separate worker
invocations so a large sightings backlog cannot starve the bids purge.

This is the shortest retention of anything here, and it is the one most likely to
be wrong on a given day, because it depends on a job completing. It has failed
before: 107,274 purgeable rows once sat past the window for days while every run
reported `purged: 0, errors: []`. A purge that deletes nothing while a backlog
exists now throws instead of reporting success, and export or purge falling
behind alerts.

### `persons` (Supabase)

Encrypted Tier 1 and Tier 2 data: `ssn_encrypted`, `ssn_hash`, and AES-GCM
columns for date of birth, email, first and last name, phone, street and zip.

**Retention: not applicable. The table is empty and has no writer.** The writer
was removed and the table truncated on 2026-08-14 (#765), taking it from
3,694,280 rows to zero. It was write-only: nothing ever read it back, and it was
never in the Snowflake path. The table and its crypto helpers are left in place
so a future reveal feature stays cheap to build, and `lead_sightings.person_id`
is always null.

If personal data ever starts flowing here again, this row needs rewriting and the
erasure path below has a new target.

### `buyer_sales` (Supabase)

One row per lead a buyer was offered (#1409). It holds Engine's own lead id
(`lead_key`), the debt figure the price was computed from, the payout, and the
outcome. No name, contact detail, SSN or score: the lead is identified only by
the id Engine minted, which resolves to a person nowhere in this database.

**Retention: 90 days was decided (#1406) and is not enforced yet.** No purge job
exists for this table as of 2026-09-21; the milestone 52 phase that turns the
buyer_select node on ships it. Until then rows accumulate.

### `workflow_executions` and `execution_steps` (Supabase)

No named personal-data columns, and the most personal data of anything in the
database. Every lead's full payload passes through `trigger_payload`,
`response_body`, and each step's `input` and `output` as JSONB. That includes
social security numbers, names, addresses and credit reports.

**Retention: 7 days, by partition truncation.** Daily partitions;
`purge-old-execution-partitions` calls `truncate_verified_execution_partitions(7)`
at 03:30 UTC. Measured on 2026-08-17: the oldest live partition was
`execution_steps_2026_08_09`, so the true maximum age is about 8 days.

There is a redaction mechanism (`PII_REDACTION_FIELDS`) that scrubs named fields
at write time. **It is off.** The var is set to the empty string in
`wrangler.toml`, which means every payload is stored complete.

> **A dead job to be aware of.** `compact-execution-payloads` runs at 03:00 UTC
> and nulls `trigger_payload`, `response_body`, `input` and `output` on rows
> older than **14 days**. Partitions are truncated at 7. No row can ever reach 14
> days, so this job matches nothing, every night. It was correct when retention
> was 14 days and became dead when retention halved. Reading the job would tell
> you payloads are scrubbed as a second line of defence; they are not, and the
> only thing protecting them is the 7 day truncation. Tracked separately.

### Snowflake

`lead_sightings` and `lead_sighting_bids` are exported nightly, **including the
raw formatted SSN**. `achieve_evaluations` is exported with trades data joined.

**Retention: indefinite. Nothing deletes it.** This is the long-term home of
consumer Tier 1 data and the reason the Supabase window being short is not the
whole story. Any erasure request has to reach here, and today there is no
mechanism that does.

### Cloudflare

Logpush archives worker logs to R2. Structured logs carry trace ids and step
metadata rather than payloads, but this has not been audited field by field
against the classification above, and it should be before anyone claims consumer
data is absent from it.

### Salesforce

Prospect records carry the full consumer identity and are the system of record
for the sales side. Bidspoke writes to it and does not own its retention, which
is set in Salesforce and is outside this document.

## Where staff data lives

`users.email` and `user_allowlist.email` hold team member addresses.
`updated_by_email` on `workflows`, `environment_variables`, `partner_configs`,
`partner_bid_configs`, `service_connections`, `app_settings` and `buyer_profiles`
records who changed a config row (`buyer_profiles` also carries `updated_by_name`,
the editor's display name, because a buyer's price or cap changing is the kind
of edit somebody asks about by name).

**Retention: indefinite, deliberately.** These are audit trails. A workflow whose
last editor is unknown is worse than one whose editor is recorded.

## What this does not cover yet

Three gaps, each tracked separately rather than left implied here.

**There is no erasure path.** A request to delete an individual cannot be
serviced today. It would have to span Supabase (`lead_sightings` and
`lead_sighting_bids` across eight monthly partitions, keyed on the raw `ssn`,
which is what the data is actually keyed by now that `persons` is empty),
Snowflake (indefinite, no delete mechanism), execution payloads (self-clearing
within 8 days, so mostly a matter of waiting), and Salesforce. Note the issue
originally called for an `ssn_hash`-keyed path; that key lives on the table that
is now empty, so the design has to change.

**FCRA permissible purpose is not documented per pull.** Equifax pulls happen and
the gating exists in the workflow, but there is no record tying each pull to the
purpose that permitted it.

**The Achieve consent gap is closed.** Achieve's documentation lists
`trusted_form_cert` as required, and Pennie holds no TrustedForm certificates. Their
engineering team confirmed on 2026-09-10 that it is a nice to have rather than a hard
requirement while consent is captured and attested on our side, which the verbatim TCPA
and FCRA text sent with every lead does. Pennie is not adding the TrustedForm script to
the site (Geoff, 2026-09-04), so the node sends no certificate. See #1081.

## Retention at a glance

| Data | Store | Window | Enforced by |
|---|---|---|---|
| SSN, income, zip | `lead_sightings`, `lead_sighting_bids` | ~24h after export | worker purge, every 2h |
| SSN, income, trades | Snowflake | indefinite | nothing |
| Full lead payloads | `workflow_executions`, `execution_steps` | 7 days | partition truncation, 03:30 UTC |
| Encrypted identity | `persons` | n/a, table is empty | writer removed (#765) |
| Consumer identity | Salesforce | not ours | Salesforce |
| Staff email, audit | `users`, `*_by_email` | indefinite | deliberate |
