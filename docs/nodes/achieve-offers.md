# Achieve Offers node

Sends the current lead to Achieve's Partners API (Freedom Debt Relief and related products) and collects the offers Achieve returns, without feeding them into routing. Built for data collection: every call is logged to the `achieve_evaluations` table so the team can analyze potential volume and lead quality.

## Purpose

The node POSTs the lead to Achieve's `/evaluations` endpoint with `wait_for_offers` enabled, so Achieve holds the request (up to 10 seconds) and returns its offers inline. The node is a pass-through with a single output: it forwards its input downstream unchanged and never fails the flow. Every outcome (accepted, rejected, auth failure, network error, missing lead fields) is captured as a structured output instead of an error.

The output carries an `_achieve_evaluation` marker. After the run completes, the engine persists every marked output to the `achieve_evaluations` table (request payload with SSN and date of birth redacted, full response, offers array, status, duration), keyed by `trace_id`, `execution_id`, and the Salesforce `Submission__c`. Test-runner executions are recorded with `is_test = true`.

## Config schema

`node.config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `targeted_products` | string[] | No | `["fdr"]` | Achieve products to request offers for. Valid values: `fdr` (Freedom Debt Relief), `fplus` (FreedomPlus personal loans), `lendage` (home equity). |
| `wait_for_offers` | boolean | No | `true` | When true, Achieve holds the request up to 10s and returns offers inline. When false, Achieve replies accepted/rejected immediately and prequalifies asynchronously (no offers are logged). |
| `utm_source` | string | No | env `ACHIEVE_UTM_SOURCE`, then `pennie` | `tracking.utm_source` sent to Achieve. Confirm the value with Achieve BizDev. |
| `unsecured_debt_ref` | string | No | built-in extraction | Template overriding where the verified unsecured debt is read from, for workflows whose payload shape differs from the Main Flow. Example: `{{steps.my_step.output.debt}}`. |

Standard node-config fields (`timeout_ms`, `retries`, etc.) also apply. Recommended: timeout `15000` ms (the default when dropped from the palette) and retries `0`, because retrying a transport failure risks double-submitting the lead to Achieve. The node aborts its own fetch at 12 seconds so a hung Achieve API never trips the engine-level step timeout.

### Environment variables

Credentials live on the Environment Variables page, not in node config:

| Variable | Required | Description |
|----------|----------|-------------|
| `ACHIEVE_USERNAME` | Yes | Basic auth username assigned by Achieve. |
| `ACHIEVE_PASSWORD` | Yes | Basic auth password (mark as secret). |
| `ACHIEVE_API_URL` | No | `https://api-stg.freedomfinancialnet.com` (sandbox, the default) or `https://api.freedomfinancialnet.com` (production). |
| `ACHIEVE_UTM_SOURCE` | No | Fallback for `tracking.utm_source`. |
| `ACHIEVE_TRUSTED_FORM_CERT` | No | Sent as `tracking.trusted_form_cert` when set. |
| `ACHIEVE_CONSENT_TCPA` | Yes | Verbatim TCPA text shown on the form. Sent as `consents.tcpa`. |
| `ACHIEVE_CONSENT_FCRA` | Yes | Verbatim credit-authorization text shown on the form. Sent as `consents.fcra`. |
| `ACHIEVE_CONSENT_ESIGN` | No | Verbatim Electronic Consent Agreement text. Sent as `consents.e_sign`. |
| `ACHIEVE_CONSENT_POLICY` | No | Verbatim Privacy Policy text. Sent as `consents.policy`. |
| `ACHIEVE_CONSENT_TERM` | No | Verbatim Terms of Service text. Sent as `consents.term`. |
| `ACHIEVE_SANDBOX_EMAIL_DOMAIN` | No | Domain for the sandbox's per-execution email (default `trypennie.com`). |

### Sandbox mode: the showroom profile

Achieve's sandbox **only returns offers for its own seeded showroom profiles**. It declines
every real lead regardless of debt (28 out of 28 on 2026-07-13, including two with ~$18k of
verified debt and poor credit). Achieve told us directly: *"if you want to see a response
with offers, please use this profile (a new valid email every time)"*.

So sending a real consumer to the sandbox leaks their SSN, date of birth, name and address
to a system that discards them and tells us nothing.

**Whenever `ACHIEVE_API_URL` is not exactly `https://api.freedomfinancialnet.com`, the node
substitutes Achieve's showroom identity:**

| Field | Sandbox | Production |
|-------|---------|------------|
| `first_name` / `last_name` | Mark Mayerberger | the real lead |
| `mailing_address` | 19538 CREEKSIDE CT, Salinas, CA 93908 | the real lead |
| `email` | fresh per execution, derived from `trace_id` | the real lead |
| `phone` | `+18005551212` | the real lead |
| `social_security_number`, `date_of_birth` | **omitted entirely** | the real lead |
| debt, income, credit rating, loan purpose | **the real lead** (no identity, and it is what FDR evaluates) | the real lead |

The email must be new on every submission or Achieve will not re-evaluate the profile, so it
is derived from the execution's `trace_id`.

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
  "offers": [{ "provider": "fdr", "amount": 32787, "monthly_payment": 640, "terms": 36 }],
  "request": { "...": "the payload sent to Achieve" },
  "response": { "...": "the full Achieve response" }
}
```

`response_status` is `accepted`, `rejected`, or `error`. `ok` is true only for accepted leads. Read downstream as `steps.<namespace>.output.offer_count`, etc., though in the collect-only setup nothing downstream consumes it.

## Edges

Single outgoing edge; always continues to the next node. The node performs no routing and cannot fail the flow.

## Placement

Because `wait_for_offers` can hold the request up to 10 seconds, place the node after the client response has been sent (for example at the tail convergence of the Main Flow's bid paths) so it adds no latency to the lead response.
