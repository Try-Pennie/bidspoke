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

**Query this in Snowflake, not Supabase.** The nightly 09:00 UTC export
(`apps/worker/src/lib/achieve-export.ts`) MERGEs rows into an `achieve_evaluations` table in
the same database and schema as `lead_sightings` (`SNOWFLAKE_DATABASE` / `SNOWFLAKE_SCHEMA`),
then purges the Supabase source about 24 hours later. Supabase therefore holds roughly a day
of real rows; Snowflake holds all of them.

**Every row in Snowflake is already real and non-test**, so none of the queries below filter
for that. The export only ever ships rows with `is_test = false AND is_sandbox = false`, and
neither column is in the exported column list at all. Writing `WHERE NOT is_sandbox` against
Snowflake does not narrow the result, it errors on an unknown column.

Sandbox rows still exist, but only in Supabase, and they never leave it. Off production the
node sends Achieve's seeded showroom identity (their sandbox only returns offers for its own
seeded profiles), so a sandbox row's offers and accept/decline describe a fake person. Holding
them back is what keeps fabricated APRs out of Snowflake. If you do query Supabase directly,
filter `is_test = false AND is_sandbox = false` yourself, because there nothing has filtered
them for you.

Three things will quietly skew a first pass at this data. The counts below are a snapshot from
2026-07-14 (527 real rows, the first day the node ran in production) purely to show the shape of
the problem; they move daily, so re-derive them, do not cite them.

1. **`DuplicateLead` is not a decline, and it is a large minority.** Achieve cannot make an
   offer on a lead it has already seen, so those rows can never produce offers: 87 of the 527.
   Leave them in the denominator and the offer rate is diluted by leads that were never eligible
   for an offer in the first place. Every offer-rate query below excludes them.
2. **`response_reason` embeds the Achieve lead ID** ("Lead 187740532 didn't qualify for
   offers"), so a plain `GROUP BY response_reason` returns one group per lead (429 of them),
   not one group per reason. Normalize it first, the way the reason query below does.
3. **`offers` is a term ladder, not a set of competing loans.** An accepted lead comes back with
   the same `amount` at several `terms` (24/36/48/60 is typical), which is how 11 accepted leads
   produced 44 offers. Averaging `amount` over flattened offers therefore counts one loan four
   times. Collapse to one offer per lead first, as the best-offer query does with `QUALIFY`.

```sql
-- Volume and outcome by day.
SELECT DATE_TRUNC('day', requested_at_utc)             AS day,
       COUNT(*)                                        AS leads,
       COUNT_IF(response_reason = 'DuplicateLead')     AS duplicates,
       COUNT_IF(response_status = 'accepted')          AS accepted,
       COUNT_IF(response_status = 'error')             AS errors,
       SUM(offer_count)                                AS offers
FROM achieve_evaluations
GROUP BY 1
ORDER BY 1;

-- Offer rate. Duplicates are out of the denominator: Achieve never scores them.
SELECT COUNT(*)                                                        AS scored_leads,
       COUNT_IF(response_status = 'accepted')                          AS leads_with_offers,
       ROUND(100 * COUNT_IF(response_status = 'accepted')
                 / NULLIF(COUNT(*), 0), 1)                             AS offer_rate_pct
FROM achieve_evaluations
WHERE COALESCE(response_reason, '') <> 'DuplicateLead';

-- Why leads come back without offers, with the per-lead ID normalized out of the reason.
SELECT CASE
         WHEN response_reason ILIKE 'Lead % didn''t qualify%' THEN 'Did not qualify'
         ELSE COALESCE(response_reason, '(accepted)')
       END               AS reason,
       COUNT(*)          AS leads
FROM achieve_evaluations
GROUP BY 1
ORDER BY leads DESC;

-- Lead volume reaching Achieve, by Engine path.
SELECT node_namespace, COUNT(*) AS leads
FROM achieve_evaluations
GROUP BY 1
ORDER BY leads DESC;

-- Every offer, one row per rung of the term ladder.
SELECT a.trace_id,
       a.submission_id,
       a.request_payload:unsecured_debt::NUMBER  AS debt_sent,
       a.request_payload:credit_rating::STRING   AS credit_rating,
       o.value:provider::STRING                  AS provider,
       o.value:amount::NUMBER                    AS offer_amount,
       o.value:apr::FLOAT                        AS apr,
       o.value:terms::NUMBER                     AS terms,
       o.value:monthly_payment::NUMBER           AS monthly_payment
FROM achieve_evaluations a,
     LATERAL FLATTEN(input => a.offers) o
WHERE a.response_status = 'accepted'
ORDER BY a.requested_at_utc DESC;

-- Best offer per lead (lowest APR rung), so per-lead averages are not counted once per term.
SELECT a.trace_id,
       a.submission_id,
       a.request_payload:unsecured_debt::NUMBER  AS debt_sent,
       o.value:amount::NUMBER                    AS offer_amount,
       o.value:apr::FLOAT                        AS apr,
       o.value:terms::NUMBER                     AS terms,
       o.value:monthly_payment::NUMBER           AS monthly_payment
FROM achieve_evaluations a,
     LATERAL FLATTEN(input => a.offers) o
WHERE a.response_status = 'accepted'
QUALIFY ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY o.value:apr::FLOAT) = 1;
```

**Trades data is already on the row.** It does not need a join (issue #28 shipped this): the
export backfills each evaluation's `trades_request` step output into the `trades` VARIANT while
the execution is at most a day old, precisely because `execution_steps` ages out well before
anyone gets around to the analysis. The shape is `{status, body}`, so read it as
`trades:body`, and expect it to be null on some rows (383 of the 527 carried trades), since not
every execution reaches the trades step. `submission_id` still joins out to Salesforce, and
`trace_id` to `lead_sightings`.

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
