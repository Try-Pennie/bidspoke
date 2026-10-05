# Decrypted secret env vars live in the KV cache — we accept this deliberately

The env-var loader caches **decrypted** secret values in KV (`apps/worker/src/lib/env-loader.ts`: a per-org `env-vars-{org}` copy on a 300s TTL plus a no-TTL `env-vars-{org}-lastgood` copy). Before the 2026-06-26 decrypt-secrets change, plaintext secrets only existed as Cloudflare worker secrets. We are **accepting the new location as-is**: KV is encrypted at rest, the move is consistent with the trusted-team posture, and the alternatives each trade a real outage risk or hot-path cost for a marginal exposure reduction inside an already-encrypted store.

## Status

accepted (2026-06-26)

## Context

On 2026-06-26 a production incident (#391-adjacent) led to two related changes to how nodes read credentials:

- Secret env vars (`is_secret = true`) must be readable by nodes — the code-node `env` global and `{{env.X}}` template resolution — because that is what they exist for (Dan, 2026-06-26). `is_secret` is a UI-masking flag, not an access gate.
- Secret values are stored **encrypted** (`secret-crypto`, AES-GCM, key `SECRET_ENCRYPTION_KEY`). The first attempt to expose them loaded the raw ciphertext into the env map, which a node then sent as a password (Equifax 401, ~6 min outage). The fix (`be895af`) **decrypts** secrets in the loader and **skips** any that fail to decrypt, so ciphertext is never passed through raw.

A consequence is that the loader now holds **plaintext** secret values in KV: a short 300s hot-path copy and a no-TTL `-lastgood` copy. The `-lastgood` copy exists for blip resilience — it is served when a transient Supabase error would otherwise blank the credentials for the full TTL (the original #391 outage shape). That copy has no expiry, so a decrypted secret persists in KV until the next successful load overwrites it.

Issue #405 asked us to make a deliberate decision about this rather than let it stand by accident. Three options were on the table:

- **(A) Accept as-is** — keep plaintext secrets in KV including the no-TTL last-good copy.
- **(B) Drop the last-good copy for secrets** — keep it for non-secrets, but give secrets only the 300s TTL copy, shrinking the window a decrypted secret sits in KV.
- **(C) Re-encrypt the cached blob** — store the cache encrypted and decrypt on every read.

## Decision

We take **(A) accept as-is**.

- KV is encrypted at rest, so the values are not stored in the clear on disk. The trust boundary here is the same single-org, authenticated team that already reads raw SSN and credit data in execution logs by deliberate choice (ADR-0006). A team member who can read KV can already read the secrets they configure.
- **(B) reintroduces the exact outage we just fixed**, scoped to secrets. The no-TTL last-good copy is the mechanism that keeps credentials from going blank during a transient Supabase blip. Removing it for secrets means a DB hiccup during the 300s window blanks the Salesforce/Equifax/Tripoint credentials and live leads fail — trading a real, recurring availability risk for a marginal reduction in exposure inside an encrypted store.
- **(C) defeats the cache's purpose.** The cache exists to keep a Supabase round-trip and a decrypt off the hot path of every execution. Re-encrypting the blob would force a decrypt on every read, which is the cost we were avoiding, for no net change in where the plaintext can be observed (it is decrypted in worker memory either way).

## Consequences

- Plaintext secret values remain in KV (a 300s hot-path copy and a no-TTL last-good copy). This is a conscious tradeoff, not an oversight. The blast radius of a KV-read compromise now includes the configured partner credentials; the compensating controls are KV encryption at rest, single-org access scoping, and the same trusted-team boundary as ADR-0006.
- A secret that fails to decrypt is silently skipped by the loader. That silent skip is the gap #404 closes with a daily decrypt-health alert, so a credential a node needs cannot go missing without a signal.
- A **latent correctness issue stays open**, separate from this exposure decision: on credential drift, a decrypted DB secret can override the Cloudflare worker-secret binding of the same name (the sandbox env merge prefers the DB value). That is a value-correctness concern, not a storage-location one, and is tracked independently.
- Revisit if the trust boundary changes: a less-trusted role, an external auditor, a regulator requirement, or multi-tenant expansion. The cheapest first step at that point is (B) — re-add a TTL to the secret last-good copy — paired with reconfirming the #391 blip-resilience tradeoff.
- Since #1681 (2026-10-05) the values saved for one workflow sit in a second pair beside these, `env-vars-{org}-workflow-scoped` and its `-lastgood` copy, with the same TTL, the same encryption at rest (#491) and the same invalidation. The org values stay in the two original entries in their original flat format, so a rollback to the release before still reads them.
