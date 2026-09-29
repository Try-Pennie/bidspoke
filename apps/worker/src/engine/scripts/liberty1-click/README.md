# Liberty1 click workflow scripts

The four code node scripts of the Liberty1 click workflow (#1545), which replaces Brian's Pipedream flow `eoltut7tgps3yat`. What the workflow does, every route's outcome, and what Dan and Brian each do to go live: [docs/workflows/liberty1-click/README.md](../../../../../../docs/workflows/liberty1-click/README.md).

A file here is exactly what is pasted into the node's script box, byte for byte, and [`docs/workflows/liberty1-click/definition.json`](../../../../../../docs/workflows/liberty1-click/definition.json) carries the same text: `engine/__tests__/liberty1-click-workflow.test.ts` fails if the two differ. Change a script here, then regenerate the matching `script` value in the definition.

| File | Node | What it does |
| --- | --- | --- |
| `resolve_click_input.js` | `resolve_input` | Queries the prospect from `Prospect__c`, else the submission from `Submission__c` with its Lead and its prospect's fields through `Prospect__r`. Refuses anything that is not a 15 or 18 character id, because the id goes into SOQL. |
| `pick_click_record.js` | `pick_record` | Which record the click sends and whether it may: a prospect judged on its Liberty1 offer, or a submission with no prospect trusted and mapped with Brian's `submissionAsProspect` (2026-09-29). Names the claim key and the records to write. |
| `build_liberty1_request.js` | `build_request` | Brian's `buildPayload` and his DV1 or DI4 route, unchanged, over the picked record. Pure: `click_send` posts it. |
| `liberty1_click_patch.js` | `click_patch` | Brian's Prospect, Submission and Lead update bodies. Completed only on `sent`, Fail only on `refused`, nothing on any other route. |

## Tests

- `../__tests__/liberty1-click-scripts.test.ts` runs each script the way the sandbox does and compares it with Brian's own functions (`../__tests__/liberty1-pipedream-oracle.ts`) over invented prospect records (`../__tests__/fixtures/liberty1-prospects.json`) and invented submissions with no prospect (`../__tests__/fixtures/liberty1-submissions.json`). The request body and route are compared with his verbatim code; the update bodies with a transcription of his update step, which reached us summarised rather than as code.
- `engine/__tests__/liberty1-click-workflow.test.ts` walks `definition.json` through the engine with the real branch and response nodes and these scripts.
- `apps/web/src/lib/__tests__/liberty1-click-definition.test.ts` runs the canvas's save checks over the definition.

## Drift

The hourly `engine-script-drift` check watches this folder as the Liberty1 click workflow in `KEPT_CANVAS_WORKFLOWS` (`apps/worker/src/lib/engine-script-drift.ts`). Its id is in `LIBERTY1_CLICK_WORKFLOW_ID` since the first save (#1547), so a canvas script that differs from its file pages as a drift. These scripts were written here first, so there is no older canvas script to call a paste awaited.
