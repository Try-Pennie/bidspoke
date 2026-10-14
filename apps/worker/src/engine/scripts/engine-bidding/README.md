# Engine Bidding Workflow sale scripts

The three code node scripts of the live Engine Bidding Workflow
(`da82a183-1a4a-417e-b0b8-5f3fe5e14840`) that carry a Tripoint sale from the
buyer call to Engine's response and to the Salesforce patch, kept here for the
buyer_select cutover (#1414, Phase 7) so they are tested before they are pasted.

**The canvas is the source of truth.** Every save mirrors the definition to
`Try-Pennie/bidspoke-workflows`; these files were read from that mirror on
2026-09-22 and edited here. A file in this folder is exactly what is pasted into
the node's script box, byte for byte. A change to a live script that is not mirrored back here is a
drift the tests cannot see (L454), so the hourly `engine-script-drift` check
(`apps/worker/src/lib/engine-script-drift.ts`, #1472) reads the mirror and
compares each file with the code node of the same namespace. Per script it
records one of three states in `job_runs`: `agree`, `awaiting_paste` (the canvas
still holds the script the file was derived from, whose hash is recorded beside
the file in `KEPT_ENGINE_SCRIPTS`) or `drift` (the canvas matches neither), and
pages only on a drift or a missing node. The same run (#1662) compares the
outcome deciding settings of `buyer_click_check` and `route_known_no`
(`docs/workflows/engine-bidding/liberty1-wiring.json`), of `buyer_select`
(`docs/workflows/engine-bidding/buyer-select.json`) and of the four Salesforce
nodes `create_prospect`, `prospect_trades`, `patch_prospect` and
`patch_prospect_reject` (`docs/workflows/engine-bidding/salesforce-nodes.json`,
version 104, #1666) with the canvas, and pages a
difference naming the setting and both values; `buyer_select`'s mode is judged
against the modes the node accepts, so moving it between decide_only and live is
not a finding. Its first `agree` after a paste is the
confirmation the paste landed. When a kept file is re-derived from a newer
canvas, update its `canvasBaselineSha256` and `baselineReadOn` in the same
change. The worker bundles these files as text (a wrangler `[[rules]]` entry and
the vitest plugin in `vitest.config.ts`); nothing runs them at runtime.

| File | Node | What changed for the cutover |
| --- | --- | --- |
| `tripoint_ping.js` | Tripoint Ping | Two fields added, nothing removed: `sale` (the outcome in the buyer_select node's shape, carrying Tripoint's own name, click URL, routing code 2 and Success, Duplicate or Fail class, because this script IS Tripoint, #1416) and `sent_body_sha256` (the hash of exactly what was sent, as the node computes `would_send_body_sha256`; null when nothing was sent or the sandbox has no Web Crypto). Two more added last on every return by #1540: `tripoint_answer` (accepted, declined, in_progress for 1009, invalid_data and null_id_fault for the two known 502 answers, skipped, or unknown) and `unknown_reason`. Unknown is anything not positively recognised (any other 5xx, any 4xx, a 2xx that does not parse, is not ok or has no result code, a fetch that throws, and a call aborted after 15 s); it no longer throws, it returns a no sale that `build_response_body` rejects normally. |
| `build_response_body.js` | Build Response Body | Reads the sale from `tripoint_ping` if it ran, else from `buyer_select`, completes an older Tripoint Ping's sale with Tripoint's values (transitional, removed at Stage C), and publishes the normalised sale on its output. A sold lead lands on the sale's click URL, never on a constant (#1416); a sell off lead nobody bought takes the Pennie pages. The zero bid early return is untouched. Every rejection also carries `reject_patch` (#1471): `BidStatus__c` and `RejectionReason__c` as the Salesforce node writes them today, plus `Tripoint_Response__c` with the sale's class when Tripoint declined with one; a rejection with no class carries the two fields alone. |
| `patch_prospect_body.js` | Patch Prospect Body | Reads the sale from `build_response_body`'s output. The four External fields (partner name, debt, routing code, exchange status) come from the sale on every accepted sale, whichever buyer; `TripointLeadID__c` and `Tripoint_Response__c` are written only when Tripoint is the buyer, because Salesforce has no field for another buyer's reference or class yet. |
| `known_no_gate.js` | Known No Gate (new, #1544) | Written here first, for a node the canvas did not have; on the canvas since version 101 (2026-09-29). Says whether the node that decided the lead gave a KNOWN no (tripoint_ping's `tripoint_answer` declined, invalid_data or null_id_fault; buyer_select no_sale declined_by_buyer that can be told from Tripoint's 1009, #1653), read by the same precedence `build_response_body` reads its sale by; both nodes' answers are judged by one list in tripoint_ping's words. The Branch after it sends a known no to the buyer_click_check node. #1653 edited it here first, so it carries the version 103 canvas script's hash as its baseline until that paste. |

**#1544 (a click sold buyer on a known Tripoint no)** changed `build_response_body` (a
known no the buyer_click_check node found eligible is offered to that buyer: the
Tripoint sell off offer at engineBid, landing on the check's click URL with the prospect
id, its sale published as `sale` with `sold_on: 'click'`, Tripoint's decline beside it as
`declined_sale`, and the decision as `click_offer`) and `patch_prospect_body` (keeps
`Tripoint_Response__c` from that decline). Every partner fact comes from the check's
output. The paste order and the canvas wiring are in
[`docs/workflows/engine-bidding/liberty1-wiring.md`](../../../../../../docs/workflows/engine-bidding/liberty1-wiring.md);
the gate and the check go on the canvas BEFORE the two scripts are pasted.

**#1549 (one list of Tripoint duplicate result codes)** changed `tripoint_ping` and
`build_response_body`: a declined Tripoint answer is Duplicate on 1002, 1003, 1004,
1005 and 1020, the list `TRIPOINT_DUPLICATE_RESULT_CODES` in `bid-resolver.ts` that
the sightings already used. Before it the two scripts said 1003, 1004 and 1020, so a
1002 or 1005 reached Salesforce's `Tripoint_Response__c` as Fail. The scripts cannot
import, so `../__tests__/tripoint-duplicate-codes.test.ts` holds both literals to the
list on every code from 990 to 1100. Both were pasted in one save, Engine Bidding
version 103 (2026-09-30 14:43 UTC), and their drift baselines cleared after.

**#2089 (the signed link token)** changed `build_response_body` only: the offer link,
whichever page or buyer it lands on, gets `?t=<token>` (or `&t=`) when its host is
`trypennie.com` or `www.trypennie.com`, signed with `LINK_TOKEN_SECRET` exactly as
Salesforce and trypennie.com sign it. A partner's domain never gets the token. The step
output carries `link_token` (`signed`, `missing_secret`, `not_our_host`, `no_record_id`
or `sign_failed`), and nothing fails the bid. The helper block between the
`BEGIN`/`END link token (#2089)` markers is identical in Lead Economy's
`../lead-economy/return_response.js`, and `../__tests__/link-token.test.ts` holds the two
to one text and pins the token to the issue's worked example. It is pasted on its own:
no other script reads the new field. The drift check reads it as awaiting paste (its
baseline is the version it was derived from, read on 2026-10-14) until the paste lands;
clear the baseline in the change after.

**Paste all three in one canvas save.** `patch_prospect_body` reads the sale
from `build_response_body`, so it must never sit beside the older
`build_response_body`; and both read an older `tripoint_ping` (with or without
its `sale`) through the transitional completion in `build_response_body`, so an
older Tripoint Ping beside the new pair changes nothing. One save covers all
three nodes and leaves no partial state; the hourly drift check confirms each
one afterwards.

The #1540 `tripoint_ping` could be pasted on its own, once the Worker carrying
#1540 was deployed. It changes no field the other two read (an unknown answer is
a sale with no class, which both already reject), and with it on the canvas a
Tripoint outage no longer fails runs: the aggregated Tripoint outage page counts
`tripoint_ping` steps answered `unknown` (`lib/upstream-outage.ts`). It has been
on the canvas since version 101. Of the kept Engine scripts only
`build_response_body` carries a baseline, until its #2089 paste lands (see above);
for the other three any difference from the canvas is a drift.

One canvas change is not a paste and has an order (#1471): AFTER
`build_response_body` is pasted, set the `patch_prospect_reject` Salesforce
node's body to `{{steps.build_response_body.output.reject_patch}}`, replacing
its two templated fields. Done the other way round the body would resolve to
nothing on every rejection until the paste. The drift check does not cover a
Salesforce node's body, so confirm it by reading the node after saving.

## Tests

`../__tests__/engine-bidding-liberty1.test.ts` covers #1544: the gate over every
Tripoint answer and every buyer_select reason (Stage A and Stage B), the offer and
the patch, and every path that must stay a reject. `../../__tests__/engine-bidding-liberty1-walk.test.ts`
walks the live tail excerpt (`../__tests__/fixtures/engine-bidding-tail-v100.json`)
with the wiring in `docs/workflows/engine-bidding/liberty1-wiring.json` applied.

`../__tests__/engine-bidding-sale.test.ts` runs each script through the same
wrapper the sandbox builds (`../__tests__/canvas-script.ts`, mirroring
`lib/code-node-deployer.ts`). For every legacy arm (not sell off, zero bid,
sold 1001, declined 1003, the null id 502 fault, the invalid 502 rejection) the
Engine response body and the Salesforce patch body are asserted byte for byte
against `../__tests__/fixtures/expected-live-2026-09-22.json`, which holds what
the LIVE scripts produced over the same inputs. For every node arm (sold,
no_sale, not_applicable, deferred, zero bid) the bodies equal the legacy arm they
correspond to. The inputs are `../__tests__/fixtures/engine-lead.json`, a
synthetic lead; the Tripoint answers are the captured fixtures in
`packages/buyer-profile/fixtures/tripoint/`.

Measured on 2026-09-22 (issue #1414): a declined sell off lead is rejected by
`build_response_body` and never reaches `patch_prospect_body`, so the four
External fields are written only on an accepted sale, and the Duplicate mapping
has no live path to it. Both are preserved as they are.
