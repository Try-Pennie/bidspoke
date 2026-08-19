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
