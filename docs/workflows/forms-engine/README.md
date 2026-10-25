# Forms <> Engine <> Data Store (Loan only)

[`definition.json`](./definition.json) is the live workflow (`ff1a9f52-7346-452a-bab7-af9f95d36dda`)
as read from the mirror on 2026-10-15, with one change for #2092: a code node,
`sign_submission_link`, between "Send to Slack Geoff" and "Send to Slack Agent", and the
agent webhook's `submission_link` set to `{{steps.sign_submission_link.output.url}}`.
Its script is the kept file
[`apps/worker/src/engine/scripts/forms-engine/sign_submission_link.js`](../../../apps/worker/src/engine/scripts/forms-engine/sign_submission_link.js),
and a test fails if the two ever differ.

In this copy the two Slack webhook nodes read their URLs from the secret environment
variables `SLACK_TRIGGER_FORMS_GEOFF` and `SLACK_TRIGGER_FORMS_AGENT` (#2777), and a
Slack hook URL is never written into a committed file again (`no-slack-hook-urls.test.ts`).
The live workflow still holds the trigger URLs themselves, which became public with the
repository on 2026-10-25 and stay readable in its history. Dan decided that day not to
replace them, since the most a trigger allows is a message in Slack (#2780).

The flow posts a form lead to Engine. When Engine refuses it, the flow answers the form
with Engine's error, looks up the lead's agent in Salesforce, and posts two Slack
messages: one to Geoff and one to the agent with a link to the person's submission. That
link is signed with the link token, because trypennie.com refuses an unsigned link to a
submission created after its cutoff. When Engine accepts it, the flow stores Engine's
id and writes it to the Submission; no link is built.

The flow had no run in Bidspoke on 2026-10-15, so the signed link is proven only by
`apps/worker/src/engine/__tests__/forms-engine-workflow.test.ts`, which walks this
definition through the engine.
