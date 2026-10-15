# Forms <> Engine <> Data Store (Loan only) scripts

The one kept code node script of the Forms workflow (`ff1a9f52-7346-452a-bab7-af9f95d36dda`),
added for #2092. The whole workflow, with this node in place, is
[`docs/workflows/forms-engine/definition.json`](../../../../../../docs/workflows/forms-engine/definition.json).

| File | Node | Why it is kept |
| --- | --- | --- |
| `sign_submission_link.js` | Sign Submission Link | When Engine refuses a form lead, the agent's Slack message carries `https://trypennie.com/submit?submission_id=<Submission id>`. trypennie.com refuses that link for a submission created after its cutoff unless it carries the link token, and a webhook node cannot sign, so this node builds the signed link and `send_to_slack_agent` sends `{{steps.sign_submission_link.output.url}}`. A missing secret logs an error and gives the link unsigned; the run is never failed for it. |

The helper block is the one text `../__tests__/link-token.test.ts` holds every signing
script to, with `LINK_TOKEN_HOSTS` set to `trypennie.com` and `www.trypennie.com`.
`apps/worker/src/engine/__tests__/forms-engine-workflow.test.ts` walks the whole
definition through the engine and reads the link out of the body Slack receives.

The node is new on the canvas, so the drift check awaits it (`newNodeSince`) rather
than paging it as missing. Remove that in the change after the paste reads as agree.
