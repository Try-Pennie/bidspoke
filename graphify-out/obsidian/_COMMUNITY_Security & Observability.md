---
type: community
cohesion: 0.10
members: 32
---

# Security & Observability

**Cohesion:** 0.10 - loosely connected
**Members:** 32 nodes

## Members
- [[.constructor()_4]] - code - apps/worker/src/engine/index.ts
- [[.constructor()_3]] - code - apps/worker/src/engine/index.ts
- [[CircuitOpenError]] - code - apps/worker/src/engine/index.ts
- [[StepFailureError]] - code - apps/worker/src/engine/index.ts
- [[checkIdempotency()]] - code - apps/worker/src/engine/idempotency.ts
- [[createExecutionRecord()]] - code - apps/worker/src/engine/step-logger.ts
- [[crypto.ts]] - code - apps/worker/src/lib/crypto.ts
- [[deriveIdempotencyKey()]] - code - apps/worker/src/lib/crypto.ts
- [[executeWorkflow()]] - code - apps/worker/src/engine/index.ts
- [[generateTraceId()]] - code - apps/worker/src/lib/crypto.ts
- [[getNestedValue()]] - code - apps/worker/src/lib/crypto.ts
- [[getSlackConnection()]] - code - apps/worker/src/lib/slack.ts
- [[idempotency.ts]] - code - apps/worker/src/engine/idempotency.ts
- [[index.ts_1]] - code - apps/worker/src/engine/index.ts
- [[key()]] - code - apps/worker/src/engine/idempotency.ts
- [[logStep()]] - code - apps/worker/src/engine/index.ts
- [[parsePiiFields()]] - code - apps/worker/src/engine/pii-redactor.ts
- [[pii-redactor.ts]] - code - apps/worker/src/engine/pii-redactor.ts
- [[postMessage()]] - code - apps/worker/src/lib/slack.ts
- [[preloadResumeContext()]] - code - apps/worker/src/engine/index.ts
- [[redactPii()]] - code - apps/worker/src/engine/pii-redactor.ts
- [[sendCircuitAlert()]] - code - apps/worker/src/lib/slack.ts
- [[sendDurationAlert()]] - code - apps/worker/src/lib/slack.ts
- [[sendFailureAlert()]] - code - apps/worker/src/lib/slack.ts
- [[setIdempotencyProcessing()]] - code - apps/worker/src/engine/idempotency.ts
- [[setIdempotencyResult()]] - code - apps/worker/src/engine/idempotency.ts
- [[shouldRedact()]] - code - apps/worker/src/engine/pii-redactor.ts
- [[slack.ts]] - code - apps/worker/src/lib/slack.ts
- [[step-logger.ts]] - code - apps/worker/src/engine/step-logger.ts
- [[updateExecutionRecord()]] - code - apps/worker/src/engine/step-logger.ts
- [[walk()]] - code - apps/worker/src/engine/pii-redactor.ts
- [[writeStepLog()]] - code - apps/worker/src/engine/step-logger.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Security_&_Observability
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Workflow Runtime & Definitions]]
- 5 edges to [[_COMMUNITY_Execution Engine & Node Tests]]
- 2 edges to [[_COMMUNITY_API Layer & Execution History]]
- 1 edge to [[_COMMUNITY_Auth & Validation]]
- 1 edge to [[_COMMUNITY_Frontend App Pages]]
- 1 edge to [[_COMMUNITY_Testing Infrastructure]]
- 1 edge to [[_COMMUNITY_Node Type Engine]]

## Top bridge nodes
- [[executeWorkflow()]] - degree 17, connects to 4 communities
- [[updateExecutionRecord()]] - degree 4, connects to 2 communities
- [[index.ts_1]] - degree 7, connects to 1 community
- [[getSlackConnection()]] - degree 6, connects to 1 community
- [[postMessage()]] - degree 6, connects to 1 community