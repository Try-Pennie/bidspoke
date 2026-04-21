---
type: community
cohesion: 0.11
members: 31
---

# Canvas Editor

**Cohesion:** 0.11 - loosely connected
**Members:** 31 nodes

## Members
- [[WorkflowCanvas.tsx]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[async()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[clipboard.ts]] - code - apps/web/src/lib/clipboard.ts
- [[copyNode()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[defToEdges()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[defToNodes()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[defaultNamespace()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[defaultNodeConfig()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[duplicateNode()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[findDropSource()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[findFreePosition()]] - code - apps/web/src/lib/layout.ts
- [[findRunningNamespace()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[flowToDef()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[handleBeforeUnload()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[handleImport()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[handleSave()_1]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[handleSortIndex()]] - code - apps/web/src/lib/layout.ts
- [[handleVersionRestore()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[handler()_1]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[if()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[layout.ts]] - code - apps/web/src/lib/layout.ts
- [[layoutWorkflow()]] - code - apps/web/src/lib/layout.ts
- [[makeTriggerNode()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[nodeHeight()]] - code - apps/web/src/lib/layout.ts
- [[onKeyDown()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[overlapsAny()]] - code - apps/web/src/lib/layout.ts
- [[pasteNode()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[primarySourceHandle()]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[readClipboard()]] - code - apps/web/src/lib/clipboard.ts
- [[uid()_1]] - code - apps/web/src/components/canvas/WorkflowCanvas.tsx
- [[writeClipboard()]] - code - apps/web/src/lib/clipboard.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Canvas_Editor
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Auth & Validation]]
- 1 edge to [[_COMMUNITY_API Layer & Execution History]]
- 1 edge to [[_COMMUNITY_Execution Engine & Node Tests]]

## Top bridge nodes
- [[layoutWorkflow()]] - degree 5, connects to 2 communities
- [[handleSave()_1]] - degree 4, connects to 1 community
- [[handleVersionRestore()]] - degree 4, connects to 1 community