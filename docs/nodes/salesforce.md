# Salesforce node

Reads from and writes to Salesforce through its REST API as a workflow step. Handles OAuth token acquisition for you and supports create, update, upsert, query, and Apex REST operations, with first-class handling for Salesforce dedup validation errors.

## Purpose

The Salesforce node calls the Salesforce REST API (v60.0). It obtains an access token via the Client Credentials OAuth flow, caches the token, and then runs your chosen operation against the target object. Body, record IDs, external ID values, and SOQL are all template-enabled, so you can build the request from the trigger payload and upstream step outputs. See [data references](../concepts/data-references.md).

A common pattern is treating a Salesforce dedup/validation rejection as an expected business outcome rather than a failed run. The `expected_errors` config does exactly that (see Expected errors below).

## Required environment variables

The node needs these env vars (Bidspoke env vars or Cloudflare secrets). It throws if any are missing:

| Variable | Description |
|----------|-------------|
| `SALESFORCE_INSTANCE_URL` | Your instance, for example `https://trypennie.my.salesforce.com`. |
| `SALESFORCE_CLIENT_ID` | Connected app client ID. |
| `SALESFORCE_CLIENT_SECRET` | Connected app client secret. |

The access token is cached for about 58 minutes. On a `401` the cached token is evicted so the next attempt re-authenticates.

## Config schema

`node.config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `operation` | string | Yes | `create` | One of `create`, `update`, `upsert`, `query`, `apex`. |
| `object` | string | For create/update/upsert | none | SObject API name, for example `Prospect__c`. Not used for `query` or `apex`. |
| `body` | any | For create/update/upsert/apex | none | Request body. Template-enabled JSON. For create/update/upsert a text body is rendered then parsed (see Text bodies below). |
| `record_id` | string | For `update` | none | Salesforce record ID to update. Template-enabled. |
| `external_id_field` | string | For `upsert` | none | External ID field API name. |
| `external_id_value` | string | For `upsert` | none | External ID value. Template-enabled. |
| `soql` | string | For `query` | none | SOQL query string. Template-enabled. |
| `apex_path` | string | For `apex` | none | Relative Apex REST path, for example `/services/apexrest/prospect-trades`. |
| `injected_fields` | object | No | none | Map of SF field name to template value, merged into `body`. Overrides `body` on key collision. Resolved per run. Handy for `{{execution.bidspoke_link}}`. |
| `omit_fields` | array of strings | No | none | create/update/upsert: body keys never sent. Applied before `rename_fields`. |
| `rename_fields` | object | No | none | create/update/upsert: map of body key to the field it is sent as. Applied after `omit_fields` and before `injected_fields`, which still win on a collision. Two keys may not be renamed to one field. |
| `skip_when_empty` | boolean | No | `false` | update and Apex POST only: skip the call, with a recorded reason, when there is nothing to write (or, for an update, the record id is empty). See Skipped writes below. |
| `expected_errors` | array | No | none | SF rejections to treat as a business outcome, not a failure (see below). |
| `transient_errors` | array | No | SF concurrency-limit entry | SF errors to retry despite a 4xx status (see below). |

Standard node-config fields (`timeout_ms`, `retries`, `retry_backoff`, `on_error`, `fallback_node`) also apply. The HTTP request itself uses a fixed 15-second timeout. See [workflow definition schema](../concepts/workflow-definition-schema.md).

### Operations

| Operation | Method | Endpoint built |
|-----------|--------|----------------|
| `create` | POST | `/services/data/v60.0/sobjects/<object>` |
| `update` | PATCH | `/services/data/v60.0/sobjects/<object>/<record_id>` |
| `upsert` | PATCH | `/services/data/v60.0/sobjects/<object>/<external_id_field>/<external_id_value>` |
| `query` | GET | `/services/data/v60.0/query?q=<soql>` |
| `apex` | POST | `<apex_path>` |

The config panel offers object and field dropdowns sourced from synced Salesforce schema metadata when a connection's schema is cached, so you can pick the SObject and see its fields while building the body.

### Text bodies, omitted and renamed fields (#2170)

These reproduce what the Pipedream Submission relay did with Main Flow's posts, so a post moved off the relay sends the same thing.

- **Text body.** When `body` is a string (the canvas stores the body as text whenever it is not valid JSON before its references are filled in), it is rendered by the same template resolution the Webhook node uses for a text body, then parsed as JSON. Inside quotes a missing reference becomes `""`, a null becomes the string `"null"` and a number stays a string, exactly the text the relay received. A body that is a single reference resolving to an object is used as it is, as before. Rendered text that is not valid JSON, or JSON that is not an object, fails the step permanently with a message naming the problem, and nothing is sent. Apex bodies are not parsed: an Apex endpoint decides its own body shape.
- **`omit_fields`** drops the listed keys, for example `["submissionId", "executionId"]`, which the relay used only in the URL or never sent.
- **`rename_fields`** sends a key under another name, for example `{ "UUID": "Engine_UUID_SO__c", "leadUUID": "Engine_Lead_UUID_SO__c" }`. A key absent from the body is sent under neither name. Each new name must be shaped like a Salesforce field name (a letter, then letters, digits and underscores). If the body already holds a key under the new name, the renamed value replaces it, as the relay did, and a warning naming both fields goes on the step.

A malformed option (a non-list `omit_fields`, a `rename_fields` that is not a map of names, a `skip_when_empty` on another operation) is refused when the workflow is saved, by the canvas and by the save API, and the step refuses it by name if it ever runs.

### Skipped writes (#2170)

With `skip_when_empty: true`, an update or an Apex POST is skipped rather than sent when:

| Reason | Operation | When |
|--------|-----------|------|
| `nothing_to_write` | update | The body resolves to null or nothing, or is an object left with no keys after `omit_fields` and `rename_fields`. `injected_fields` do not count: they only stamp a write that is happening anyway. |
| `nothing_to_write` | apex POST | The body resolves to null or nothing. An empty object is still sent to any other Apex endpoint. The credit inquiry post has its own rules, below: it is also skipped for an empty or missing `inquiries` list, flag or not. |
| `no_record_id` | update | The record id resolves empty. |

A skipped step makes no Salesforce call at all (not even a token request), completes rather than fails, and records `{ "skipped": true, "skip_reason": "<reason>" }` as its output, the same keys a skipped partner bid records. Without the flag both keep their old behaviour: an update with a missing record id fails the step and one with a null body sends `{}`, and an Apex POST with a null body sends `null`, except the credit inquiry post, which fails the step before any call (below).

### The credit inquiry post

A POST to `/services/apexrest/credit-inquiries` attaches a new file to the Lead on every call that carries inquiries, so it is never sent twice blind (#2172). Whatever the step's config says:

- the engine never retries it (`retries` is read as 0);
- a body whose `inquiriesJson` holds an empty `inquiries` list, or none, is skipped with `nothing_to_write`, flag or not: the endpoint writes nothing for the first and answers 500 for the second;
- a body the endpoint cannot read (no Submission id, or `inquiriesJson` that is not the JSON text of `{ inquiries: [...] }`) fails the step before any call, including a null body without `skip_when_empty`;
- on a live run, the post is recorded in KV before it is sent and cleared on a confirmed answer; one whose outcome is unknown is read back by the Lead's `Inquiries_<leadId>` file and resent at most once ([the write contract](../salesforce-post-answer-write-contract.md), "The credit inquiry post's read-back").

### Expected errors

`expected_errors` lists SF rejections that should not fail the run. Each entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Salesforce `errorCode` to match, for example `DUPLICATE_VALUE` or `FIELD_CUSTOM_VALIDATION_EXCEPTION`. |
| `message_contains` | string | No | Optional substring the SF error message must contain. Omit to match on `code` alone. |
| `response_body` | any | No | Template-enabled body returned to the caller instead of the raw SF error. |
| `response_status` | number | No | HTTP status for `response_body`. Defaults to `200`. |

When an SF error matches, the step is marked completed (not failed) and the workflow exits at this node. If `response_body` is set, that body is returned to the original caller; otherwise the run simply exits. This is the standard dedup pattern: a duplicate is a normal outcome, so the lead is rejected cleanly instead of erroring.

### Transient errors

By default the engine retries only `429` and `5xx`. `transient_errors` opts specific SF `errorCode`s back into retry even on a 4xx. Each entry is `{ code, message_contains? }`, matched the same way as `expected_errors`. New Salesforce nodes are pre-populated with one entry, `{ code: "REQUEST_LIMIT_EXCEEDED", message_contains: "Concurrent" }`, because SF concurrency limits return a 403 but clear within seconds. Clearing the list (saving an empty array) keeps it empty.

### Malformed email handling (always on, no config)

A lead email carrying a stray character (a curly apostrophe, an accent) makes Salesforce answer `INVALID_EMAIL_ADDRESS` with a 400, which is permanent, which used to kill the whole run before any bidding. Three leads were lost that way in the 30 days to 2026-08-01 (#723).

**A malformed email is dropped, never rewritten** (#742). The body goes out byte-identical: no quote rewriting, no trimming, no character folding, so the address the lead actually sent is what Salesforce judges. When Salesforce answers `INVALID_EMAIL_ADDRESS`, the fields it names in `fields[]` are blanked and the write is retried once, so the record still lands with the phone number intact. A warning on the step names the field and the dropped value, so it shows in the execution detail rather than being swallowed.

The blanking happens on the error path on purpose: that is the only point at which the field is known to be an email, because Salesforce named it. A value like `Referrer__c: "some@thing"` is address-shaped and invalid too, so acting on shape alone before the call would destroy real data in a field the node merely guessed about.

The retry is narrow by design. It takes its own Salesforce bulkhead slot, runs once, is limited to `create` / `update` / `upsert` (never `apex`, whose side effects may already have fired), and fires only for `INVALID_EMAIL_ADDRESS`, so any other field-level rejection (a validation rule, for instance) surfaces its own message unchanged. If the retry also fails, the original Salesforce error is what surfaces, so diagnostics never degrade.

An `expected_errors` entry for `INVALID_EMAIL_ADDRESS` takes precedence, so a workflow that wants to exit on it still does.

**When nothing reachable survives:** if blanking would leave a record with no phone number of at least 10 digits, there is no retry. The step fails with an explicit reason ("no usable contact method") naming the rejected value, rather than an opaque Salesforce 400.

**Accepted tradeoff:** every malformed address now costs one extra Salesforce call (the rejection, then the retry), and those leads reach Salesforce with a phone but no email, so no email outreach is possible on them.

## Output shape

On success:

```json
{
  "status": 201,
  "body": { "id": "0035g00000ABCDE", "success": true, "errors": [] }
}
```

For `update`, Salesforce returns `204 No Content`, so `body` is `null`. For `query`, `body` is the SOQL result envelope (`{ totalSize, done, records }`). Read downstream as `steps.<namespace>.output.body.id`, `steps.<namespace>.output.body.records`, etc.

When a write is skipped (`skip_when_empty`), the output is `{ skipped: true, skip_reason }` and the run continues.

When an `expected_errors` entry matches, the output is `{ status, ok: false, errorCode, message, body }` and the run exits at this node.

On an unmatched non-2xx, the node throws and the engine classifies the error (transient vs permanent) and applies retry / fallback per the node's settings.

## Edges

The Salesforce node has a single outgoing edge. On success the workflow continues to the next node. On an expected-error match the run exits here. On an unhandled error the engine applies retry / fallback / error handling.

## Example

Create a prospect, treating a duplicate as a clean rejection with a custom response.

```json
{
  "id": "n_create_prospect",
  "namespace": "create_prospect",
  "type": "salesforce",
  "label": "Create prospect",
  "config": {
    "operation": "create",
    "object": "Prospect__c",
    "body": {
      "Email__c": "{{trigger.payload.email}}",
      "FirstName__c": "{{trigger.payload.first_name}}",
      "LastName__c": "{{trigger.payload.last_name}}",
      "LoanAmount__c": "{{steps.parse_lead.output.amount}}"
    },
    "injected_fields": {
      "Bidspoke_Run_Link__c": "{{execution.bidspoke_link}}"
    },
    "expected_errors": [
      {
        "code": "DUPLICATE_VALUE",
        "message_contains": "Email",
        "response_status": 200,
        "response_body": { "status": "duplicate", "message": "Lead already exists" }
      }
    ],
    "transient_errors": [
      { "code": "REQUEST_LIMIT_EXCEEDED", "message_contains": "Concurrent" }
    ]
  }
}
```

An upsert keyed on an external ID:

```json
{
  "id": "n_upsert",
  "namespace": "upsert_account",
  "type": "salesforce",
  "config": {
    "operation": "upsert",
    "object": "Account",
    "external_id_field": "External_Id__c",
    "external_id_value": "{{trigger.payload.account_ref}}",
    "body": { "Name": "{{trigger.payload.company}}" }
  }
}
```

## See also

- [Webhook node](./webhook.md)
- [Code node](./code.md)
- [Data references](../concepts/data-references.md)
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
