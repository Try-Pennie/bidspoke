# Lead Economy scripts

The code node scripts of the live Lead Economy - Bidding Workflow
(`89b1a6af-7e0f-43de-bc66-1e888184551f`) that are kept in the repo. As with
`../engine-bidding/`, **the canvas is the source of truth**: each file is exactly
what is pasted into the node's script box, byte for byte, and the hourly
`engine-script-drift` check (`apps/worker/src/lib/engine-script-drift.ts`) compares
it with the canvas mirror in `Try-Pennie/bidspoke-workflows`.

| File | Node | Why it is kept |
| --- | --- | --- |
| `return_response.js` | Return Response | Builds the offer link Engine receives and Patch Prospect body writes to Salesforce's `OfferLandingPage__c`. Copied from the mirror on 2026-10-14 and changed for #2089 only: the link gets the signed link token (`?t=`) when it lands on trypennie.com, and the step output carries `link_token` saying whether it was signed and, if not, why. A missing `LINK_TOKEN_SECRET` sends the link unsigned and never fails the bid. |

The helper block between the `BEGIN`/`END link token (#2089)` markers is identical
in every script that signs a link: the Engine Bidding Workflow's
`build_response_body.js`, the three RML bidding flows' `build_response.js` and the
Forms flow's `sign_submission_link.js` (#2092). `../__tests__/link-token.test.ts`
holds them to one text and pins the token to the issue's worked example. The block
names no host: `LINK_TOKEN_HOSTS`, set just above it, is `trypennie.com` and
`www.trypennie.com` here.

Dan pasted the #2089 script on 2026-10-14 (2:27 PM ET) and the drift check read it as
`agree` (#2093). #2092 changed the block here first (the host list moved out of it,
and a missing secret logs an error), with nothing the step sends changing, so the
#2089 canvas script is its baseline until that paste reads as `agree`; then clear it.
