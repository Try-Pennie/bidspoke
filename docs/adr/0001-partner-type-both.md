# Allow a partner to be both a source and a buyer (`partner_type: 'both'`)

`partner_type` was an exclusive `source` | `buyer`, but real companies play both roles: Engine supplies free leads inbound *and* acts as the fallback buyer in outbound bidding. We add a third value, `both`, so one partner record can carry both roles and expose both config surfaces (bidding *and* sell-off/sub-accounts), rather than forcing two separate records per company.

## Status

accepted

## Considered options

- **Two records per company (a Buyer record + a Source partner record).** Rejected: splits one company's identity and config across rows, complicates reporting and the partner list, and was judged confusing in the grilling session (this was the initially-recorded choice, then reversed).
- **Two booleans (`is_source`, `is_buyer`) or a roles array.** Arguably cleaner (no conflated third enum value), but a larger change to the existing `partner_type` enum and all its call sites. Deferred in favour of the minimal `both` value that matches how the team already talks ("Engine is both").

## Consequences

- Schema migration to add `both` to the `partner_type` enum/check.
- The partner settings form must show *all* config sections for a `both` partner (today bidding sections are hidden for `source`).
- Bidding eligibility and circuit-breaker/cap logic must treat `both` as buyer-eligible; sell-off and sub-account-UUID logic must treat `both` as source-eligible. Audit every `partner_type === 'buyer'` / `=== 'source'` check.
- The `api_sources` Source concept (API-key inbound origins) is unaffected — `both` only concerns `partner_configs`.
- Not yet implemented as of 2026-06-22; this ADR records the decision.
