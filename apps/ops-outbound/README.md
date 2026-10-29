# ops-outbound

The outbound Worker of the `bidspoke-code-nodes-ops` dispatch namespace the ops
Worker binds (#1709). It refuses every request until Phase 2 defines what ops
code may reach. It is a separate Worker from `apps/compare-outbound`, which must
refuse for ever.

It is deployed by its own leg, Deploy Ops Outbound, since the ops lane went live
on 2026-10-06 (`OPS_WORKER_DEPLOYED` in `apps/worker/src/lib/secret-lists.ts`);
Deploy Ops Worker then deploys `bidspoke-worker-ops` and proves
`ops.trypennie.dev` answers as it.
