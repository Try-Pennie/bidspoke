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
pages only on a drift or a missing node. Its first `agree` after a paste is the
confirmation the paste landed. When a kept file is re-derived from a newer
canvas, update its `canvasBaselineSha256` and `baselineReadOn` in the same
change. The worker bundles these files as text (a wrangler `[[rules]]` entry and
the vitest plugin in `vitest.config.ts`); nothing runs them at runtime.

| File | Node | What changed for the cutover |
| --- | --- | --- |
| `tripoint_ping.js` | Tripoint Ping | Two fields added, nothing removed: `sale` (the outcome in the buyer_select node's shape, carrying Tripoint's own name, click URL, routing code 2 and Success, Duplicate or Fail class, because this script IS Tripoint, #1416) and `sent_body_sha256` (the hash of exactly what was sent, as the node computes `would_send_body_sha256`; null when nothing was sent or the sandbox has no Web Crypto). |
| `build_response_body.js` | Build Response Body | Reads the sale from `tripoint_ping` if it ran, else from `buyer_select`, completes an older Tripoint Ping's sale with Tripoint's values (transitional, removed at Stage C), and publishes the normalised sale on its output. A sold lead lands on the sale's click URL, never on a constant (#1416); a sell off lead nobody bought takes the Pennie pages. The zero bid early return is untouched. Every rejection also carries `reject_patch` (#1471): `BidStatus__c` and `RejectionReason__c` as the Salesforce node writes them today, plus `Tripoint_Response__c` with the sale's class when Tripoint declined with one; a rejection with no class carries the two fields alone. |
| `patch_prospect_body.js` | Patch Prospect Body | Reads the sale from `build_response_body`'s output. The four External fields (partner name, debt, routing code, exchange status) come from the sale on every accepted sale, whichever buyer; `TripointLeadID__c` and `Tripoint_Response__c` are written only when Tripoint is the buyer, because Salesforce has no field for another buyer's reference or class yet. |

**Paste all three in one canvas save.** `patch_prospect_body` reads the sale
from `build_response_body`, so it must never sit beside the older
`build_response_body`; and both read an older `tripoint_ping` (with or without
its `sale`) through the transitional completion in `build_response_body`, so an
older Tripoint Ping beside the new pair changes nothing. One save covers all
three nodes and leaves no partial state; the hourly drift check confirms each
one afterwards.

One canvas change is not a paste and has an order (#1471): AFTER
`build_response_body` is pasted, set the `patch_prospect_reject` Salesforce
node's body to `{{steps.build_response_body.output.reject_patch}}`, replacing
its two templated fields. Done the other way round the body would resolve to
nothing on every rejection until the paste. The drift check does not cover a
Salesforce node's body, so confirm it by reading the node after saving.

## Tests

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
