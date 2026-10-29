# @bidspoke/connection-seal

`seal` and `open` for ops connection logins (#2333).

The bidding Worker seals to an ops PUBLIC key (RSA-OAEP-256 wrapping a fresh
AES-256-GCM key), bound by the canonical JSON of `{organization_id,
connection_id, service, generation, kid}`; only ops, holding the private key,
opens.

Public keys are the code constant `src/keys.ts` (empty until the ops key is
generated). A test fails on any private key material in the package.

Rotating the ops key, and naming a new kid by its full date: the "Rotating the
ops private key" section of
[docs/disaster-recovery.md](../../docs/disaster-recovery.md).
