# Lead Validation node

An ordered list of checks a lead must pass before a bidding workflow goes on. Each check is a rule builder condition describing a lead that may go on, the rejection reason the lead source is told when a lead does not, and what happens when the lead lacks a value the check reads. The first check a lead does not pass rejects it; a lead that passes every check goes on to the next step.

It replaces the `validate_bidding_and_state` code nodes the RML and Lead Economy workflows carry today (#934). The engine half shipped first (#2589) and is not offered on the canvas palette yet: its card and config panel are phase 3 (#2590). No live workflow uses it until a swap issue moves one, with proof that the node answers every lead exactly as the script did.

## What a rejection sends

Exactly what the validate scripts send through their response sentinel: HTTP 200, the configured headers, and

```json
{ "lead_id": "<the lead id field's value>", "status": "rejected", "reason": "<the check's reason>" }
```

The run ends there and records as completed. A lead id field that resolves to nothing is left out of the body, as the scripts left it out.

## Config schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lead_id_field` | reference | Yes | Where the lead's id is, for example `trigger.payload.leadUuid`. |
| `checks` | `Check[]` | Yes, at least one | Judged in order. |
| `response_headers` | `Record<string, string>` | No | Sent with a rejection, literally. Each name and value must be filled in. |

Each check:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique within the node. Recorded in the step output. |
| `label` | string | What a person calls the check. |
| `condition` | `{ groups: ConditionGroup[], logic: 'AND' \| 'OR' }` | What a lead that may go on looks like, as Branch stores a condition. |
| `reason` | one of `LEAD_REJECTION_REASONS` | The reason sent with a rejection, spelled exactly as partners see it (`packages/workflow-definition/src/lead-rejection-reasons.ts`). |
| `on_missing` | `'reject'` \| `'pass'` \| `'fail_run'` | What a lead the check cannot judge does (below). |

A condition's `field` and any reference on its value side start with `trigger.`, `steps.` or `env.`. `steps.<namespace>.output.<field>` and `steps.<namespace>.<field>` read the same value. Number comparisons (`gt`, `gte`, `lt`, `lte`) and list comparisons (`in_array`, `not_in_array`) may name a value, such as a Constants key; the other operators compare against what is written.

## Three outcomes per condition

Each condition is judged pass, fail, or unevaluable with a cause. Unlike Filter and Branch, the node never reads a missing value as false, never reads `''`, `null` or `true` as a number, and never drops a half filled row (save refuses one).

- **missing**: the lead has no value at the field (`undefined` or `null`).
- **not_a_number**: a number comparison met text that is not a number, or a boolean.
- **not_a_list**: a list comparison named a value that is not a list.

The presence operators (`exists`, `not_exists`, `is_null`, `is_not_null`) judge a missing value themselves.

Within a group and across groups, AND fails on any failing condition (the first), and is otherwise unevaluable if any condition is; OR passes on any passing condition, and is otherwise unevaluable if any condition is. So a lead that plainly fails a check is rejected for that check's reason whatever else it lacks.

An unevaluable check does what its `on_missing` says:

- `reject`: reject with the check's own reason. The output records the cause.
- `pass`: the lead passes this check and goes on to the next. The output lists it under `passed_unjudged`.
- `fail_run`: the run fails with `Lead validation check <id> could not be judged: <field> is missing` (or `is not a number`), and pages as any failed run does.

## A missing setting

A Constants key or env value a check reads is configuration, not lead data. Every setting the checks read is resolved before any check runs, so the answer is the same whichever lead arrives. If one is missing (or a number comparison's limit is not a number, or a list comparison's list is not a list), the run fails with `Lead validation setting missing: check <id> reads <reference>, which is missing`. That run's own failure page is suppressed: every lead reaching the step would fail the same way, so the engine pages once per incident instead, under the incident signal `lead-validation-config` keyed on the workflow and the step, and sends an all clear once the step reads its settings whole again and has not faulted for 30 minutes (`apps/worker/src/lib/lead-validation-config-alert.ts`). A stored config the node cannot run is handled the same way.

## Output

```json
{ "valid": true }
{ "valid": true, "passed_unjudged": [{ "check_id": "amount", "field": "trigger.payload.loanAmount", "cause": "missing" }] }
{ "valid": false, "check_id": "state", "field": "trigger.payload.state", "reason": "ineligible state" }
{ "valid": false, "check_id": "amount", "field": "trigger.payload.loanAmount", "reason": "loan amount exceeds maximum", "cause": "missing" }
```

The output and the logged input name the check and the field, never a value compared. A rejection is recorded on the lead's sighting as `reject_reason` = `lead_validation:<reason>`.

## Save validation

A save (and a create) is refused when an attached Lead Validation node has: no checks; no lead id field; a check with no label, no id, or the id of another check; a group with no conditions; a condition with no field or no operator; an operator outside the shared list; an empty value on an operator that reads one; a literal that is not a number on a number comparison, or not a list on a list comparison; a reference on an operator that compares text; a reason outside the list; an `on_missing` outside the three; a header with no name or value; a reference to a step that does not run before the node; or a Constants key the Constants step does not hold. The rule is `findLeadValidationProblems` in `packages/workflow-definition/src/lead-validation.ts`; the canvas reads the same parser.

Partner values the Constants node adds from the database (`activeBidding`, `subAccountIdsMap`, `<Slug>ClickUrl` and the rest) are not in its own data, so a check cannot name them yet. A partner lookup check is its own issue.

## Proving a swap

Before a workflow's `validate_bidding_and_state` script is replaced, three instruments compare the script with the node that replaces it (#2591). Each candidate node lives in `apps/worker/money-gate/swap/candidates/<workflow>.json`, the node exactly as it is pasted (same id, namespace and label as the step it replaces), with the md5 of the script it replaces, any Constants data the swap sets, and the differences each instrument finds that are an accepted change, each with its reason.

1. **Script against node grid**, in CI (`apps/worker/money-gate/swap/__tests__/grid.test.ts`): the script from the committed money gate definition, refused unless its md5 is the pinned one, and the node, run side by side over a generated grid of synthetic leads (every reason, every field missing, null, blank or of the wrong kind, non-ASCII names, the amounts either side of each limit, and pairs of rejections for the order). Every difference the candidate does not accept fails, by arm and check; a defect seeded in each check, in both directions, must be named.
2. **Money gate definition A/B mode**: `.github/scripts/money-gate-swap.sh <candidate> [<check>:<lenient|strict>]` replays the workflow's money gate fixtures through one engine with the committed definition and with the candidate in place, and compares response, outbound requests, writes, routes and the final node. See `apps/worker/money-gate/README.md`.
3. **Real traffic replay**: `npx tsx scripts/lead-validation-replay.ts <candidate> [--hours 24] [--to <time>] [--seed <check>:<lenient|strict>] [--dev-vars <path>]` from `apps/worker`, read only, counts only (`apps/worker/money-gate/swap/real-traffic.ts`).

## See also

- [Filter node](filter.md) for the shared operators
- [Branch node](branch.md) for the condition shape
- [Constants node](constants.md)
