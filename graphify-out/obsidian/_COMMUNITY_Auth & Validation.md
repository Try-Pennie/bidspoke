---
type: community
cohesion: 0.14
members: 16
---

# Auth & Validation

**Cohesion:** 0.14 - loosely connected
**Members:** 16 nodes

## Members
- [[.constructor()_2]] - code - apps/worker/src/lib/circuit-breaker-client.ts
- [[GET()]] - code - apps/web/src/app/auth/callback/route.ts
- [[WorkflowEditorInner()]] - code - apps/web/src/app/(app)/workflows/[id]/page.tsx
- [[WorkflowEditorPage()]] - code - apps/web/src/app/(app)/workflows/[id]/page.tsx
- [[auth-allowlist.ts]] - code - apps/web/src/lib/auth-allowlist.ts
- [[handleToggleActive()]] - code - apps/web/src/app/(app)/workflows/page.tsx
- [[isPermittedDomain()]] - code - apps/web/src/lib/auth-allowlist.ts
- [[jwt-auth.test.ts]] - code - apps/worker/src/middleware/__tests__/jwt-auth.test.ts
- [[makeApp()]] - code - apps/worker/src/middleware/__tests__/jwt-auth.test.ts
- [[makeSupabase()]] - code - apps/worker/src/middleware/__tests__/jwt-auth.test.ts
- [[page.tsx_4]] - code - apps/web/src/app/(app)/workflows/[id]/page.tsx
- [[route.ts]] - code - apps/web/src/app/auth/callback/route.ts
- [[validateNodeConfig()]] - code - apps/web/src/lib/workflow-validation.ts
- [[validateWorkflow()]] - code - apps/web/src/lib/workflow-validation.ts
- [[validateWorkflowDef()]] - code - apps/web/src/lib/workflow-validation.ts
- [[workflow-validation.ts]] - code - apps/web/src/lib/workflow-validation.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Auth_&_Validation
SORT file.name ASC
```

## Connections to other communities
- 3 edges to [[_COMMUNITY_API Layer & Execution History]]
- 2 edges to [[_COMMUNITY_Frontend App Pages]]
- 2 edges to [[_COMMUNITY_Canvas Editor]]
- 2 edges to [[_COMMUNITY_Workflow Runtime & Definitions]]
- 1 edge to [[_COMMUNITY_Security & Observability]]
- 1 edge to [[_COMMUNITY_Execution Engine & Node Tests]]

## Top bridge nodes
- [[GET()]] - degree 15, connects to 6 communities
- [[handleToggleActive()]] - degree 3, connects to 1 community
- [[.constructor()_2]] - degree 2, connects to 1 community