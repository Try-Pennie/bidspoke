# Environment variables and secrets

How to store configuration and credentials that your workflows read as `env.*`, the difference between plain variables and secrets, and where partner and workflow credentials belong. All of this lives on the Environment Variables page, not in Cloudflare Worker secrets.

Code and Integration nodes read these values through [data references](../concepts/data-references.md) as `env.<KEY>`.

## Plain variables vs secrets

Every entry has a key, a value, and an `is_secret` flag.

- Plain variable (`is_secret: false`) - stored as-is and shown in the UI. Use for non-sensitive config: feature flags, base URLs, default values, lender groupings.
- Secret (`is_secret: true`) - the value is encrypted, masked in the UI as dots, and synced to the Cloudflare Worker so the engine can read it at runtime. Use for anything sensitive: API keys, passwords, OAuth tokens.

Both are read the same way inside a node, as `env.<KEY>`. The only difference is storage and visibility.

## Add a variable

1. Go to the Environment Variables page.
2. Open the New variable form (it can be opened at the top level or inside a folder).
3. Enter the Key (for example `GIGFI_API_KEY`). Keys are uppercase by convention.
4. Enter the Value.
5. Leave Used by on All workflows, or pick the one workflow whose runs should read this value (see below).
6. Check Secret if the value is sensitive. For all workflows the box reads "Secret. Value encrypted and synced to Cloudflare Worker."; for one workflow it reads "Secret. Value encrypted.", because that copy is never synced.
7. Save.

## Reveal a secret

Secrets are masked. To see one, click the reveal control on its row; the value is decrypted on demand and shown. Click again to hide it.

If a secret shows "Rotate to enable reveal", it was created before the encryption key was last rotated and cannot be decrypted for display. Re-save that variable with a fresh value to restore reveal.

## Folders

Variables can be organized into folders. You can create folders (including nested folders), drag variables between them, rename and move folders, collapse them, and sort by most-recently-used or by name. Folders are organizational only; they do not affect how a node reads `env.<KEY>` (a key is not scoped to a folder).

## Values saved for one workflow

A variable can also be saved against a single workflow, for a workflow that keeps its own settings (#1681). That workflow's runs read it as `env.<KEY>` in place of the organization value of the same key; every other workflow keeps reading the organization value and never sees it. Re-running a single node from the canvas reads the same values as the workflow's runs.

- Create one on the page by picking the workflow under Used by, or through the API (`POST /api/env` with a `workflow_id`, see the [API reference](../reference/api.md)).
- The Used by column says which runs read each row (#1774): a workflow's own row names its workflow, and a row for all workflows names the workflows that read their own value of that key instead ("All workflows except Main Flow", or a count once more than two do). A workflow that has been deleted is left out, since it has no runs, and its own rows say "A deleted workflow".
- The canvas suggests `env.<KEY>` references from the keys that workflow's runs can read: every key for all workflows plus its own, never another workflow's.
- Every node reads the same values: Code, Webhook and Salesforce nodes all prefer the run's own value over a Cloudflare Worker secret of the same name.
- A workflow's own secret is stored encrypted like any other, but it is not synced to the Cloudflare Worker, because the Worker holds one value per name for every workflow.
- If a workflow's own secret cannot be decrypted, that workflow's runs get an empty value for the key. The organization value is deliberately not used in its place, so a workflow saved with, say, a sandbox credential never sends the production one. The daily decrypt check names the secret and its workflow.
- The Salesforce connection (`SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`) belongs to the organization and cannot be set for one workflow, because Bidspoke holds one Salesforce login per organization. A workflow with a Salesforce org of its own is #1689.

## Where partner and workflow credentials go

Put partner and workflow credentials here, on the Environment Variables page, as secrets. Do not use Cloudflare Worker secrets (`wrangler secret put`) for these.

Cloudflare Worker secrets are reserved for a small set of platform-level secrets (the Supabase service key, the encryption key, the API key map, and similar). Everything a workflow needs at runtime, including partner API keys, partner usernames and passwords, Salesforce tokens, and Equifax credentials, belongs in the Environment Variables UI. A Code node and an Integration node both read these identically as `env.<KEY>`.

## How nodes read env values

Inside a [Code node](../nodes/code.md), `env` is a plain object of your keys:

```js
const res = await fetch('https://api.partner.com/bid', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.PARTNER_API_KEY}`
  },
  body: JSON.stringify({ email: trigger.payload.email })
})
return await res.json()
```

In template fields elsewhere (Response bodies, Salesforce field mappings, and other config that accepts [data references](../concepts/data-references.md)), reference an env value with the same `env.` prefix, for example `{{env.DEFAULT_OFFER_URL}}`.

Keep stable groupings and flags as separate constants or env values rather than hardcoded literals, so you can change behavior with an edit instead of a code rewrite.

## See also

- [Data references](../concepts/data-references.md) for the full `trigger.*`, `steps.*`, `env.*` syntax.
- [Code node](../nodes/code.md) for the `env` object and the sandboxed execution model.
- [Configure a partner](./configuring-a-partner.md) for partner settings that are stored on the partner, not as env vars.
