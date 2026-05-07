-- One-shot backfill: populate step_node_id and final_node_id from
-- workflow_versions definitions. Idempotent — only touches rows where the
-- new column is still NULL.

WITH version_nodes AS (
  SELECT
     wv.id AS version_id
    ,(n->>'namespace') AS namespace
    ,(n->>'id')::uuid AS node_id
  FROM workflow_versions wv
      ,jsonb_array_elements(wv.definition->'nodes') AS n
  WHERE (n->>'id') IS NOT NULL
    AND (n->>'namespace') IS NOT NULL
)
UPDATE execution_steps es
SET step_node_id = vn.node_id
FROM workflow_executions we
    ,version_nodes vn
WHERE true
  AND es.execution_id = we.id
  AND we.workflow_version_id = vn.version_id
  AND es.step_namespace = vn.namespace
  AND es.step_node_id IS NULL;

WITH version_nodes AS (
  SELECT
     wv.id AS version_id
    ,(n->>'namespace') AS namespace
    ,(n->>'id')::uuid AS node_id
  FROM workflow_versions wv
      ,jsonb_array_elements(wv.definition->'nodes') AS n
  WHERE (n->>'id') IS NOT NULL
    AND (n->>'namespace') IS NOT NULL
)
UPDATE workflow_executions we
SET final_node_id = vn.node_id
FROM version_nodes vn
WHERE true
  AND we.workflow_version_id = vn.version_id
  AND we.final_node_namespace = vn.namespace
  AND we.final_node_id IS NULL;
