# Liberty1 on a known Tripoint no: paste and wire guide

Issue #1544, milestone "Click sold buyers". When Tripoint gives a KNOWN no on an Engine sell off lead, the Engine Bidding Workflow (`da82a183-1a4a-417e-b0b8-5f3fe5e14840`) offers the lead to a click sold buyer (Liberty1 first, EvaFi later) instead of rejecting it. The buyer is sold when the person clicks, through the Liberty1 click workflow (#1545).

[`liberty1-wiring.json`](./liberty1-wiring.json) is the exact change: the four nodes to add, the two live edges to remove and the nine edges to add. The live ids in it were read from the canvas mirror on 2026-09-24 (version 100); the ids of the four new nodes are stand ins, because the canvas mints its own. Two tests hold it: `apps/worker/src/engine/__tests__/engine-bidding-liberty1-walk.test.ts` walks the live workflow's tail with the change applied, and `apps/web/src/lib/__tests__/engine-bidding-liberty1-wiring.test.ts` runs the canvas's own save checks over it.

## What a lead does after the change

1. `tripoint_ping` answers as today (at Stage B, `buyer_select` decides instead and `tripoint_ping` does not run).
2. **Known No Gate** (`known_no_gate`, a code node) says whether that answer is a known no:
   - from `tripoint_ping`: `tripoint_answer` is `declined` (a decline or a duplicate), `invalid_data` (the known 502 rejection) or `null_id_fault` (the known null id 502);
   - from `buyer_select`: it routed `no_sale` with reason `declined_by_buyer`.
   Everything else is not a known no: accepted, `in_progress` (1009), `unknown` (a timeout, a proxy 5xx, anything unreadable), skipped, and every other buyer_select reason (caps, `circuit_open`, `outcome_unknown`, `buyer_error`). An unknown answer may be a sale Tripoint made, so offering it again could sell the lead twice.
3. **Route Known No** (`route_known_no`, a Branch) sends a known no to the check and everything else straight to the join.
4. **Buyer Click Check** (`buyer_click_check`) decides whether the buyer may be offered this lead now: its profile is enabled, the state, debt and loan amount are in its box, it is inside its hours, and today's clicks are under its cap. It routes `eligible` or `not_eligible` with the reason. It has a 300 ms budget and runs only on known no leads.
5. The join (`route_known_no_end`) goes on to `build_response_body`.
6. **`build_response_body`**: when the gate said known no AND the check routed eligible, the offer is the same Tripoint sell off offer (title, details, Pennie name and logo) at `rate = engineBid`, landing on the check's click URL with `{prospect_id}` replaced by the created prospect's id. Otherwise nothing changes: a known no the check refused is rejected exactly as today. The decision is on its output as `click_offer` (offered or not, and why).
7. **`patch_prospect_body`** writes the buyer's own facts from the check: `ExternalPartnerName__c` (its name), `ExternalRoutingCode__c` (its routing code, 4), `ExternalDebtAmount__c` = enrollableDebt, `ExternalExchangeStatus__c` Bid, `BidStatus__c` Bid, `BidAmount__c` = the offer rate, and keeps `Tripoint_Response__c` from Tripoint's decline.
8. The sighting records the buyer as the winner and adds a `lead_sighting_bids` row for it with `resolver_type` `click` (offered, sold on click) beside Tripoint's decline.

**Liberty1's buyer profile ships disabled**, so after the paste this path offers nothing: every known no reaches the check, which routes `not_eligible` with reason `profile_disabled`, and the lead is rejected as today. Enabling the profile on the Liberty1 partner page is the switch that turns offers on; disabling it again turns them off at once.

## Before the paste

1. **The #1540 `tripoint_ping` is on the canvas.** The gate reads `tripoint_answer`, which only the #1540 script emits. Until it is pasted the gate sees no answer and says not a known no on every lead, which is safe and offers nothing. Confirm it the same way as any paste: the hourly drift check records `tripoint_ping` as `agree` in `job_runs` (`engine-script-drift`).
2. **The Liberty1 partner exists** on the Partners page, as a Buyer, with its buyer profile sold on click, left disabled. None existed on 2026-09-24. Its facts are what the check emits, so set them there, not on the canvas: name `Liberty1`, click URL `https://trypennie.com/portal/libertyone/{prospect_id}` (the `{prospect_id}` placeholder is required: the profile cannot be enabled without it, and should one ever reach the check, the check routes `not_eligible` as `click_url_has_no_prospect_id` and pages), external routing code `4`, and on the profile engineDebt of at least 20000, loan amount of at least 2500, every state but ND, Monday to Friday 8am to 6pm Pacific, no holidays, 50 clicks a day.
3. **The Worker carrying this change is deployed**, so the sighting records the offer (`bid-log.ts`) and the drift check knows the gate.

## The paste, in order

Every step below is safe to save on its own: until both scripts are pasted the old `build_response_body` never reads the check, and until the gate is on the canvas the new one behaves as today. One save at the end is still the tidiest.

1. **Add a Code node** below Tripoint Ping. Namespace `known_no_gate`, label `Known No Gate`, timeout 150 ms, retries 2. Paste [`apps/worker/src/engine/scripts/engine-bidding/known_no_gate.js`](../../../apps/worker/src/engine/scripts/engine-bidding/known_no_gate.js) in full into its script box.
2. **Add a Branch** after it. Namespace `route_known_no`, label `Route Known No`. One arm, labelled `known_no`, with one condition: field `steps.known_no_gate.output.known_no`, operator is true. Else behaviour: output (the `else` handle). The canvas adds its join node; name it `route_known_no_end`.
3. **Add a Buyer Click Check node** on the `known_no` arm. Namespace `buyer_click_check`, label `Buyer Click Check`, and:

   | Field | Value |
   |---|---|
   | Partner | Liberty1 (pick it; the canvas refuses to save the workflow live while it is empty) |
   | Population | `engine` |
   | State | `{{trigger.payload.personalInformation.state}}` |
   | Debt | `{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}` |
   | Loan amount | `{{trigger.payload.loanInformation.loanAmount}}` |

   The three templates were checked against the live definition: buyer_select already reads the state and engineDebt at these paths, and `prospect_body` reads `loanInformation.loanAmount` from the same payload.
4. **Rewire.** Remove these two live edges:
   - Tripoint Ping to Build Response Body;
   - Buyer Select `no_sale` to Build Response Body.

   Then connect:
   - Tripoint Ping to Known No Gate;
   - Buyer Select `no_sale` to Known No Gate;
   - Known No Gate to Route Known No;
   - Route Known No `known_no` to Buyer Click Check;
   - Route Known No `else` to Route Known No End;
   - Buyer Click Check `eligible` to Route Known No End, and `not_eligible` to Route Known No End (both handles must be wired, or a run that takes the unwired one fails);
   - Route Known No End to Build Response Body.

   Leave Buyer Select `sold` going straight to Build Response Body, and its `output`, `not_applicable` and `deferred` handles going to Tripoint Ping.
5. **Paste `build_response_body`** ([file](../../../apps/worker/src/engine/scripts/engine-bidding/build_response_body.js)) and **`patch_prospect_body`** ([file](../../../apps/worker/src/engine/scripts/engine-bidding/patch_prospect_body.js)) in full, into their existing nodes. These two files also carry the #1416 changes that have been awaiting their paste since 2026-09-22 (the sale read from whichever node decided, no Tripoint literal); the byte for byte tests prove every lead Tripoint decides gets exactly today's response and patch.
6. **Save.**

## Checking it landed

1. **The drift check.** Within the hour, `job_runs` for `engine-script-drift` records `known_no_gate`, `build_response_body` and `patch_prospect_body` as `agree`. Until the gate node exists it records `known_no_gate` as awaiting its first paste, never as a missing node. After it agrees, remove `newNodeSince` from its entry in `KEPT_ENGINE_SCRIPTS` in a PR, so a node deleted later pages as missing.
2. **A Test Runner run.** Use a saved payload that is NOT a sell off (or has a zero bid): `tripoint_ping` calls Tripoint for real on a test run too, so a sell off test payload sends a lead to Tripoint. Expect: `known_no_gate` output `{"known_no": false, "decided_by": "tripoint_ping", "answer": "skipped"}`, `route_known_no` routed `else`, `buyer_click_check` not run, `build_response_body` output carrying `click_offer` with reason `not_a_known_no`, and the same response as before the change.
3. **Live leads, profile still disabled.** On an execution where Tripoint declined (`tripoint_ping` output `tripoint_answer` `declined`): `known_no_gate` says `known_no: true`, `buyer_click_check` ran and routed `not_eligible` with reason `profile_disabled`, `build_response_body`'s `click_offer` is `{"known_no": true, "check_route": "not_eligible", "offered": false, "reason": "profile_disabled"}`, and Engine got today's reject. On an execution Tripoint accepted, the check never ran.
4. **After enabling the profile.** The first known no inside Liberty1's hours and box gets an offer whose `click_url` is `https://trypennie.com/portal/libertyone/<prospect id>`; the prospect in Salesforce shows `ExternalPartnerName__c` Liberty1, `ExternalRoutingCode__c` 4, `ExternalExchangeStatus__c` Bid and Tripoint's `Tripoint_Response__c`; the lead sighting names the Liberty1 partner's slug as the winner.

## Rollback

Disable Liberty1's buyer profile: offers stop on the next lead, with no canvas change. To remove the path itself, restore the two removed edges and delete the four nodes; the pasted scripts behave as today without them.
