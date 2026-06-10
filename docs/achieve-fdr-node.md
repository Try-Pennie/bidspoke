# Achieve (FDR) offer-collection node

Status: built 2026-06-10, pending canvas placement + Achieve account values.

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

2. **Engine hook** (`apps/worker/src/engine/achieve-log.ts`) - after each walk, any step
   output carrying `_achieve_evaluation: true` is written to `achieve_evaluations` via
   `waitUntil`. Works from any workflow and any node name; multiple Achieve nodes per
   flow each get their own row. Test runs are recorded with `is_test = true`.

3. **Code node script** (`docs/reference/achieve_fdr.js`) - ready to paste. POSTs to
   `/evaluations` with Basic auth, `targeted_products: ['fdr']`, `wait_for_offers: true`.
   Never throws: every outcome (accepted / rejected / auth failure / timeout / missing
   fields) returns the marked output shape so it gets logged and the flow continues.

## Canvas setup

1. Env Variables page, add:
   | Name | Value | Secret |
   |---|---|---|
   | `ACHIEVE_USERNAME` | from Achieve | yes |
   | `ACHIEVE_PASSWORD` | from Achieve | yes |
   | `ACHIEVE_API_URL` | `https://api-stg.freedomfinancialnet.com` (flip to `https://api.freedomfinancialnet.com` after sandbox validation) | no |
   | `ACHIEVE_UTM_SOURCE` | value from Achieve BizDev (defaults to `pennie`) | no |
   | `ACHIEVE_TRUSTED_FORM_CERT` | only if Achieve requires it for us (see open questions) | no |

2. Add a Code node, namespace `achieve_fdr`, paste `docs/reference/achieve_fdr.js`.
   Timeout **15000 ms** (`wait_for_offers` holds up to 10s), retries **0** (a retry on a
   transport failure risks double-submitting the lead). Save the workflow - code nodes
   run the deployed bundle, so the script only takes effect after a canvas Save.

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

Not sent: `credit_score` (we generate Vantage, Achieve expects fico_8/9/11 or
self_stated), `consents` (Achieve wants the legal text shown to the user, we only have
booleans - see open questions).

## Analysis

```sql
-- volume + acceptance by day
SELECT date_trunc('day', requested_at_utc) AS day, response_status, count(*),
       sum(offer_count) AS offers
FROM achieve_evaluations
WHERE NOT is_test
GROUP BY 1, 2 ORDER BY 1;

-- offer detail, joinable to lead_sightings / execution_steps on trace_id
SELECT a.trace_id, a.submission_id, a.request_payload->>'unsecured_debt' AS debt_sent,
       o.value->>'amount' AS offer_amount, o.value->>'monthly_payment' AS monthly,
       o.value->>'terms' AS terms
FROM achieve_evaluations a, jsonb_array_elements(a.offers) o
WHERE a.response_status = 'accepted' AND NOT a.is_test;
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
3. **Consents** - we have TCPA/FCRA booleans, Achieve optionally wants the legal text
   shown to the user. Confirm whether Geoff wants the actual disclosure text passed.
4. **Which leads** - tail placement sends every lead that reaches the bid stage.
   Over-20k leads (often the best FDR fits) exit earlier; add the second node if wanted.

## Validation plan

1. Sandbox creds + `ACHIEVE_API_URL=api-stg`, paste node on canvas, Save.
2. Test runner with a saved payload (rows land in `achieve_evaluations` with
   `is_test = true`); cross-check against the showroom profiles
   (https://growth-admin.stg.ffngcp.com/showroom, same creds as sandbox).
3. Confirm a row's request/response/offers look right, then flip `ACHIEVE_API_URL`
   to prod and Save.
