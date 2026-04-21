---
type: community
cohesion: 0.07
members: 50
---

# Execution Engine & Node Tests

**Cohesion:** 0.07 - loosely connected
**Members:** 50 nodes

## Members
- [[.constructor()_5]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[PartnerApiError]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[backoffMs()]] - code - apps/worker/src/engine/retry.ts
- [[callBidApi()]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[check()_4]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[checkDedup()]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[classifyHttpError()]] - code - apps/worker/src/engine/error-classifier.ts
- [[classifyTransportError()]] - code - apps/worker/src/engine/error-classifier.ts
- [[edge()_1]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[error-classifier.ts]] - code - apps/worker/src/engine/error-classifier.ts
- [[evaluateCondition()]] - code - apps/worker/src/engine/graph.ts
- [[evaluateFormula()]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[evaluateGroup()]] - code - apps/worker/src/engine/graph.ts
- [[evaluateResponseClassification()]] - code - apps/worker/src/engine/error-classifier.ts
- [[executeParallelNode()]] - code - apps/worker/src/engine/nodes/parallel.ts
- [[executePartnerBidNode()]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[extractBid()]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[findEntryNode()]] - code - apps/worker/src/engine/graph.ts
- [[findNode()]] - code - apps/worker/src/engine/graph.ts
- [[getBodyField()]] - code - apps/worker/src/engine/error-classifier.ts
- [[getPath()_1]] - code - apps/worker/src/engine/graph.ts
- [[getPath()_2]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[graph.ts]] - code - apps/worker/src/engine/graph.ts
- [[integration-e2e.test.ts]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[looseEquals()]] - code - apps/worker/src/engine/error-classifier.ts
- [[makeCtx()_7]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[matchRejectionSignal()]] - code - apps/worker/src/engine/error-classifier.ts
- [[matchStatusSignal()]] - code - apps/worker/src/engine/error-classifier.ts
- [[node()_6]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[outgoingEdges()]] - code - apps/worker/src/engine/graph.ts
- [[parallel.ts]] - code - apps/worker/src/engine/nodes/parallel.ts
- [[parallelNode()]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[partner-bid.ts]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[partnerBid()]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[partnerSkip()]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[recordError()_4]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[recordStepOutput()]] - code - apps/worker/src/engine/context.ts
- [[recordSuccess()_4]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[resolveField()]] - code - apps/worker/src/engine/graph.ts
- [[retry.ts]] - code - apps/worker/src/engine/retry.ts
- [[runAll()]] - code - apps/worker/src/engine/nodes/parallel.ts
- [[runFirst()]] - code - apps/worker/src/engine/nodes/parallel.ts
- [[runParallelChild()]] - code - apps/worker/src/engine/index.ts
- [[setupMocks()]] - code - apps/worker/src/engine/__tests__/integration-e2e.test.ts
- [[shouldSuppressAlert()]] - code - apps/worker/src/engine/error-classifier.ts
- [[skip()]] - code - apps/worker/src/engine/nodes/partner-bid.ts
- [[sleep()]] - code - apps/worker/src/engine/retry.ts
- [[walkGraph()]] - code - apps/worker/src/engine/index.ts
- [[withRetry()]] - code - apps/worker/src/engine/retry.ts
- [[withTimeout()]] - code - apps/worker/src/engine/retry.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Execution_Engine_&_Node_Tests
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_API Layer & Execution History]]
- 5 edges to [[_COMMUNITY_Security & Observability]]
- 4 edges to [[_COMMUNITY_Node Type Engine]]
- 3 edges to [[_COMMUNITY_Testing Infrastructure]]
- 2 edges to [[_COMMUNITY_Workflow Runtime & Definitions]]
- 1 edge to [[_COMMUNITY_Auth & Validation]]
- 1 edge to [[_COMMUNITY_Canvas Editor]]

## Top bridge nodes
- [[executePartnerBidNode()]] - degree 16, connects to 5 communities
- [[walkGraph()]] - degree 15, connects to 2 communities
- [[runParallelChild()]] - degree 7, connects to 2 communities
- [[graph.ts]] - degree 9, connects to 1 community
- [[callBidApi()]] - degree 7, connects to 1 community