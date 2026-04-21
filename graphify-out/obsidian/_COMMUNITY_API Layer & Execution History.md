---
type: community
cohesion: 0.07
members: 58
---

# API Layer & Execution History

**Cohesion:** 0.07 - loosely connected
**Members:** 58 nodes

## Members
- [[.check()]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[.constructor()_1]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.fetch()_1]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.handleCheckAndIncrement()]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.handleGetCount()]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.handleReset()_1]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.load()_1]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.recordError()]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[.recordSuccess()]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[.reset()]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[.save()_1]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[.status()]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[CircuitBreakerClient]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[DailyCapObject]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[ExecutionListPanel.tsx]] - code - apps/web/src/components/canvas/ExecutionListPanel.tsx
- [[api-key-auth.ts]] - code - apps/worker/src/middleware/api-key-auth.ts
- [[api.ts]] - code - apps/web/src/lib/api.ts
- [[apiKeyAuth()]] - code - apps/worker/src/middleware/api-key-auth.ts
- [[apiUrl()]] - code - apps/worker/src/lib/github.ts
- [[authHeaders()]] - code - apps/web/src/lib/api.ts
- [[buildWorkerScript()]] - code - apps/worker/src/lib/code-node-deployer.ts
- [[check()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[checkAndIncrement()]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[circuit-breaker-client.ts]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[circuit-breaker.test.ts]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[code-node-deployer.ts]] - code - apps/worker/src/lib/code-node-deployer.ts
- [[code.ts]] - code - apps/worker/src/engine/nodes/code.ts
- [[codeWorkerName()]] - code - apps/worker/src/lib/code-node-deployer.ts
- [[daily-cap.test.ts]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[daily-cap.ts]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[deployCodeNodes()]] - code - apps/worker/src/lib/code-node-deployer.ts
- [[executeCodeNode()]] - code - apps/worker/src/engine/nodes/code.ts
- [[fetchSalesforceSchema()]] - code - apps/worker/src/lib/schema-sync/salesforce.ts
- [[fetchSnowflakeSchema()]] - code - apps/worker/src/lib/schema-sync/snowflake.ts
- [[fetchSupabaseSchema()]] - code - apps/worker/src/lib/schema-sync/supabase-schema.ts
- [[formatDuration()_1]] - code - apps/web/src/components/canvas/ExecutionListPanel.tsx
- [[getCount()]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[getCurrentFileSha()]] - code - apps/worker/src/lib/github.ts
- [[github.ts]] - code - apps/worker/src/lib/github.ts
- [[json()_1]] - code - apps/worker/src/durable-objects/daily-cap.ts
- [[makeDO()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[makeDO()_1]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[makeDOState()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[makeDOState()_1]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[onVisible()]] - code - apps/web/src/components/canvas/ExecutionListPanel.tsx
- [[pushWorkflowToGitHub()]] - code - apps/worker/src/lib/github.ts
- [[recordError()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[recordSuccess()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[req()]] - code - apps/web/src/lib/api.ts
- [[req()_1]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[req()_2]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[reset()]] - code - apps/worker/src/durable-objects/__tests__/daily-cap.test.ts
- [[salesforce.ts]] - code - apps/worker/src/lib/schema-sync/salesforce.ts
- [[snowflake.ts]] - code - apps/worker/src/lib/schema-sync/snowflake.ts
- [[status()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts
- [[supabase-schema.ts]] - code - apps/worker/src/lib/schema-sync/supabase-schema.ts
- [[toggleError()]] - code - apps/web/src/components/canvas/ExecutionListPanel.tsx
- [[tripBreaker()]] - code - apps/worker/src/durable-objects/__tests__/circuit-breaker.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/API_Layer_&_Execution_History
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_Workflow Runtime & Definitions]]
- 5 edges to [[_COMMUNITY_Execution Engine & Node Tests]]
- 3 edges to [[_COMMUNITY_Auth & Validation]]
- 2 edges to [[_COMMUNITY_Testing Infrastructure]]
- 2 edges to [[_COMMUNITY_Security & Observability]]
- 2 edges to [[_COMMUNITY_Node Type Engine]]
- 1 edge to [[_COMMUNITY_Frontend App Pages]]
- 1 edge to [[_COMMUNITY_Canvas Editor]]

## Top bridge nodes
- [[.fetch()_1]] - degree 31, connects to 4 communities
- [[json()_1]] - degree 26, connects to 3 communities
- [[executeCodeNode()]] - degree 6, connects to 2 communities
- [[.save()_1]] - degree 5, connects to 2 communities
- [[CircuitBreakerClient]] - degree 7, connects to 1 community