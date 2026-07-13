# Achieve (FDR) offer-collection node

Status: built 2026-06-10 as the first-class `achieve_offers` node type, pending canvas
placement + Achieve account values. Node reference: [docs/nodes/achieve-offers.md](./nodes/achieve-offers.md).

Geoff's ask (Slack, 2026-06-09): hit Achieve's Partners API targeting just FDR from the
main flow, collect their offers without feeding them into routing, and log lead-in /
offers-out so we can analyze potential volume and lead types, then join trades data later.

## What was built

1. **`achieve_evaluations` table** (migration `20260610000001`) - one row per Achieve call:
   request payload (SSN/DOB redacted), full response, offers array, offer_count,
   response status/reason, http status, duration, trace_id / execution_id /
   submission_id for joins. Monthly partitions, RLS by workflow org, `exported_at`
   reserved for a future Snowflake push. The same migration restores monthly partition
   rollover for `lead_sightings` / `lead_sighting_bids` (their seeded partitions ended
   2026-09-30 with no cron extending them).

2. **Engine hook** (`apps/worker/src/engine/achieve-log.ts`) - after each walk, a step
   output carrying `_achieve_evaluation: true` is written to `achieve_evaluations` via
   `waitUntil`. Works from any workflow and any node NAME; multiple Achieve nodes per
   flow each get their own row. Test runs are recorded with `is_test = true`.

   Only node **types** that can produce an evaluation (`achieve_offers`, or a `code` node
   emitting the marker itself) are logged. The Achieve node is a pass-through, so its
   marked output becomes the input of everything downstream and a `branch_end` re-emits
   what it received: keying purely off the marker logged one row per node the output
   travelled through. A single call was writing 6 identical rows in prod before this was
   caught (2026-07-13), inflating the table and polluting `node_namespace`.

3. **`achieve_offers` first-class node** (`apps/worker/src/engine/nodes/achieve-offers.ts`,
   palette entry "Achieve Offers") - POSTs to `/evaluations` with Basic auth. Config:
   targeted products (default FDR only), wait_for_offers toggle, utm_source, optional
   unsecured-debt template override. Single output, pass-through, never fails the flow:
   every outcome (accepted / rejected / auth failure / timeout / missing fields) returns
   the marked output shape so it gets logged and the flow continues. Internal 12s fetch
   abort keeps a hung Achieve API from tripping the engine-level step timeout.

## Canvas setup

1. Env Variables page, add:
   | Name | Value | Secret |
   |---|---|---|
   | `ACHIEVE_USERNAME` | from Achieve | yes |
   | `ACHIEVE_PASSWORD` | from Achieve | yes |
   | `ACHIEVE_API_URL` | `https://api-stg.freedomfinancialnet.com` (flip to `https://api.freedomfinancialnet.com` after sandbox validation) | no |
   | `ACHIEVE_UTM_SOURCE` | value from Achieve BizDev (defaults to `pennie`) | no |
   | `ACHIEVE_TRUSTED_FORM_CERT` | only if Achieve requires it for us (see open questions) | no |

2. Drag an **Achieve Offers** node from the palette (defaults: FDR only, wait for
   offers on, timeout 15000 ms, retries 0 - retrying a transport failure risks
   double-submitting the lead). No script involved; Save the workflow as usual.

3. Placement (Main Flow): recommended at the **tail convergence** `branch_end`
   (node `79d7745b`) where all bid paths merge. The client response is already sent by
   then, so the up-to-10s Achieve wait adds zero lead-response latency, and
   `steps.pennie_or_eligibility` is in scope so the Equifax-verified debt rides along.
   Optionally a second copy on the over-20k path (after `Send Salesforce`, before
   `Exit 1`) - high-debt leads exit there and are FDR's sweet spot.

## Field mapping (trigger payload -> Achieve)

| Achieve field | Source |
|---|---|
| `unsecured_debt` | `steps.pennie_or_eligibility.output.eligibilityData.estimated_total_debt`, falls back to `.final` (Equifax-verified) |
| `loan_amount` | `loanInformation.loanAmount` |
| `email`, `first_name`, `last_name` | `personalInformation` |
| `phone` | `personalInformation.primaryPhone` reformatted to E.164 |
| `date_of_birth`, `social_security_number` | `personalInformation` (already in Achieve's formats) |
| `mailing_address` | `personalInformation` address1/address2/city/state/zipcode |
| `annual_income` | `financialInformation.annualIncome` (omitted when 0/unknown per doc) |
| `employment_status` | `financialInformation.employmentStatus` mapped (`employed_full_time` -> `full_time`, etc; unknown values omitted) |
| `credit_rating` | `creditInformation.providedCreditRating` passed through when it matches Achieve's enum |
| `loan_purpose` | `loanInformation.purpose` when valid |
| `tracking.unique_identifier`, `partner_lead_id` | `Submission__c` (falls back to trace_id) |
| `tracking.ip_address` / `user_agent` | `sessionInformation` |

| `consents.tcpa` | env `ACHIEVE_CONSENT_TCPA`, sent only when `legalInformation.consentsToTcpa` is true |
| `consents.fcra` / `e_sign` / `policy` / `term` | env `ACHIEVE_CONSENT_*`, sent only when `legalInformation.consentsToFcra` is true |

Not sent: `credit_score`. Achieve's spec accepts `fico_8` / `fico_9` / `fico_11` /
`self_stated` and we generate a Vantage score, which is none of those. The field is
optional and they do not complain, but it means their offers may not reflect what they
would do with a scored lead. Open with Achieve.

**Consents are required, not optional.** A 2026-07-13 sandbox call returned
`{"response":"rejected","response_reason":"Missing consents"}` with every other field
accepted, even though their doc marks `consents` optional. Trust the API, not the doc.
Achieve wants the verbatim legal text the user saw; that text is the same for every lead,
so it lives in env vars and is gated per-lead on the payload booleans. See
[docs/nodes/achieve-offers.md](./nodes/achieve-offers.md#consents).

## Analysis

> **`is_sandbox` matters more than `is_test` here.** Off production the node sends Achieve's
> seeded showroom identity (their sandbox only returns offers for its own seeded profiles), so
> on a sandbox row the **offers and the accept/decline describe a fake person**. The **lead
> volume and the debt we sent are real**, which is why the rows are flagged rather than hidden.
>
> Any offer-quality question (what would Achieve pay, what APR, what accept rate) MUST filter
> `NOT is_sandbox`. A pure volume question (how many leads reach each Engine path) may include
> them. Sandbox rows are never exported to Snowflake.

```sql
-- volume + acceptance by day (real offers only)
SELECT date_trunc('day', requested_at_utc) AS day, response_status, count(*),
       sum(offer_count) AS offers
FROM achieve_evaluations
WHERE NOT is_test AND NOT is_sandbox
GROUP BY 1, 2 ORDER BY 1;

-- lead volume reaching Achieve, by Engine path (sandbox rows are fine here: volume is real)
SELECT node_namespace, count(*) AS leads
FROM achieve_evaluations
WHERE NOT is_test
GROUP BY 1 ORDER BY 2 DESC;

-- offer detail, joinable to lead_sightings / execution_steps on trace_id
SELECT a.trace_id, a.submission_id, a.request_payload->>'unsecured_debt' AS debt_sent,
       o.value->>'amount' AS offer_amount, o.value->>'monthly_payment' AS monthly,
       o.value->>'terms' AS terms
FROM achieve_evaluations a, jsonb_array_elements(a.offers) o
WHERE a.response_status = 'accepted' AND NOT a.is_test AND NOT a.is_sandbox;
```

Trades-data join (Geoff, later): `trace_id` -> `execution_steps` rows for the
`trades_request` step, or `submission_id` -> Salesforce. Note `execution_steps` payloads
compact after 14 days; `achieve_evaluations` rows persist, so anything needed from
trades long-term should be exported or joined within that window (or we add trades
fields to this table).

## Open questions (for Geoff / Achieve)

1. **`trusted_form_cert`** - marked Required in the tracking object, but these leads
   don't carry TrustedForm certs. The script omits it unless
   `ACHIEVE_TRUSTED_FORM_CERT` is set. Ask Achieve whether it's waived for
   server-to-server partners (sandbox will tell us quickly via a 422).
2. **`utm_source` / tracking values** - doc says "work with Achieve BizDev to determine
   appropriate values". Currently `pennie`.
3. ~~**Consents**~~ - RESOLVED 2026-07-13. Required (not optional, whatever the doc says);
   Achieve wants the verbatim legal text. Text sourced from the Pennie form and wired via
   `ACHIEVE_CONSENT_*` env vars. Still open: whether Achieve wants the full linked
   agreements (Credit Authorization Agreement, Electronic Consent Agreement, ToS, Privacy
   Policy - bodies live in Prismic) rather than the summary block actually displayed.
4. **Marketplace partner list** - the FCRA consent authorizes sharing consumer-report data
   with ML Enterprise's "marketplace partners". Confirm Achieve/Freedom Debt Relief is on
   that list (it is Prismic content, linked from the form's consent block). If they are
   not, the consent does not cover pinging them and no code change fixes that.
5. **Which leads** - Dan scoped this to Engine-bound leads only (2026-07-13). Note the
   tail convergence `branch_end` also catches Tripoint/AmOne bid winners, so it is NOT
   Engine-only; use a per-path node. Over-20k leads (often the best FDR fits) never reach
   Engine and are excluded by that scope.

## Validation plan

1. Sandbox creds + `ACHIEVE_API_URL=api-stg`, drop the Achieve Offers node on the canvas, Save.
2. Test runner with a saved payload (rows land in `achieve_evaluations` with
   `is_test = true`); cross-check against the showroom profiles
   (https://growth-admin.stg.ffngcp.com/showroom, same creds as sandbox).
3. Confirm a row's request/response/offers look right, then flip `ACHIEVE_API_URL`
   to prod and Save.
