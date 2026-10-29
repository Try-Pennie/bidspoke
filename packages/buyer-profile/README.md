# @bidspoke/buyer-profile

The one vocabulary, validator and evaluator set for buyer profiles and the
buyer_select node (#1408, milestone 52). It holds:

- populations, the wired population list, US states, out reasons with labels,
  and signal operators;
- the tier matcher both pricing homes walk (the legacy `above` ladder in
  `bid-resolver.ts` is adapted into it);
- the Eastern clock, the eligibility evaluator and ranking;
- the sale outcome rules (the classifier's signal matching lives here and is
  imported back);
- the profile validator, the sale payload builder and the deadline wrapper;
- the click node rules that their executors and save validation share:
  - the buyer_click_send over cap percent (#1553);
  - the partner id rule both click nodes store their buyer by (#1543);
  - the one cap predicate `isCap` that save validation and both click nodes
    judge a cap by, with buyer_click_check's budget and last good copy bound
    (#1557);
  - the `{prospect_id}` click URL rule both enabling a click buyer and
    buyer_click_check read (#1546);
  - a click buyer's delivery (`click-delivery.ts`, #1639): the success line rule
    (`successPatternOf`) that buyer_click_send, canvas save validation and the
    profile validator all apply, and the route choice by state
    (`pickClickRoute`) the node posts by and the profile form's save
    confirmation describes.

`fixtures/tripoint/` holds the redacted response shapes captured from production
on 2026-09-21.
