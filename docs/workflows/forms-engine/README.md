# Forms <> Engine <> Data Store (Loan only)

[`definition.json`](./definition.json) is the live workflow (`ff1a9f52-7346-452a-bab7-af9f95d36dda`)
as read from the mirror on 2026-10-15, with one change for #2092: a code node,
`sign_submission_link`, between "Send to Slack Geoff" and "Send to Slack Agent", and the
agent webhook's `submission_link` set to `{{steps.sign_submission_link.output.url}}`.
Its script is the kept file
[`apps/worker/src/engine/scripts/forms-engine/sign_submission_link.js`](../../../apps/worker/src/engine/scripts/forms-engine/sign_submission_link.js),
and a test fails if the two ever differ.

The flow posts a form lead to Engine. When Engine refuses it, the flow answers the form
with Engine's error, looks up the lead's agent in Salesforce, and posts two Slack
messages: one to Geoff and one to the agent with a link to the person's submission. That
link is signed with the link token, because trypennie.com refuses an unsigned link to a
submission created after its cutoff. When Engine accepts it, the flow stores Engine's
id and writes it to the Submission; no link is built.

The flow had no run in Bidspoke on 2026-10-15, so the signed link is proven only by
`apps/worker/src/engine/__tests__/forms-engine-workflow.test.ts`, which walks this
definition through the engine.
