# Achieve Offers node

Sends the current lead to Achieve's Partners API and collects the offers Achieve returns, without feeding them into routing. Built for data collection: every call is logged to the `achieve_evaluations` table so the team can analyze potential volume and lead quality.

> **Achieve chooses the product, not us.** There is no product-targeting field to set. Achieve
> drives selection on their side and currently evaluates Pennie's leads for personal loan:
> *"We drive this for our side, and right now, we evaluate your leads for APL"* (Olivier
> Pariselle, 2026-07-13). Their responses come back as `provider: "fplus"`, which is **Personal
> Loan + Pagaya** ("the fplus product is actually PL + Pagaya"). That is what Pennie wants; FDR
> (debt resolution) is explicitly not wanted. The `targeted_products` field in their API doc is
> an example only, and Achieve asked us to drop it, so the node does not send it.

## Purpose

The node POSTs the lead to Achieve's `/evaluations` endpoint with `wait_for_offers` enabled, so Achieve holds the request (up to 10 seconds) and returns its offers inline. The node is a pass-through with a single output: it forwards its input downstream unchanged and never fails the flow. Every outcome (accepted, rejected, auth failure, network error, missing lead fields) is captured as a structured output instead of an error.

The output carries an `_achieve_evaluation` marker. After the run completes, the engine persists every marked output to the `achieve_evaluations` table (request payload with SSN and date of birth redacted, full response, offers array, status, duration), keyed by `trace_id`, `execution_id`, and the Salesforce `Submission__c`. Test-runner executions are recorded with `is_test = true`.

## Config schema

`node.config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `wait_for_offers` | boolean | No | `true` | When true, Achieve holds the request up to 10s and returns offers inline. When false, Achieve replies accepted/rejected immediately and prequalifies asynchronously (no offers are logged). |
| `utm_source` | string | No | env `ACHIEVE_UTM_SOURCE`, then `pennie` | `tracking.utm_source` sent to Achieve. Achieve asked for `pennie_apl` (2026-08-17), set via the env var. |
| `utm_campaign` | string | No | env `ACHIEVE_UTM_CAMPAIGN`, then `_achieve_pl` | `tracking.utm_campaign` sent to Achieve (requested 2026-08-27). |
| `unsecured_debt_ref` | string | No | built-in extraction | Template overriding where the verified unsecured debt is read from, for workflows whose payload shape differs from the Main Flow. Example: `{{steps.my_step.output.debt}}`. |
| `vantage_score_ref` | string | No | `gen_vantage_score` step | Template overriding where the pulled Vantage score is read from, used only when the `ACHIEVE_MIN_VANTAGE_SCORE` floor is active. Example: `{{steps.my_step.output.score}}`. |

Standard node-config fields (`timeout_ms`, `retries`, etc.) also apply. Recommended: timeout `15000` ms (the default when dropped from the palette) and retries `0`, because retrying a transport failure risks double-submitting the lead to Achieve. The node aborts its own fetch at 12 seconds so a hung Achieve API never trips the engine-level step timeout.

### Environment variables

Credentials live on the Environment Variables page, not in node config:

| Variable | Required | Description |
|----------|----------|-------------|
| `ACHIEVE_USERNAME` | Yes | Basic auth username assigned by Achieve. |
| `ACHIEVE_PASSWORD` | Yes | Basic auth password (mark as secret). |
| `ACHIEVE_ENV` | No | `production` or `staging`. Picks the host **and the matching credential pair together**, so switching environment cannot leave the wrong password behind. Unset or blank means staging, which is the ordinary state of a workflow never pointed anywhere. An **unrecognised** value (say `prod`) is treated as a typo and **refuses to send**, naming the offending value, rather than quietly using staging: a silent fallback looks identical to Achieve declining every lead, which sends whoever reads it after the partner instead of the one setting that is wrong. Either way it never resolves towards production. |
| `ACHIEVE_STAGING_USERNAME` | No | Staging username. Falls back to `ACHIEVE_USERNAME` when absent, since Achieve confirmed the existing credentials also work against staging. |
| `ACHIEVE_API_URL` | No | Legacy explicit host, still honoured so nothing broke when `ACHIEVE_ENV` shipped. `ACHIEVE_ENV` wins over it, and only an exact match on the production host counts as production. |
| `ACHIEVE_UTM_SOURCE` | No | Fallback for `tracking.utm_source`. |
| `ACHIEVE_UTM_CAMPAIGN` | No | Fallback for `tracking.utm_campaign` (default `_achieve_pl`). |
| `ACHIEVE_CONSENT_TCPA` | Yes | Verbatim TCPA text shown on the form. Sent as `consents.tcpa`. |
| `ACHIEVE_CONSENT_FCRA` | Yes | Verbatim credit-authorization text shown on the form. Sent as `consents.fcra`. |
| `ACHIEVE_CONSENT_ESIGN` | No | Verbatim Electronic Consent Agreement text. Sent as `consents.e_sign`. |
| `ACHIEVE_CONSENT_POLICY` | No | Verbatim Privacy Policy text. Sent as `consents.policy`. |
| `ACHIEVE_CONSENT_TERM` | No | Verbatim Terms of Service text. Sent as `consents.term`. |
| `ACHIEVE_MIN_VANTAGE_SCORE` | No | Minimum pulled Vantage score required to send a lead to Achieve. Ships off: absent, blank, or `0` sends every lead (current behavior). Set a positive number (for example `700`) to skip the call for any lead scoring below it. |
| `ACHIEVE_MIN_LOAN_AMOUNT` | No | Smallest requested loan amount Achieve will consider. Achieve asked for `10000`. |
| `ACHIEVE_MAX_LOAN_AMOUNT` | No | Largest requested loan amount. Achieve asked for `50000`. |
| `ACHIEVE_ALLOWED_STATES` | No | Comma-separated two-letter states Achieve lends in. **Not the same list Pennie uses**: Achieve accepts MN and OR, which Pennie excludes, and excludes CO, CT, HI, IA, ME, VT, WA, WV, WI and WY, which Pennie allows. |
| `ACHIEVE_MAX_LOAN_TO_INCOME` | No | Ceiling on requested loan divided by annual gross income. Achieve asked for `0.35`. A lead missing either figure is refused when this is set. |
| `ACHIEVE_MAX_CURRENT_DELINQUENCIES` | No | How many delinquent accounts a lead may carry. Achieve asked for `0`. Requires a credit report. |
| `ACHIEVE_DELINQUENCY_MODE` | No | `current` (the default) counts only accounts currently 30 to 120+ days past due. `ever` also counts charge-offs and repossessions. **This one word roughly halves the surviving volume**: measured on 500 live reports, 47% of leads carry no current past-due, and only 26% carry no bad mark ever. Achieve's own wording ("Current delinquencies: 0") does not settle which they meant. |
| `ACHIEVE_MIN_MONTHS_SINCE_BANKRUPTCY` | No | Months that must have passed since the most recent bankruptcy filing. Achieve asked for `48`. A bankruptcy on file whose date cannot be read is treated as recent. Requires a credit report. |
| `ACHIEVE_MAX_INQUIRY_EPISODES_6MO` | No | Credit-shopping **episodes** allowed in the last 180 days, set to `5`, which is Achieve's own limit of fewer than 6. Inquiries closer together than the episode window count as one episode, which approximates their "after consolidating mortgage and auto inquiries" the way the credit bureaus de-duplicate rate shopping: by time rather than by lender type. Measured on 525 live reports, of the 57 leads with more than 5 raw inquiries the median had only 3 episodes and 40% had just one or two, so counting raw inquiries rejected people who made a single shopping trip. Requires a credit report. |
| `ACHIEVE_INQUIRY_EPISODE_DAYS` | No | The episode window in days, default `14`. Set this to Achieve's own window once they name one. |
| `ACHIEVE_MIN_AGE` | No | Minimum age in years, from the form's date of birth. Achieve asked for `18`. |
| `ACHIEVE_MAX_DTI` | No | Ceiling on debt to income, as a decimal. Achieve declines over 60%, so set `0.60`. Computed from the scheduled monthly payments on the credit report over monthly gross income, counting only accounts still being paid (a charge-off is not an obligation, and a settled account keeps its old payment figure). Measured on 537 live leads the median is 14% and the 90th percentile 44.7%, so a 60% ceiling sits out in the tail and removes about 4.5%. **It understates a renter's true ratio**, because rent never appears on a credit report while a mortgage does, which pushes leads under the ceiling rather than over it. A file with no accounts passes, since a ceiling on how much of an income goes to debt is not a reason to refuse somebody with no debt. No stated income refuses, because the ratio cannot be computed. Requires a credit report. |

### Pre-send screening

Achieve's APL team gave us criteria they recommend applying before pinging their API (Evan
Raciti, 2026-07-15). Dan chose on 2026-08-17 to apply them as a **hard gate**: a lead failing
any configured criterion is not sent at all.

Every threshold is an environment variable and every one is **inert when unset**, so all six
Achieve nodes in the Main Flow are configured from one page and no node config is ever touched.
A deploy with nothing set changes nothing about which leads are sent.

**Test runs bypass the screen entirely** (Dan, 2026-08-31): the score floor doubles as the live
pipe's pause switch, and a canvas test send is a deliberate, person-initiated single lead, so it
goes out to Achieve's real API regardless of the gate. Real webhook traffic stays fully screened.
This is what makes a partner test send possible while the pipe is paused.

A held-back lead carries its **own** reason on the step output (`reason`, plus the measured
value under `screen`), never a shared "skipped". That matters because a rejected lead never
reaches Achieve, so counting rejections by cause is the only measurement left. The reasons are
`no_credit_report`, `below_vantage_floor`, `loan_amount_below_min`, `loan_amount_above_max`,
`state_not_allowed`, `loan_to_income_too_high`, `has_current_delinquency`, `recent_bankruptcy`,
`too_many_inquiries`, `under_min_age` and `dti_too_high`.

**What this costs in volume.** Measured against 526 live leads reaching the node on 2026-08-17:
the four payload-only criteria pass about 20%, the full set passes about 9% under the default
delinquency reading, and about 3% under `ever`. So the gate cuts Achieve's volume by roughly ten
to forty times, from around 2,300 leads a day to between 50 and 200. That is intended, not a
defect, but it is worth re-reading before anyone concludes Achieve has no appetite for our leads.

**Not implementable, deliberately absent.** Citizenship or permanent residency, which neither
the form nor the credit report collects. That is the only one of Achieve's criteria we cannot
apply at all.

**One criterion is approximated rather than matched.** Their inquiry rule consolidates mortgage
and auto inquiries before counting. We consolidate by TIME instead of by lender type, because the
industry code on each inquiry cannot separate them: measured against real lender names, `AN` and
`AU` are car dealerships while `FA` mixes captive auto finance arms with personal lenders and `BB`
mixes banks with bank auto arms, and mortgage barely appears. Grouping on those codes would give a
number nobody could audit. Time clustering is how the credit bureaus themselves de-duplicate rate
shopping, so it approximates the same intent and lets us keep Achieve's own limit of fewer than 6
rather than inventing a looser one. See `ACHIEVE_MAX_INQUIRY_EPISODES_6MO` above.

**A missing credit report is not a clean one.** With any credit-based filter switched on, a lead
whose Equifax pull failed is refused (`no_credit_report`) rather than sent unscreened, so an
Equifax outage stops leads instead of sending unscreened ones at the moment we cannot screen.

### Vantage floor screen

`ACHIEVE_MIN_VANTAGE_SCORE` gates the call on the lead's pulled Vantage score. It is a single switch that applies to every Achieve node in the workflow, so it is changed once on the Environment Variables page rather than per node.

- Off by default: unset, blank, or `0` means send every lead, exactly as before. Add the variable set to `0` to stage it with no behavior change, then raise it when ready.
- When set to a positive floor, a lead whose Vantage is below the floor is skipped before any payload is built: no API call, no PII sent, no `achieve_evaluations` row, and the flow continues normally.
- A lead with no Vantage score is treated as below the floor and skipped (no score, do not send).
- The score is read from the `gen_vantage_score` step by default; override with `vantage_score_ref` for other workflows.

### Testing against Achieve's staging

Set `ACHIEVE_ENV` to `staging`, and set it back to `production` afterwards. That one value moves
the host and the credentials together. Nothing else needs touching.

Two things to expect before reading the result:

1. **Every staging request carries the same seeded identity** (see the showroom profile below), so
   a single request confirms the plumbing and the `utm_source`, while volume against staging is
   meaningless: Achieve would see one person over and over and dedupe most of it.
2. **Screening still applies**, judged on the real lead's data. With the full criteria set
   configured, roughly 7% of leads reach the send, so about one every six minutes.

To send anything at all the score floor must also allow it, since `ACHIEVE_MIN_VANTAGE_SCORE` is
what holds the feed closed. Open it for as short a window as you need, and put it back.

### Sandbox mode: the showroom profile

Achieve's sandbox **only returns offers for its own seeded showroom profiles**. It declines
every real lead regardless of debt (28 out of 28 on 2026-07-13, including two with ~$18k of
verified debt and poor credit). Achieve gave us one seeded profile to use off production: a
specific name and address.

**Whenever `ACHIEVE_API_URL` is not exactly `https://api.freedomfinancialnet.com`, the node
overlays ONLY the two fields Achieve gave us. Every other field stays the real lead's,
unchanged.**

| Field | Sandbox | Production |
|-------|---------|------------|
| `first_name` / `last_name` | Mark Mayerberger | the real lead |
| `mailing_address` | 19538 CREEKSIDE CT, Salinas, CA 93908 | the real lead |
| `social_security_number` | 666-16-4094 (seeded) | the real lead |
| `email`, `phone`, `date_of_birth` | **the real lead** | the real lead |
| debt, income, credit rating, loan purpose | **the real lead** | the real lead |

Only the name, address and SSN are swapped, because that is exactly what Achieve handed us as
the seeded profile. The node does not otherwise reshape the payload.

**This fails safe.** The check is "is this exactly production", so a blank, misconfigured or
typo'd `ACHIEVE_API_URL` sends the fake profile rather than a real person. Point it at
production and real lead data flows immediately, with no other change.

When credentials are missing the node skips the API call and logs an error-shaped evaluation; the flow continues.

### Consents

Achieve **rejects every lead** (`"response_reason": "Missing consents"`) unless the request
carries a `consents` object, despite their API doc marking it optional. Each field holds the
**verbatim legal text shown to the user**, not a boolean.

That text is identical for every lead (it is whatever the form displays), so it lives in the
env vars above rather than the payload. The payload's booleans say only *which* consents this
lead granted, and the node sends a consent's text **only when its boolean is true**, so we
never assert to a lender that a consumer agreed to something they did not:

| Consent | Gated on |
|---------|----------|
| `tcpa` | `legalInformation.consentsToTcpa` |
| `fcra`, `e_sign`, `policy`, `term` | `legalInformation.consentsToFcra` (the form grants all four on the same "Agree & View Offers" click) |

If the lead granted nothing, or no text is configured, the `consents` key is omitted entirely
rather than sent empty.

> **Keep these in sync with the form.** The stored text must be the text that was actually
> displayed when the lead submitted. If the form copy is rewritten and these env vars are not
> updated, we would be telling Achieve the consumer agreed to language they never saw.

## Field mapping

The node builds the Achieve request from the standard lead payload shape:

| Achieve field | Source |
|---------------|--------|
| `email`, `first_name`, `last_name` | `trigger.payload.personalInformation` |
| `phone` | `personalInformation.primaryPhone`, reformatted to E.164 |
| `date_of_birth`, `social_security_number` | `personalInformation` (already in Achieve's formats) |
| `mailing_address` | `personalInformation` address1 / address2 / city / state / zipcode |
| `unsecured_debt` | `steps.pennie_or_eligibility.output.eligibilityData.estimated_total_debt`, falling back to `.final`, unless `unsecured_debt_ref` overrides |
| `loan_amount` | `loanInformation.loanAmount` |
| `annual_income` | `financialInformation.annualIncome` (omitted when 0 or unknown) |
| `employment_status` | `financialInformation.employmentStatus`, mapped to Achieve's enum (for example `employed_full_time` becomes `full_time`); unmapped values are omitted |
| `credit_rating` | `creditInformation.providedCreditRating` when it matches Achieve's enum |
| `loan_purpose` | `loanInformation.purpose` when valid |
| `tracking.unique_identifier`, `partner_lead_id` | `Submission__c`, falling back to the trace id |
| `tracking.ip_address`, `tracking.user_agent` | `sessionInformation` |
| `tracking.utm_adgroup` | `traffic_source` on the payload, omitted when absent |

Every call records the two identifiers Achieve's edge returns, in `achieve_evaluations.achieve_request_id` (their `x-request-id`) and `achieve_evaluations.cf_ray` (Cloudflare's ray id from the proxy in front of their API). Both are stamped on every response including failures, so they are present exactly when something needs chasing. Achieve's decline responses carry no reason beyond one sentence, so quoting their own request id is the way to have their support find a specific call. Both columns are null on rows written before 2026-09-11, and on any path that never made a call.

The node sends no `trusted_form_cert`. #1081 was closed as not planned on 2026-09-04: the TrustedForm script is not going on the Pennie form, so no certificate can ever be minted for one of these leads. Achieve confirmed on 2026-09-10 that the field is a nice to have rather than a requirement, provided consent is captured and attested, which `consents.tcpa` and `consents.fcra` do.

Achieve requires email, phone, first and last name, mailing state, and either `unsecured_debt` or `loan_amount`. When any of these are missing the node skips the call and records which fields were absent.

## Output shape

```json
{
  "_achieve_evaluation": true,
  "ok": true,
  "status": 200,
  "response_status": "accepted",
  "response_reason": null,
  "offer_count": 2,
  "offers": [{ "provider": "fplus", "amount": 10000, "apr": 16.52, "monthly_payment": 464, "terms": 24 }],
  "request": { "...": "the payload sent to Achieve" },
  "response": { "...": "the full Achieve response" }
}
```

`response_status` is `accepted`, `rejected`, or `error`. `ok` is true only for accepted leads. Read downstream as `steps.<namespace>.output.offer_count`, etc., though in the collect-only setup nothing downstream consumes it.

## Edges

Single outgoing edge; always continues to the next node. The node performs no routing and cannot fail the flow.

## Placement

Because `wait_for_offers` can hold the request up to 10 seconds, place the node after the client response has been sent (for example at the tail convergence of the Main Flow's bid paths) so it adds no latency to the lead response.
