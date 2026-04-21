---
type: community
cohesion: 0.11
members: 28
---

# Node Type Engine

**Cohesion:** 0.11 - loosely connected
**Members:** 28 nodes

## Members
- [[branch.ts]] - code - apps/worker/src/engine/nodes/branch.ts
- [[buildContext()]] - code - apps/worker/src/engine/context.ts
- [[context.ts]] - code - apps/worker/src/engine/context.ts
- [[evaluateConditionGroups()]] - code - apps/worker/src/engine/graph.ts
- [[evaluateEdge()]] - code - apps/worker/src/engine/graph.ts
- [[evaluateTransformExpression()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[executeBranchNode()]] - code - apps/worker/src/engine/nodes/branch.ts
- [[executeExitNode()]] - code - apps/worker/src/engine/nodes/index.ts
- [[executeFilterNode()]] - code - apps/worker/src/engine/nodes/filter.ts
- [[executeIntegrationNode()]] - code - apps/worker/src/engine/nodes/integration.ts
- [[executeNode()]] - code - apps/worker/src/engine/nodes/index.ts
- [[executeResponseNode()]] - code - apps/worker/src/engine/nodes/response.ts
- [[executeTransformNode()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[filter.ts]] - code - apps/worker/src/engine/nodes/filter.ts
- [[getPath()]] - code - apps/worker/src/engine/context.ts
- [[index.ts_2]] - code - apps/worker/src/engine/nodes/index.ts
- [[integration.ts]] - code - apps/worker/src/engine/nodes/integration.ts
- [[resolveContextPath()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[resolveExpression()]] - code - apps/worker/src/engine/context.ts
- [[resolvePathOnValue()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[resolveSource()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[resolveTemplate()]] - code - apps/worker/src/engine/context.ts
- [[resolveValue()]] - code - apps/worker/src/engine/context.ts
- [[resolveVariables()]] - code - apps/worker/src/engine/context.ts
- [[response.ts]] - code - apps/worker/src/engine/nodes/response.ts
- [[setNestedPath()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[splitPath()]] - code - apps/worker/src/engine/nodes/transform.ts
- [[transform.ts]] - code - apps/worker/src/engine/nodes/transform.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Node_Type_Engine
SORT file.name ASC
```

## Connections to other communities
- 4 edges to [[_COMMUNITY_Execution Engine & Node Tests]]
- 2 edges to [[_COMMUNITY_API Layer & Execution History]]
- 2 edges to [[_COMMUNITY_Workflow Runtime & Definitions]]
- 1 edge to [[_COMMUNITY_Security & Observability]]

## Top bridge nodes
- [[executeNode()]] - degree 10, connects to 3 communities
- [[evaluateConditionGroups()]] - degree 5, connects to 2 communities
- [[context.ts]] - degree 7, connects to 1 community
- [[executeIntegrationNode()]] - degree 4, connects to 1 community
- [[buildContext()]] - degree 2, connects to 1 community