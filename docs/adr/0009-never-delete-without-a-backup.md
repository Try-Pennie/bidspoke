# 0009. Never delete without a verified backup

Status: accepted (Phase A0 of milestone 19)
Date: 2026-08-19

Numbered 0009, not 0008: `0008-decrypted-secrets-in-env-kv-cache.md` already
exists (#884).

## The principle

No process deletes data unless that specific data is provably somewhere else.
"Provably" means a measured count, not a flag somebody set.

The existing counter-example is `app_config.logpush_active`, verbatim:

```
key: logpush_active
value: true
note: Set to 'true' once Cloudflare Logpush is confirmed writing to R2/Snowflake.
      The cold-tier purge (purge-old-executions) will not delete rows until this is true.
```

It is a hand-typed string that authorises a purge. Nothing measures whether the
archive it names exists. It is the shape this milestone exists to remove, and it
is not deleted until the question it asks has been answered (see Unresolved).

## What deletes data today

| What | Mechanism | Backup |
|---|---|---|
| `workflow_executions`, `execution_steps` | `purge-old-execution-partitions`, 03:30 UTC, `truncate_expired_execution_partitions(7)` | **none** |
| `lead_sightings`, `lead_sighting_bids` | `purgeOldExported` after Snowflake export | Snowflake |
| `achieve_evaluations` | purge 24h after export | Snowflake |
| 12 config tables | hard `DELETE` from the API, no undo | **none** |
| `workflow_stats_daily` | rebuilt by the rollup | derived, out of scope |
| KV and Durable Object entries | TTL expiry | working state, out of scope |

## Measurements

All from prod on 2026-08-19 via `apps/worker/scripts/measure-bundle.ts`. Sample:
60 executions from the UTC day 2026-08-16, 716 step rows, untruncated.

### Bundle size

| | p50 | p95 | p99 |
|---|---|---|---|
| raw JSON | 42,153 B | 239,445 B | 503,811 B |
| gzipped | 8,438 B | 26,007 B | 36,546 B |
| wire (base64) | 11,252 B | 34,676 B | 48,728 B |
| compression ratio | 4.0x | 11x | 14x |

**The panel's 3.43x compression floor holds and is beaten.** That floor was
Postgres TOAST compressing values in isolation; the realised ratio on assembled
bundles is 4.0x at p50. This was the stop-and-re-decide condition. It clears.

Consequence: at ~105,000 executions/day the archive grows about **1.1 GB/day
compressed**, so 13 months is roughly **435 GB**, not the ~1.1 TB the planning
estimate used. The estimate was of uncompressed volume.

Note gzip ENLARGES payloads under about 1 kB. It is a saving on real executions
only, which is why the compression assertion in the test suite is made against a
realistically sized bundle rather than a small fixture.

### Steps per execution

p50 14, max 32, 716 across 60 executions (11.9 mean). The plan assumed 10.8.

### CPU per bundle

| stage | p50 | p99 |
|---|---|---|
| stringify | 0.112 ms | 1.458 ms |
| gzip | 0.346 ms | 3.156 ms |
| base64 | 0.049 ms | 0.224 ms |
| verify | 0.292 ms | 2.296 ms |
| **total** | **0.799 ms** | ~7.1 ms |

`verify` is `encodeBundle` decoding its own output to derive the step count, so
the count is read from what was actually produced rather than from the caller.
It is 37% of the p50 CPU and it is worth it: the deletion gate compares that
count against an independent Postgres count, and a count taken from intent would
let both sides agree while every bundle was short.

At 4,375 executions per hourly run this is about **3.5 seconds of CPU**. Not the
constraint.

### Step fetching is the constraint, and it changes the design

| shape | per execution | per hourly run (4,375) |
|---|---|---|
| one query per execution | 138.1 ms | **~10 minutes** |
| one query per batch | 15.4 ms | ~67 seconds |

**9x**, and the obvious shape does not fit. One query per execution would
consume essentially the whole 12-minute budget on fetching alone, before
compressing or sending anything. The archiver must fetch steps per batch,
bounded to the day's partition.

**The batched fetch must page and must verify its own row count.** PostgREST
caps a response at 1,000 rows regardless of `.limit()`. At ~12 steps per
execution that is reached at about 70 executions. Measured directly: a 150
execution batch returned 1,000 rows where the per-execution shape returned
1,690, and **the truncated run reported a BETTER speedup (15.9x) than the
correct one (9x), because it fetched less**. Silent truncation presents as a
performance win. The script therefore fetches both ways and asserts the row
counts agree.

### Settle window

How long after an execution completes before the tail consumer writes its cost.
Nothing stamps when that write happened, so it cannot be measured
retrospectively; it is measured forwards over recently completed executions by
age.

Bucketed over the last hour (5-minute buckets, ~480 executions each): 99.79%
settled in the 0-5 minute bucket, **100% in every bucket beyond 5 minutes**. The
oldest unsettled execution observed was 0.59 seconds old.

An hourly cadence archiving executions at least one hour old has ample margin.

## Two defects found by running the measurement, both of the class this milestone removes

Recorded because they are the argument for the principle, not incidental.

1. The settle query selected `workflow_executions.updated_at`, which does not
   exist, and the error was not checked on that one query while being checked on
   the others. It reported a settle window of **zero**, indistinguishable from
   the cost landing instantly. `measureSettle` now refuses to report a window
   when it sampled nothing and names which case it was, and that refusal is
   mutation-checked.

2. The settle sample asked PostgREST for 5,000 rows and silently received 1,000.
   With no ordering, the truncation dropped precisely the youngest rows, which
   are the only ones that can be unsettled, so it reported that everything
   settled instantly. The sample is now ordered newest first and reports whether
   the cap was reached.

Both produced a confident, reassuring, wrong number. Neither threw.

## Tenancy, measured (2026-08-20, Phase A2)

The single-tenant decision below is what lets the archive skip a database-layer
tenant boundary, so it is worth a number rather than an assumption. Measured on
prod:

| organization | workflows (incl. soft deleted) | executions in the retained window |
|---|---|---|
| `trypennie.com` | 34 (10 live) | 755,713, none flagged as tests |
| `E2E Test` | 9 (0 live) | 0 |

So exactly one organization has ever produced an execution, and the claim holds
today. It is **not** structurally guaranteed: the e2e org does create workflows,
so a future e2e test that triggers a run would produce executions under a second
organization, and the justification for having no boundary would have expired
without anything saying so.

The guard the plan requires for this lands with the archiver in A3 (#871), not
here, and deliberately: at that point there are real rows to judge, so the
archiver can refuse an execution whose organization is not the expected one and
alert, which fails closed on the actual data. A daily poll written here would
instead be a second predicate about the same fact, checking a table the archive
does not yet read.

## What Phase A2 dropped from the plan, and why

The plan specified the archive's tenant boundary as a secure view filtered on a
session parameter carrying the caller's org, with the reader role granted SELECT
on that view and never on the base table.

That is superseded by the single-tenant decision recorded below. A per-org
predicate would filter on a column holding one value, and the secure view would
buy nothing the base-table grant does not: the reader's credentials live in the
Worker, so SELECT on a view and SELECT on the table expose the same rows to the
same holder. A Snowflake row access policy, which would close it properly, needs
Enterprise edition and was priced and declined on the same grounds.

What remains, and is not weakened by dropping the view: the reader identity holds
SELECT and nothing else, and the eraser is the only identity in the account with
DELETE on the archive. The boundary against another organization is the route's
own `organization_id` check plus the measurement above, and that is weaker than
the RLS sitting behind the live path. Stated here rather than implied, because
the thing being protected is 13 months of unredacted identity data.

## The archive destination exists, measured 2026-08-20

`docs/snowflake-archive-setup.sql` was run by hand under ACCOUNTADMIN. What the
verification queries reported:

| | |
|---|---|
| account | `JYC55588`, region `AWS_US_EAST_1` |
| right account? | yes, two ways: it matches the identifier the Worker already uses, and `BIDSPOKE.PUBLIC.LEAD_SIGHTINGS` is present |
| `execution_archive` | created |
| Time Travel retention | **1 day** |

The retention number is the one that mattered, and it closes the worst version of
a question A7 would otherwise have had to guess at.

**What an erasure can honestly claim.** A Snowflake DELETE does not remove the
rows: the prior version stays readable through AT/BEFORE for
`DATA_RETENTION_TIME_IN_DAYS`, and Fail-safe holds a further seven days that no
customer, including an account admin, can query or purge. At 1 day, an erasure
request means the row is unreadable to any query one day later, and gone entirely
after eight. The plan's concern was that this setting is the kind of thing set
generously and forgotten, in which case the route would have been reporting a
deletion while the SSN stayed queryable for weeks (L82: measure the platform
guarantee a control rests on, before shipping the control; L11: a message may
claim only what its check actually measured).

So A7's erasure response must say the row is removed AND that the platform holds
a copy for up to eight days, rather than reporting a bare row count. Any clone or
share taken before the delete keeps it indefinitely, which is a separate question
A7 still has to answer.

**Not yet done in A2**: three RSA key pairs and six Worker secrets, so no identity
can authenticate to any of this yet. The role refusal checks (proving the reader
and writer genuinely cannot DELETE) move to A3, where the Worker's own credential
performs them, which tests the real path rather than a person switching roles by
hand.

## Unresolved, and deliberately not guessed

1. **Cloudflare Logpush.** Whether a job exists could not be determined: the
   Cloudflare API returns `10000: Authentication error` for the available token.
   Until answered, `app_config.logpush_active` is NOT deleted and the 90-day
   purge it gates is NOT repointed. If a job exists it becomes a fifth erasure
   target in A7. If it does not, three checked boxes in TODO.md section 3.5
   describe a system that does not exist and must be corrected.
2. **Snowflake per-statement text limit.** Unmeasured; the account is not
   reachable from this environment. Batch sizing in A3 depends on it.
3. **Cold-warehouse read latency.** Unmeasured. Sets the read deadline in A6.
4. **Snowflake credit cost.** Unmeasured. Must be checked against the real bill
   before A5 repoints either destructive job.

Item 2 above (the per-statement text limit) is still open, and A3's batch sizing
depends on it. It is now answerable, since the account is reachable by hand: send
one deliberately oversized statement and read where it refuses, rather than
sizing batches against a guess.

## Decisions taken (Dan, 2026-08-19)

Purpose is operational debugging only. Full raw fidelity including identity
data. 13 month retention. Existing execution URLs keep working. Read only, and
**no canvas for archived executions**: the canvas maps steps onto the current
graph and ignores which version ran, so an archived execution rendered on it
would be fabricated rather than stale. Config uses soft delete, kept forever.
If archiving stalls the delete does not run. Snowflake only, single shared
warehouse. Single tenant, so no Snowflake row access policy and no session
parameter design; intra-organisation read access remains an open A7 question.

## Fixtures and measurement output are numeric or synthetic, never captured

These bundles carry live SSNs, dates of birth, addresses and credit reports, and
`PII_REDACTION_FIELDS` is empty in `apps/worker/wrangler.toml:93`, so nothing
strips them. The measurement output is therefore the leak surface.

`summarize()` emits only numbers. This is guarded two ways because they catch
different things, and each was confirmed to fail against a deliberate leak of
its own kind:

- a structural test that every leaf value is numeric, which catches an opaque
  leak such as a slice of the compressed wire;
- a canary test on known payload values, which catches a payload value hidden in
  a **key name**, where the leaves are still numeric and the structural test
  sees nothing.

A blocklist alone would have caught neither.
