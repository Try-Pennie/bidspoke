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
| `tripoint_ping.js` | Tripoint Ping | Two fields added, nothing removed: `sale` (the outcome in the buyer_select node's shape) and `sent_body_sha256` (the hash of exactly what was sent, as the node computes `would_send_body_sha256`; null when nothing was sent or the sandbox has no Web Crypto). |
| `build_response_body.js` | Build Response Body | Reads the sale from `tripoint_ping` if it ran, else from `buyer_select`, and falls back to the legacy `qualified` field while the older `tripoint_ping` is on the canvas. The zero bid early return is untouched. |
| `patch_prospect_body.js` | Patch Prospect Body | Reads `TripointLeadID__c` and `Tripoint_Response__c` from the same sale, with the same fallback. The click URL test for the four External fields and the Duplicate mapping are untouched. |

The scripts can be pasted in any order: each reads the older shape when the
newer one is absent. `tripoint_ping` can go first and alone, which starts
recording `sent_body_sha256` for the Stage A parity report before the topology
changes.

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
