# Diagnosing a slow archive write to Snowflake

When the execution archive stops on a send to Snowflake that timed out (an HTTP 408, 504 or 524, or `Statement reached its statement or warehouse timeout`), or its runs get slower, this is how to find out where the time went. On 2026-09-22 (#1440, #1449) that took about an hour to work out from scratch, including a dead end. With these steps it takes a few minutes.

Every step is **read only**, and none needs an admin role. Nothing here writes to the archive table.

## Before you start

Run everything from the main checkout's `apps/worker`, which holds `.dev.vars` (the scripts read `SNOWFLAKE_ACCOUNT` from it, or from the environment if it is set there).

The steps run as the archive's **writer** identity, `bidspoke_archive_writer_svc`. Its private key is on Dan's machine at `~/.bidspoke/archive-keys/archive_writer.p8`; point `ARCHIVE_KEY_FILE` at another path if it lives elsewhere. To confirm the key authenticates:

```
npx tsx scripts/verify-archive-identity.ts writer
```

**Why the writer and not the reader.** A role without admin privileges sees only its own statements in `INFORMATION_SCHEMA.QUERY_HISTORY`. The writes that are failing were run by the writer, so the reader identity cannot see them at all, and its history would come back empty rather than wrong.

## Step 1: read Snowflake's own history of the archive's writes

```
npx tsx scripts/diagnose-archive-write.ts history
```

This lists the archive's `INSERT`s into `BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE` over the last 72 hours: how many, which did not succeed, and the 20 slowest, each with its time split into parts (step 2). Pass a number of hours to change the window, for example `history 24`.

Two limits of the history, both measured:

- **It reaches back seven days and no further.** Asking for more fails with `Cannot retrieve data from more than 7 days ago` rather than returning what it has, so the script refuses a window over 168 hours before sending it.
- **Seventy two hours is the useful window.** It answers "is this recurring" inside the statement timeout. A seven day scan did not finish inside it on 2026-09-22.

The script never selects a statement's text. The archive's statements carry the execution bundles, and with them applicant data, so printing them would put that data in a terminal or a transcript. Look a statement up by its query id instead: an admin can open it in Snowsight's query profile.

## Step 2: split the time before theorising

Each statement's total time is the sum of parts that point at completely different causes. Read which part is large before forming any theory:

| Column | What it measures | What a large value means |
|---|---|---|
| `compilation_time` | Snowflake parsing and planning the statement | The statement is expensive to compile. Go to step 3. |
| `execution_time` | Actually running the write | The write itself, or a warehouse too small for it. |
| `queued_overload_time` | Waiting behind other work on a busy warehouse | `ARCHIVE_WH` is shared by the archive's writes and its reads. |
| `queued_provisioning_time` | Waiting for a suspended warehouse to start | Normal for a few seconds on the first statement after the XS warehouse suspended. |
| `transaction_blocked_time` | Waiting on a lock held by another transaction | Something else writing the table at the same time. |

The script's `mostly` column names the largest part for each statement, and its first lines count them across the window.

On the 2026-09-22 incident one timed out write spent **77,813 ms compiling against 460 ms executing**, with queued and blocked at zero. That single reading ruled out the warehouse, the write itself and lock contention in one step, and it is the reading to take first.

What healthy looks like, measured on 2026-09-25 over 72 hours: 2,020 writes, all successful, compile times mostly 1 to 2.5 seconds and execution 0.25 to 0.35 seconds, slowest total 5 seconds. So compilation being the largest part is **normal** for these writes; what matters is its size. One of the slowest that day was mostly warehouse start (3,066 ms), which is also normal.

## Step 3: time a compile without writing anything

When compilation is the problem, the question is whether it is the table or the statement. Test it by compiling a real statement against the real table:

```
npx tsx scripts/diagnose-archive-write.ts explain
```

This builds one archive `INSERT` with the archive's own statement builder (`buildInsert` in `apps/worker/src/lib/execution-archive-send.ts`) and sends it behind `EXPLAIN`, which compiles it against the real table and executes nothing. It prints how long that took. Pass a row count and a size per row in KB to change the shape, for example `explain 300 13`. The default is 150 rows of 13 KB, about 1.9 MB, the size of a normal send.

Measured on 2026-09-25, the default compiled in 1,268 ms end to end, in line with the history, and wrote nothing (a count of the probe's ids in the table afterwards was 0). A time far above what the history shows for real writes points at the table; a time in line with them points back at what was different about the slow statements.

**A scratch table is not an alternative.** It is the obvious one, and it does not work: the writer holds no `CREATE TABLE`, by design (see `docs/snowflake-archive-setup.sql`).

## Step 4: make the probe look like real data

The probe gives **every row its own random payload**, because real bundles are all different. The first attempt on 2026-09-22 repeated one 13 KB literal 150 times, reported about a second, and so let Snowflake off work it genuinely has to do with real data. A probe shaped by convenience rather than by the real inputs measures the convenience (lesson L48). If you change the probe, keep the rows distinct.

## Where the code lives

- `apps/worker/scripts/diagnose-archive-write.ts`: the two commands above.
- `apps/worker/src/archive/write-diagnosis.ts`: the statements they send, pinned by `apps/worker/src/archive/__tests__/write-diagnosis.test.ts`.
- The archive's failed send alert names this page.
