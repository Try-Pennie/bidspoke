# The bidding model

How Bidspoke decides where a lead goes and what it sells for. This page explains the two bidding modes, the order of checks a single bid passes through, and how caps, circuit breakers, and dedup protect partners and spend. It is conceptual: for the exact config fields, see [the partner reference](../reference/partners.md), and for node behavior see the node pages linked throughout.

## What a bid is

A bid is one partner's answer to "what will you pay for this lead?" A partner is configured in Bidspoke (see [partner configuration](../reference/partners.md)) with a way to produce that number, called a resolver:

- **Formula**: compute the bid from the lead with an expression (for example `debt_amount * 0.65`).
- **Matrix**: look the bid up in a synced bid matrix by the lead's values (for example debt amount by credit score).
- **API**: ask the partner's API and read the bid from the response.

A bid attempt produces a number, no bid (a decline or an out-of-range matrix), or a skip (the partner was not eligible to bid at all). Comparing bids and picking a winner is a separate step from producing them.

## Two modes

### Outbound: hub-and-spoke parallel bidding

A lead arrives at Pennie. The workflow validates it, enriches it (credit pull, scoring), then fans the lead out to several buyer partners at once and collects their bids. The highest acceptable bid wins and the lead is routed to that partner. If no partner bids, the workflow falls back to a default buyer (in Pennie's case, the Engine) so the lead is never wasted.

This is the common shape for lead routing. The fan-out, bid collection, winner selection, and fallback are all handled by a single [Bid Group node](../nodes/bid-group.md).

### Inbound: ping-post bid response

A partner sends Pennie a ping asking for a bid on a lead they hold. The workflow validates the ping, runs its decision logic, and responds with a single bid (or a decline). The partner decides whether to post the lead based on the response. Here Bidspoke is the bidder, not the router: the workflow ends in a [Response node](../nodes/response.md) carrying the bid, not in a routing step.

Some partners are ping-only on the inbound side: the bid call has no side effects and a later conversion is a separate out-of-band call. That is a property of the partner's API contract, not a Bidspoke setting. The `bid_mode` value partners once stored (`commit` or `ping_only`) was never acted on; it left the partners page in PM-9 and nothing reads it since #2182.

## How a single bid flows

When a workflow asks a partner for a bid (via a [Partner Bid node](../nodes/partner-bid.md), directly or inside a Bid Group), the request passes through this sequence. Any guard can short-circuit it into a skip before the partner is ever contacted.

1. **Eligibility (is the partner on?)** If the partner's `is_active` is `false`, skip with reason `partner_inactive`. This is the global on/off switch.
2. **Circuit breaker.** If the breaker for this partner is open (too many recent failures), skip with reason `circuit_open`. See [protecting partners and spend](#how-the-guards-protect-partners-and-spend).
3. **Daily cap.** If the partner has hit its daily cap, skip with reason `cap_exceeded`. Otherwise the count is incremented.
4. **Dedup.** If the partner has a dedup endpoint and it reports this lead as a duplicate, skip with reason `duplicate`.
5. **Resolve the bid.** Run the partner's resolver (formula, matrix, or API) to get a number, no bid, or a partner-side rejection.
6. **Classify the response.** For API resolvers, classify the response against the partner's rules: accepted bid, business rejection (skip reason `rejected`), or an error (transient and retried, or permanent). A matched rejection is a normal outcome, not a failure.
7. **Compare to the floor.** If a bid came back below the partner's minimum (the partner-wide `min_bid` or a per-sub-account floor), treat it as no bid with reason `bid_below_min`.
8. **Compare and pick a winner.** Across all partners that bid, the evaluation step picks the winner by the configured rule (usually highest bid). See [comparing and picking a winner](#comparing-and-picking-a-winner).
9. **Route.** Send the lead to the winner, or run the fallback when nobody bid.

Steps 1 through 7 happen per partner inside the Partner Bid node. Steps 8 and 9 happen once, after all partners have been tried.

## How the guards protect partners and spend

Three guards sit in front of every bid. They exist to keep a bad partner or a bad day from costing money or damaging a relationship.

- **Daily caps** bound how many leads a partner can buy in a day. Some partners contract for a fixed daily volume; the cap enforces it. Caps are counted in a per-partner, per-day counter that resets automatically at midnight UTC, so there is no manual reset and no scheduled job to fail. A partner over its cap is simply skipped for the rest of the day and excluded from bidding.
- **Circuit breakers** stop sending bids to a partner that is failing. After a configured number of errors in a window, the breaker opens and the partner is skipped, which protects both your latency (you stop waiting on a broken endpoint) and the partner (you stop hammering it). After a cooldown, the breaker lets one probe through; if it succeeds, normal bidding resumes. A partner with an open breaker is excluded from the comparison, just like one over its cap.
- **Dedup** prevents selling the same lead to the same partner twice. Before bidding, the lead is checked against the partner's dedup endpoint; a duplicate is skipped. Dedup fails open: if the check errors or times out, the bid still proceeds, so a dedup outage degrades to "might double-send" rather than "can't bid at all."

Each guard turns into a specific skip reason on the bid output, which the execution detail view surfaces so you can answer "why didn't this lead get a bid from this partner?" The exact thresholds and endpoints are partner config: see [daily caps](../reference/partners.md#daily-caps), [circuit breaker](../reference/partners.md#circuit-breaker), and [dedup](../reference/partners.md#dedup).

## Comparing and picking a winner

Producing bids and choosing among them are separate concerns. Bidspoke gives you two ways to assemble them.

### Bid Group node (recommended for most flows)

A [Bid Group node](../nodes/bid-group.md) is one canvas node that owns a set of partners, fans the lead out to them internally, picks a winner, and exposes two outgoing edges: `winner` and `no_winner`. It supports three modes:

- **highest_bid**: ask all partners in parallel, take the highest acceptable bid.
- **cascade**: try partners in order, stop at the first that bids.
- **tiered**: group partners into tiers with per-tier advance conditions; each tier can itself be cascade or highest-bid.

It also carries a group-level fallback partner and a `no_winner_behavior` of `fail` or `exit`. Use a Bid Group when the bidding is self-contained: a set of partners, one winner, route accordingly. It keeps the canvas to a single node and synthesizes the per-partner attempt records for you.

## See also

- [Partner configuration reference](../reference/partners.md)
- [Partner Bid node](../nodes/partner-bid.md)
- [Bid Group node](../nodes/bid-group.md)
- [Parallel node](../nodes/parallel.md)
