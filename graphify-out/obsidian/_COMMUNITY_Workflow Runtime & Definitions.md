---
type: community
cohesion: 0.07
members: 40
---

# Workflow Runtime & Definitions

**Cohesion:** 0.07 - loosely connected
**Members:** 40 nodes

## Members
- [[FieldAutocomplete.tsx]] - code - apps/web/src/components/rule-builder/FieldAutocomplete.tsx
- [[bid-evaluation.ts]] - code - apps/worker/src/engine/nodes/bid-evaluation.ts
- [[cacheKey()_1]] - code - apps/worker/src/engine/definition-loader.ts
- [[cacheKey()]] - code - apps/worker/src/lib/env-loader.ts
- [[createSupabaseClient()]] - code - apps/worker/src/lib/supabase.ts
- [[ctx()_6]] - code - apps/worker/src/engine/__tests__/graph.test.ts
- [[custom-endpoint.ts]] - code - apps/worker/src/routes/custom-endpoint.ts
- [[definition-loader.ts]] - code - apps/worker/src/engine/definition-loader.ts
- [[detectAnomaly()]] - code - apps/worker/src/lib/volume-anomaly.ts
- [[edge()]] - code - apps/worker/src/engine/__tests__/graph.test.ts
- [[env-loader.ts]] - code - apps/worker/src/lib/env-loader.ts
- [[executeBidEvaluationNode()]] - code - apps/worker/src/engine/nodes/bid-evaluation.ts
- [[fetchPartnerMetrics()]] - code - apps/worker/src/engine/nodes/bid-evaluation.ts
- [[getJwks()]] - code - apps/worker/src/lib/jwt.ts
- [[graph.test.ts]] - code - apps/worker/src/engine/__tests__/graph.test.ts
- [[handleCustomEndpoint()]] - code - apps/worker/src/routes/custom-endpoint.ts
- [[handleKeyDown()]] - code - apps/web/src/components/rule-builder/FieldAutocomplete.tsx
- [[index.ts]] - code - apps/worker/src/index.ts
- [[invalidateEnvCache()]] - code - apps/worker/src/lib/env-loader.ts
- [[invalidateWorkflowCache()]] - code - apps/worker/src/engine/definition-loader.ts
- [[isCustomEndpointHost()]] - code - apps/worker/src/routes/custom-endpoint.ts
- [[jwt-auth.ts]] - code - apps/worker/src/middleware/jwt-auth.ts
- [[jwt.ts]] - code - apps/worker/src/lib/jwt.ts
- [[jwtAuth()]] - code - apps/worker/src/middleware/jwt-auth.ts
- [[loadEnvVars()]] - code - apps/worker/src/lib/env-loader.ts
- [[loadWorkflowDefinition()]] - code - apps/worker/src/engine/definition-loader.ts
- [[middleware()]] - code - apps/web/src/middleware.ts
- [[middleware.ts]] - code - apps/web/src/middleware.ts
- [[normalizePath()]] - code - apps/worker/src/routes/custom-endpoint.ts
- [[onMouseDown()]] - code - apps/web/src/components/rule-builder/FieldAutocomplete.tsx
- [[runVolumeAnomalyCheck()]] - code - apps/worker/src/lib/volume-anomaly.ts
- [[scheduled()]] - code - apps/worker/src/index.ts
- [[select()]] - code - apps/web/src/components/rule-builder/FieldAutocomplete.tsx
- [[selectHighestBid()]] - code - apps/worker/src/engine/nodes/bid-evaluation.ts
- [[selectWeighted()]] - code - apps/worker/src/engine/nodes/bid-evaluation.ts
- [[sendVolumeAlert()]] - code - apps/worker/src/lib/volume-anomaly.ts
- [[single()]] - code - apps/worker/src/engine/__tests__/graph.test.ts
- [[supabase.ts]] - code - apps/worker/src/lib/supabase.ts
- [[verifyJwt()]] - code - apps/worker/src/lib/jwt.ts
- [[volume-anomaly.ts]] - code - apps/worker/src/lib/volume-anomaly.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Workflow_Runtime_&_Definitions
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Security & Observability]]
- 5 edges to [[_COMMUNITY_API Layer & Execution History]]
- 2 edges to [[_COMMUNITY_Auth & Validation]]
- 2 edges to [[_COMMUNITY_Execution Engine & Node Tests]]
- 2 edges to [[_COMMUNITY_Node Type Engine]]
- 1 edge to [[_COMMUNITY_Testing Infrastructure]]

## Top bridge nodes
- [[handleCustomEndpoint()]] - degree 8, connects to 3 communities
- [[select()]] - degree 13, connects to 2 communities
- [[single()]] - degree 7, connects to 2 communities
- [[jwtAuth()]] - degree 6, connects to 1 community
- [[runVolumeAnomalyCheck()]] - degree 6, connects to 1 community