---
type: community
cohesion: 0.16
members: 24
---

# Testing Infrastructure

**Cohesion:** 0.16 - loosely connected
**Members:** 24 nodes

## Members
- [[.constructor()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.fetch()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.handleCheck()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.handleRecordError()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.handleRecordSuccess()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.handleReset()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.handleStatus()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.load()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[.save()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[CircuitBreakerObject]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[TestRunPanel.tsx]] - code - apps/web/src/components/canvas/TestRunPanel.tsx
- [[buildCookieChunks()]] - code - apps/web/e2e/global-setup.ts
- [[circuit-breaker.ts]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[client.ts]] - code - apps/web/src/lib/supabase/client.ts
- [[createClient()]] - code - apps/web/src/lib/supabase/client.ts
- [[deletePayload()]] - code - apps/web/src/components/canvas/TestRunPanel.tsx
- [[global-setup.ts]] - code - apps/web/e2e/global-setup.ts
- [[globalSetup()]] - code - apps/web/e2e/global-setup.ts
- [[json()]] - code - apps/worker/src/durable-objects/circuit-breaker.ts
- [[log()]] - code - apps/worker/src/lib/logger.ts
- [[logger.ts]] - code - apps/worker/src/lib/logger.ts
- [[run()]] - code - apps/web/src/components/canvas/TestRunPanel.tsx
- [[savePayload()]] - code - apps/web/src/components/canvas/TestRunPanel.tsx
- [[saving()]] - code - apps/web/src/components/canvas/TestRunPanel.tsx

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Testing_Infrastructure
SORT file.name ASC
```

## Connections to other communities
- 3 edges to [[_COMMUNITY_Execution Engine & Node Tests]]
- 2 edges to [[_COMMUNITY_API Layer & Execution History]]
- 1 edge to [[_COMMUNITY_Workflow Runtime & Definitions]]
- 1 edge to [[_COMMUNITY_Security & Observability]]

## Top bridge nodes
- [[log()]] - degree 10, connects to 3 communities
- [[createClient()]] - degree 5, connects to 2 communities