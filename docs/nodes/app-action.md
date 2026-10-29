# App Action node

Runs one action from the service catalogue (`packages/service-catalogue`): post a Slack message, query or write Salesforce, append a Google Sheets row, send a Gmail message, run a Snowflake statement and the rest. Its node `type` is `app_action`. It runs only in an ops workflow; a money workflow refuses it on every save, and the bidding engine never runs it.

On the canvas its card names the service with its own mark (Google Drive's for a Drive action; a plain box for a service whose mark the build does not hold yet) and the action in a chip beside it, then the step's name and step id (settled in [the card's design](../design/app-action-node-card.html)). It has no palette entry yet (#2339). Its step form is `apps/web/src/components/canvas/AppActionConfig.tsx`, whose data picker reads the trigger's test payload and each earlier step's kept test result (a step's test is described in the repo's `docs/ops-worker.md`, "Testing a step").

## Config schema

`node.config`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `service` | string | Yes | The catalogue service, for example `slack`. |
| `action` | string | Yes | The action's key, which starts with the service, for example `slack.send-message`. |
| `actionVersion` | number | Yes | The version of the action the step was saved on. The step runs exactly this version, never a newer one. |
| `connection` | string | Yes | The id of the saved connection the step sends through. A name is not accepted. |
| `args` | object | Depends on the action | The action's arguments, by the names that version declares. |

Each argument holds text as entered. Where the action allows it, an argument may refer to the trigger or an earlier step with `{{ }}` (see [data references](../concepts/data-references.md)). An argument the catalogue reads as JSON may hold the JSON as text or as the value itself, and a whole reference such as `{{steps.load.output.rows}}` may stand for it.

## What is checked at save

- On every save: a version the catalogue does not have is refused by name, never saved on the newest; so are an argument that version does not declare, text where JSON is expected and does not parse, a reference in an argument that allows none, a connection that is not a connection id, and an action of another service than the step names.
- On a live save only: a step that has not chosen its action, pinned a version, chosen a connection, or filled every required argument. A switched off draft may be saved part way. Such a step is unfinished, and a workflow holding one cannot be switched on, saved live or restored onto a live workflow (`unfinishedAppActionSteps`, read through `blockingProblems`, #2781).
- On every save, the step is stamped with whoever bound it, `boundBy` (`apps/worker/src/lib/app-action-binders.ts`), which a run checks (below).

## What a run does

Its ops executor is `apps/worker/src/ops/app-action.ts`, run by `run-walk.ts`. It runs the one catalogue action at the version the step pinned, never the newest (D1), through the connection the step names. A step on a person's own account runs only when whoever bound it (`boundBy`) owns the connection, and is refused by name otherwise (#2753).

The step reads its connection, resolves its arguments against the run, and runs the action. Every request the action makes is written to the run's send ledger before it is sent and then goes through the connection, which applies the login after the record is written. Nothing the run stores or logs holds the login, and a service that echoes it back has it removed from the answer before the action sees it.

The action is handed a request id that is the same on every attempt of the run. The Snowflake actions send it with `retry=true`, so Snowflake runs a resent statement once.

How a failure ends the run:

- the connection sent nothing, the service refused the request, or the request was applied and then failed: the run fails, naming the cause;
- the outcome is unknown (a lost connection, a timeout, a 5xx): an idempotent action is tried again; any other goes to a person as `needs_human`, because sending it again might apply it twice.

## Output

The action's own result, whose shape is part of the action's version: for example `slack.send-message` returns Slack's answer, and `snowflake.execute-sql-query` returns one object per row.
