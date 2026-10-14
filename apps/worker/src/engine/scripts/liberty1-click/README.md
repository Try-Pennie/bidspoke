# Liberty1 click workflow scripts

The four code node scripts of the Liberty1 click workflow (#1545), which replaces Brian's Pipedream flow `eoltut7tgps3yat`. What the workflow does, every route's outcome, and what Dan and Brian each do to go live: [docs/workflows/liberty1-click/README.md](../../../../../../docs/workflows/liberty1-click/README.md).

A file here is exactly what is pasted into the node's script box, byte for byte, and [`docs/workflows/liberty1-click/definition.json`](../../../../../../docs/workflows/liberty1-click/definition.json) carries the same text: `engine/__tests__/liberty1-click-workflow.test.ts` fails if the two differ. Change a script here, then regenerate the matching `script` value in the definition.

| File | Node | What it does |
| --- | --- | --- |
| `resolve_click_input.js` | `resolve_input` | Queries the prospect from `Prospect__c`, else the submission from `Submission__c` with its Lead and its prospect's fields through `Prospect__r`. Refuses anything that is not a 15 or 18 character id, because the id goes into SOQL. |
| `pick_click_record.js` | `pick_record` | Which record the click sends and whether it may: a prospect judged on its Liberty1 offer, or a submission with no prospect trusted and mapped with Brian's `submissionAsProspect` (2026-09-29). Names the claim key and the records to write. |
| `build_liberty1_request.js` | `build_request` | Brian's `buildPayload` over the picked record, `consentsToTcpa` always true, plus `debtAmount` from `EngineDebt__c` (#2110), returning the body and the lead's state. Where it goes is not here (#1671): `click_send` picks the route from Liberty1's buyer profile Click delivery by that state. Pure: `click_send` posts it. |
| `liberty1_click_patch.js` | `click_patch` | Brian's Prospect, Submission and Lead update bodies. Completed only on `sent`, Fail only on `refused`, nothing on any other route. |

## Tests

- `../__tests__/liberty1-click-scripts.test.ts` runs each script the way the sandbox does and compares it with Brian's own functions (`../__tests__/liberty1-pipedream-oracle.ts`) over invented prospect records (`../__tests__/fixtures/liberty1-prospects.json`) and invented submissions with no prospect (`../__tests__/fixtures/liberty1-submissions.json`). The request body is compared with his verbatim code, and the route with his `pickRoute`: the state the script returns is put through the node's own route choice over a snapshot of Liberty1's profile delivery (`../__tests__/fixtures/liberty1-click-delivery.json`, read 2026-09-30), which must land on the LeadConnector trigger of his route (`CANVAS_ROUTES`, which are not his); the update bodies with a transcription of his update step, which reached us summarised rather than as code.
- `engine/__tests__/liberty1-click-success-pattern.test.ts` runs LeadConnector's real success reply and the answers that must never count (`../__tests__/fixtures/liberty1-leadconnector-replies.json`) through the node's response reader and classifier with the success line from Liberty1's profile delivery snapshot (`../__tests__/fixtures/liberty1-click-delivery.json`), since #1671 the only home of that line.
- `engine/__tests__/liberty1-click-workflow.test.ts` walks `definition.json` through the engine with the real branch and response nodes and these scripts.
- `apps/web/src/lib/__tests__/liberty1-click-definition.test.ts` runs the canvas's save checks over the definition.

## Read outside the canvas

`liberty1_click_patch.js` is also what a held click marked sent on the partner page writes (#1659). `lib/click-sale-updates.ts` builds the same three bodies in TypeScript and reads the consent text and lead sale type out of this file (the constants its Prospect body names for `TCPA_Consent__c` and `LeadSaleType__c`), and `lib/__tests__/click-sale-updates.test.ts` runs this script and requires the builder's bodies byte for byte. So keep the consent one plain template literal and the sale type one double quoted string; anything else is refused by name and the hand path writes nothing.

## Drift

The hourly `engine-script-drift` check watches this folder as the Liberty1 click workflow in `KEPT_CANVAS_WORKFLOWS` (`apps/worker/src/lib/engine-script-drift.ts`). Its id is in `LIBERTY1_CLICK_WORKFLOW_ID` since the first save (#1547), so a canvas script that differs from its file pages as a drift. These scripts were written here first, and the canvas holds all four as kept (the #1671 `build_request` was pasted as version 15 on 2026-09-30), so none has a baseline: any difference is a drift.
