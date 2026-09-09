# Engine and Main Flow price Tripoint on different rules, deliberately

Two live workflows send leads to the same partner and each works out what the
lead is worth on a different basis. That is **intended**, not drift: the two
lead populations are not comparable, and the economics of a lead we own differ
from one we bought. This record exists so the next person to touch either path
can tell an intentional difference from a defect, and so nobody "fixes" one to
match the other.

## Status

accepted (2026-09-09, Dan Wright, resolving #1178)

## Context

Measured over 20 hours to 2026-09-04, Tripoint accepted bids:

| Workflow | Range | Distinct values | Priced by |
|---|---|---|---|
| Main Flow | $9.02 to $158.65 | 311 | `partner_configs.tripoint.bid_resolver_config`, a tiered multiplier on the lead's debt |
| Engine Bidding Workflow | $2.40 to $36.00 | 62 | its own `patch_prospect_body` code node, as `BidAmount__c` |

The near continuous spread on Main Flow is what a multiplier over a continuous
input produces. The 62 distinct values on the Engine flow is the shape of a
lookup table. They are different rules, not the same rule drifting.

Revenue is booked on two different Salesforce fields as well, which is the same
split seen from the other end:

- Main Flow leads book through `Lead.ExternalRevenue__c`: 0.0009 of debt from
  $10,000 to $12,499, 0.0012 from $12,500, and 0 below $10,000.
- External partner leads (Engine, AmOne, Lead Economy) book through
  `Prospect__c.ExternalExchangeRevenue__c`: 0.001 of debt from $10,000 to
  $19,999 and 0.0016 from $20,000.

## Decision

Keep them different. Engine leads are **bought** rather than owned, so what
Pennie can afford to pay for one is a different question from what an owned lead
is worth, and the two rules answer their own question.

## Consequences

- **Never compare Tripoint performance across the two flows without saying which
  rule produced each figure.** An average bid, a win rate by price, or a revenue
  per lead computed across both is two populations under two pricing rules
  presented as one number.
- The daily pricing check (`apps/worker/src/lib/tripoint-pricing-check.ts`,
  #1166) compares Bidspoke's config against `Lead.ExternalRevenue__c` only, and
  that is correct: it is the Main Flow rule, and it is the only one Bidspoke
  itself holds a copy of. It is deliberately silent about the Engine rule.
- The Tripoint revenue fill (`apps/worker/src/lib/tripoint-revenue-fill.ts`)
  reads the Prospect formula, which is why its output goes to
  `estimated_revenue_cents` rather than `bid_cents`.
- If the Engine rule ever moves into Bidspoke config, it needs its own partner
  row or its own resolver config, never a shared one with Main Flow.

## What would reverse this

Engine leads ceasing to be bought, or the two populations becoming comparable
enough that one rule can serve both. Neither is true as of 2026-09-09.
