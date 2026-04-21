---
type: community
cohesion: 1.00
members: 2
---

# Audit Log Writer

**Cohesion:** 1.00 - tightly connected
**Members:** 2 nodes

## Members
- [[audit.ts]] - code - apps/worker/src/lib/audit.ts
- [[writeAuditLog()]] - code - apps/worker/src/lib/audit.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Audit_Log_Writer
SORT file.name ASC
```
