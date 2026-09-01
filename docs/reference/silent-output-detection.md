# Silent output field detection

Some failures do not fail. A code node that wraps a fetch in `try { ... } catch { return null }` returns a completed step with an empty result, so the engine marks it green, nothing is retried, nothing alerts, and the lead carries on without the data. That is how the Eligibility Scout fallback in Main Flow was dead for three days and 629 leads with no alert at all: its output was an object, and only one field inside it was empty.

This page describes the detector that watches for that shape, what it alerts on, and what to do when it pages you.

## What is watched, and why you do not configure it

Nothing is tagged by hand. Opting nodes in was considered and rejected: it depends on someone remembering, and nobody remembering is exactly why Scout went unnoticed.

Instead, on every run the engine derives the set of fields that **something downstream actually reads**, straight from the running workflow definition. It scans two places:

- **Structured references** in node configs, node variables, and edge conditions: anything written as `steps.x.y.z`.
- **Code node scripts**, scanned for the same literal `steps.x.y.z` chains, and then for one level of alias: a script that writes `const r = steps.scout.$return_value` and later reads `r.final` has `scout.final` watched, even though that path is never written out in full. A read followed by `(` is a method call, not a field, and is skipped.

For each watched field it records one boolean per execution: did the producing node run, and did the field carry a value. Only booleans are stored, so no value and no PII is persisted. Those booleans roll up nightly into per-day counts per (workflow, field), which is what the detector reads.

Because the set is derived from the definition in memory at run time, it always matches the version that actually ran. There is no stored copy to drift.

### What is not watched

Two gaps, both deliberate and both visible rather than assumed away.

**Dynamic access.** A script that reaches `steps` through a variable key (`steps[name]`), aliases the whole object, or iterates it cannot be read statically. The scanner bails on the whole node rather than guess, and the node is listed in the coverage manifest as unreadable. As of 2026-09-01 there are zero such nodes across all active workflows.

**Aliases the scanner cannot follow.** Alias resolution stops where the local stops meaning one thing: a local that is declared twice, or reassigned, is not followed, because attributing its reads to the original path would watch the wrong field. Those nodes are listed in the coverage manifest as `alias_only_nodes`, which is a milder statement than unreadable: the node is scanned, some of its reads just cannot be attributed.

Resolving aliases closed the gap that used to dominate here. Measured 2026-09-01, before and after: 108 deep fields across 19 code nodes were read only through a local and therefore unwatched, in 8 of 10 active workflows, including money-path fields such as `ping_lendswift.data.data.bid_amount` and `bid_race.winner.bid`. All 108 are now watched, taking the total across active workflows from 250 to 358.

Still, do not read a clean coverage manifest as proof that every field a workflow depends on is watched. A field is only watched because something references it, so a value nothing reads is invisible here by design, and multi-level aliasing and destructuring are not followed.

## The two alerts

Both post to your org's Slack channel (or the workflow's `slack_channel` override) and are gated on the same `volume_alerts_enabled` toggle as the volume alerts, on the Integrations page.

### Output Field Stopped (hourly)

A field that normally carries a value has stopped carrying one today.

It only considers a field whose own history is stable: present on at least 90% of runs with very low day-to-day variance, over at least 3 qualifying days. That gate is what keeps normally-empty fields quiet. A bid amount that is null on every no-bid lead has high variance and can never trigger this, however empty it gets.

It fires when today's rate falls below the field's own baseline by more than four standard deviations or ten percentage points, whichever is larger, and only once at least 20 runs have happened today.

### Output Field Never Resolves (daily)

A field that has never carried a value, despite plenty of traffic. Over a rolling 7 days: at least 200 runs, spread over at least 3 distinct days, with a presence rate at or below 0.1%.

The day floor matters as much as the run floor. A field enters the watched set the moment something starts referencing it, and on a workflow running 500,000 executions a week a brand new field clears 200 runs within hours. Without the day floor, "never resolved over 7 days" would be a claim made from a few hours of one day. So a newly referenced field is not judged for its first few days, which is the honest cost of not accusing it on no evidence.

This is a different problem from the one above, and the message says so. A field that has never once resolved usually means the reference path is **wrong or obsolete**, not that an upstream is down. The fix is normally to correct the path or delete the reference.

### Why the thresholds are the numbers they are

They were measured, not chosen. Over 24 days of real traffic (2026-08-09 to 2026-09-01, 144 workflow-field pairs, 40.7M recorded runs) the drought check produced **zero** hits at every stability floor from 0.98 down to 0.80, so the floor was lowered to 0.90 purely to gain coverage: at 0.98 the Scout field itself (94.4% present) sat outside the gate, and a total Scout collapse could not have paged.

The dead ceiling sits at 0.1% because the real distribution has an empty band there: four fields resolve on exactly 0% of runs, and the next-rarest real field sits at 0.26%.

You can reproduce all of this:

```
cd apps/worker && npx tsx scripts/diagnose-field-presence.ts
```

It runs the detector's own functions over the live rollup, replays the drought check once per historical day, and carries positive controls so a zero cannot be mistaken for a broken harness.

## When you get paged

1. **Open the workflow** from the link in the alert and find the named field.
2. **Decide which of three things it is.**
   - The upstream genuinely broke. Fix the upstream; the all-clear posts by itself once the field is measured healthy again.
   - The reference is wrong or obsolete. Correct the path or remove it. The field stops being watched as soon as nothing reads it.
   - The field is legitimately allowed to be empty. Silence it, with a reason.
3. **Do not ignore it.** The drought check produced zero hits across 24 days of real traffic, so a page is not routine noise.

### Silencing a field

A silence is per (workflow, field) and **requires a reason**, which the coverage manifest displays. A silenced field neither pages nor announces recovery.

```
POST /api/field-coverage/{workflowId}/silence
{ "field": "scout.eligibility", "reason": "only populated for the eligibility route, ~0.3% of leads" }
```

Clear it with `DELETE /api/field-coverage/{workflowId}/silence` and the same `field` body. Both are audit-logged.

## The coverage manifest

`GET /api/field-coverage/{workflowId}` returns what is actually watched for that workflow, so coverage can be inspected rather than assumed:

- `fields`: every watched field, its `source` (`structured` or `code`), and its recent health (latest day's ran/present counts and rate, plus whether it is currently in drought or dead).
- `unreadable_nodes`: code nodes the scanner could not read at all.
- `alias_only_nodes`: code nodes holding a `steps` alias the scanner could not follow, so their watched set may be incomplete.
- `silences`: every silenced field with its reason and who set it.

All three handlers verify the workflow belongs to the caller's org.

## What silence from this detector does and does not mean

It means no watched field crossed a threshold on the last run of each check. It does **not** mean every field a workflow depends on is covered: see the gaps above, and note that a newly referenced field is deliberately not judged by the dead check for its first few days.

If a check itself fails, it throws rather than reporting an all-clear, and the failure is logged. Absence of a run is covered separately by the cron heartbeat.

## See also

- [Observability](./observability.md): the alert table, dashboards, tracing, and retention.
- [Error handling](./error-handling.md): what happens when a step fails loudly instead.
- [Data references](../concepts/data-references.md): the `steps.x.y.z` syntax this detector reads.
