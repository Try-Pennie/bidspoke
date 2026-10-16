# Buyer Click Check node

Decides, on Engine's response path, whether a click sold buyer (Liberty1 first, EvaFi later) may be offered this lead. A click sold buyer is quoted at the Engine bid when the offer is made and paid only when the person clicks, so this node never calls the buyer: it reads the buyer's profile and today's clicks, and routes `eligible` or `not_eligible`. The offer itself is built by the steps after `eligible`, and the click is sent later by [Buyer Click Send](buyer-click-send.md).

## When to use it

On the Engine Bidding response path, after Tripoint has given a known no, and before the steps that build the offer for the click buyer. The node carries the buyer's name, click URL and Salesforce routing code on its output, so those steps read them from here and hold no partner literal.

## What it does, in order

1. **Checks its config.** A `partner_id` that is not a partner id fails the step as `partner_id_invalid`, and a `population` outside the vocabulary as `population_invalid`, before anything is read. Both are refused when a live workflow saves, by the same rules.
2. **Reads the buyer profiles** through the one profile reader (the cached copy the profile save routes rebuild), and finds the buyer by its partner id.
   - Profiles served only from the last good copy (the database read failed) that is older than 15 minutes, or that the profile loader itself refuses for being past the shared 30 minute maximum or having no readable time (#1847): `not_eligible` as `profile_copy_stale`. Such a copy may still hold a buyer switched off, or a cap lowered, since.
   - No enabled profile for it: `not_eligible` as `profile_disabled`. The profile's Enabled switch is the on and off switch for offering the buyer.
   - A profile sold on the offer: `not_eligible` as `partner_not_click`, and a person is paged (once per buyer per 15 minutes). That buyer is sold by [Buyer Select](buyer-select.md), and offering it here as well would sell it two ways. It never fails the step, because a failed step here would fail Engine's whole execution, its reject response included. The profile save refuses switching a click buyer to the offer while a live workflow names it on a click node, naming the workflow.
3. **Judges the lead** against the profile, at the moment the node runs (not when the lead arrived): the partner's own active switch (`inactive`), then the partner's click URL, which must carry `{prospect_id}` where the prospect's id goes (`click_url_has_no_prospect_id`, and a person is paged once per buyer per 15 minutes, because the offer replaces that placeholder and refuses a URL without it; the profile cannot be enabled without it either), then the shared buy box, in this order: a missing or unreadable state, debt or loan amount (`missing_lead_field`), the state list (`state_not_allowed`), days off (`blackout`), hours (`closed`), the debt range (`debt_below_min`, `debt_above_max`), the loan amount minimum (`loan_amount_below_min`) and, when the profile caps collections, the collections share of the debt (`collections_above_max`, #2111; a missing or unreadable collections figure is `missing_lead_field`). A profile that caps collections, judged by a check with no `collections` template, routes every lead out as `collections_not_wired` and a person is paged once per buyer per 15 minutes. The first rule the lead fails is the reason. The buy box is the same code Buyer Select runs, so the two cannot drift.
4. **Reads today's clicks** from the buyer's click counter, the distinct prospects Buyer Click Send has sent it on this **Pacific** day, and compares them with the profile's clicks per day. Eligible only while the count is below the cap: 49 clicks of 50 is eligible, 50 of 50 is `daily_click_cap`. A profile with no clicks per day is `no_daily_cap`: the buyer is never offered without one. A few clicks past the cap can still land, because offers already made can still be clicked; the send side counts every one exactly.

   The count is read from its **saved copy** (#1632), which Buyer Click Send writes every time it counts a click, and is trusted right up to the cap (Dan, 2026-09-29). Reaching the counter itself took 130 to 760 ms of the budget on launch day while the counter answered in about 5 ms, because every lead paid a trip to wherever the counter lives; the copy is a few milliseconds. Only when there is no readable copy (the first check of a Pacific day before any click, or a copy that failed to write) is the counter asked, and its answer is saved as the copy for the next lead. The copy only ever moves up, but it can lag the counter: other data centres see a new value up to a minute late, and two clicks within a second can leave it one behind until the next click. Nothing refuses a click past the cap (Buyer Click Send sends it, counts it and pages over the cap), so on a busy day a few clicks past the cap can be sold. Dan accepted that on 2026-09-29 in exchange for a fast check all day. A copy that cannot be read is logged as `buyer_click_check_copy_unreadable`.

## The budget, and failing toward under sending

The profile read and the count read share one 800 ms budget (`CLICK_CHECK_BUDGET_MS` in `@bidspoke/buyer-profile`; 300 ms until 2026-09-29, when an eligible lead missed its offer on a slow profile read). A read that fails, one that has not answered when the budget ends, or a stored cap that is not a whole number above zero routes `not_eligible` as `cap_check_error`, with the cause in `detail`. The buyer is then not offered on this lead: a check that cannot finish never offers on a guess. A read that lands after the budget ended cannot change the answer already given.

## Routes

| Handle | `reason` | Meaning |
|--------|----------|---------|
| `eligible` | `eligible` | The buyer may be offered this lead. |
| `not_eligible` | one of the out reasons below | The buyer is not offered this lead. |

The out reasons are the package vocabulary Buyer Select also uses, shown in plain words in the execution view: `profile_disabled`, `inactive`, `missing_lead_field`, `state_not_allowed`, `blackout`, `closed`, `debt_below_min`, `debt_above_max`, `loan_amount_below_min`, `collections_above_max`, `collections_not_wired`, `partner_not_click`, `click_url_has_no_prospect_id`, `profile_copy_stale`, `no_daily_cap`, `daily_click_cap` and `cap_check_error`.

## What watches it

The click path checks (`apps/worker/src/lib/click-path-checks.ts`, every 15 minutes, #1546) page when a fifth or more of the last hour's runs (at least 20 of them) end in `cap_check_error` or `profile_copy_stale`, when three hours inside the buyer's selling hours pass with leads reaching this node and none eligible, when offers are made and no click reaches Bidspoke for three hours, when most of the clicks the buyer answered in an hour were refused, and once a Pacific day when the counted clicks disagree with Salesforce. Every threshold is written down beside its constant and is to be re-measured in launch week.

Both handles must be wired before a live workflow saves, because the node can take either and an unwired handle is a named step failure (`buyer_click_check_handle_unwired`).

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `partner_id` | string | Yes | none | The buyer's partner id, picked from the buyer partners by name. Keys the click counter. A slug here is refused at save and fails a run as `partner_id_invalid`. |
| `state` | template | Yes | none | Resolves to the lead's two letter state. |
| `debt` | template | Yes | none | Resolves to the debt the profile's range is judged against (for Liberty1, `engineDebt`). |
| `loan_amount` | template | Yes | none | Resolves to the requested loan amount, judged against the profile's minimum. |
| `collections` | template | When the profile caps collections | none | Resolves to the lead's collections balance in dollars (for Liberty1, `eligibleCollectionTotalBalance`), judged as a share of `debt` against the profile's cap (#2111). Zero is a figure and passes. |
| `population` | string | Yes | `engine` | The lead source this check runs on, recorded on every output. |

The rules themselves (states, hours, days off, debt range, loan amount minimum, clicks per day) live on the buyer profile on the Partners page, never in the node.

## Output

```json
{
  "_route": "eligible",
  "reason": "eligible",
  "population": "engine",
  "partner_id": "3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70",
  "partner_slug": "liberty1",
  "partner_name": "Liberty1",
  "click_url": "https://trypennie.com/portal/libertyone/{prospect_id}",
  "external_routing_code": 4,
  "count": 12,
  "daily_lead_cap": 50,
  "count_date": "2026-09-29",
  "count_source": "copy",
  "profile_served_from": "cache",
  "judged": {
    "lead": { "state": "TX", "debt": 25000, "loan_amount": 5000, "collections": 12000, "collections_percent": 48 },
    "limits": {
      "debt_min": 20000,
      "debt_max": 60000,
      "loan_amount_min": 2500,
      "collections_max_percent": 75,
      "state_allowed": true,
      "allowed_state_count": 12,
      "daily_lead_cap": 50
    }
  },
  "duration_ms": 18
}
```

`partner_name`, `click_url` and `external_routing_code` are the partner record's, so the steps that build the offer and the Salesforce patch read them from `steps.<namespace>.output`. They are null when no enabled profile was found. `count` and `count_date` are null when the counter was not read (the lead was out before the cap was checked, or the read failed). `count_source` says where the count came from: `copy` (the saved copy), `counter` (no copy, so the counter was asked), or null when no count was read. `daily_lead_cap` is the profile's clicks per day the count was judged against. `profile_served_from` says whether the profiles came from the database, the cache or the last good copy.

`judged` is what the decision was made on, on every output, whatever the route or reason, so one decision can be checked from this step alone. `judged.lead` is the state, debt and loan amount exactly as the eligibility check parsed them: a two letter state, and whole or fractional dollars. A field is null when its template resolved to nothing, or to something that is not a US state or an amount above zero (a debt of 0 is null, and is why such a lead is out as a missing lead field). The loan amount is recorded even when the profile sets no minimum, when it decides nothing. `collections` is the collections balance, zero or more, null when no template is set or it resolved to nothing readable; `collections_percent` is that balance as a percent of the debt, rounded to two places, null when either is null. The decision itself compares whole cents, so exactly the cap passes. `judged.limits` is the profile's debt minimum and maximum, loan amount minimum, collections cap and clicks per day (each null when the profile sets none, which means no limit), whether the lead's state is in the profile's list (null when the state did not parse, since it was never looked up) and how many states the list holds. `judged.limits` is set only when the eligibility check compared the lead with the profile, and is null otherwise: no enabled profile was found, the profiles could not be read, the last good copy was too old, the buyer was refused before the comparison (sold on the offer, disabled, switched off, or a click URL with no placeholder), or the time allowed ran out first. Unlike the top level `daily_lead_cap`, which is null when the stored cap is not a usable number, `judged.limits.daily_lead_cap` is the stored value itself.

## See also

- [Buyer Click Send](buyer-click-send.md), which sends the click and keeps the count this node reads.
- [Buyer Select](buyer-select.md), the sale node for buyers sold on the offer.
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
