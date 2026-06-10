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
5. Check "Secret. Value encrypted and synced to Cloudflare Worker." if the value is sensitive.
6. Save.

## Reveal a secret

Secrets are masked. To see one, click the reveal control on its row; the value is decrypted on demand and shown. Click again to hide it.

If a secret shows "Rotate to enable reveal", it was created before the encryption key was last rotated and cannot be decrypted for display. Re-save that variable with a fresh value to restore reveal.

## Folders

Variables can be organized into folders. You can create folders (including nested folders), drag variables between them, rename and move folders, collapse them, and sort by most-recently-used or by name. Folders are organizational only; they do not affect how a node reads `env.<KEY>` (keys are global within the organization, not scoped to a folder).

## Where partner and workflow credentials go

Put partner and workflow credentials here, on the Environment Variables page, as secrets. Do not use Cloudflare Worker secrets (`wrangler secret put`) for these.

Cloudflare Worker secrets are reserved for a small set of platform-level secrets (the Supabase service key, the encryption key, the API key map, and similar). Everything a workflow needs at runtime, including partner API keys, partner usernames and passwords, Salesforce tokens, and Equifax credentials, belongs in the Environment Variables UI. A Code node and an Integration node both read these identically as `env.<KEY>`.

This matters when you [import from Pipedream](./importing-from-pipedream.md): the importer rewrites Pipedream credential references into env-var reads like `env.SALESFORCE_ACCESS_TOKEN`, `env.EQUIFAX_USERNAME`, and `env.EQUIFAX_PASSWORD`. Add those keys here before running the imported workflow.

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
- [Importing from Pipedream](./importing-from-pipedream.md) for the credential references the importer rewrites to `env.*`.
- [Configure a partner](./configuring-a-partner.md) for partner settings that are stored on the partner, not as env vars.
