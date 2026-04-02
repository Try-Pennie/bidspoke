import type { SupabaseClient } from '@supabase/supabase-js'
import type { LoadedWorkflow, WorkflowDefinition } from '../types'

const CACHE_TTL_SECONDS = 60
const cacheKey = (workflowId: string) => `workflow-def-${workflowId}`

interface CachedDefinition {
  definition: WorkflowDefinition
  workflow_version_id: string
}

export async function loadWorkflowDefinition(
  workflowId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<LoadedWorkflow> {
  // Try KV cache first — avoids Supabase round-trip on every execution
  const cached = await kv.get<CachedDefinition>(cacheKey(workflowId), 'json')
  if (cached) {
    return cached
  }

  // Load from Supabase
  const { data, error } = await supabase
    .from('workflows')
    .select(`
      id,
      definition,
      is_active,
      workflow_versions (id, version_number)
    `)
    .eq('id', workflowId)
    .eq('is_active', true)
    .order('version_number', { referencedTable: 'workflow_versions', ascending: false })
    .limit(1, { referencedTable: 'workflow_versions' })
    .single()

  if (error || !data) {
    throw new Error(`Workflow ${workflowId} not found or inactive`)
  }

  const versions = data.workflow_versions as { id: string }[]
  const workflow_version_id = versions[0]?.id
  if (!workflow_version_id) {
    throw new Error(`Workflow ${workflowId} has no versions`)
  }

  const result: LoadedWorkflow = {
    definition: data.definition as WorkflowDefinition,
    workflow_version_id,
  }

  // Cache for ~60s — KV is eventually consistent, small propagation window is acceptable (PRD 2.6)
  await kv.put(cacheKey(workflowId), JSON.stringify(result), {
    expirationTtl: CACHE_TTL_SECONDS,
  })

  return result
}

// Called on workflow save to invalidate the KV cache immediately
export async function invalidateWorkflowCache(
  workflowId: string,
  kv: KVNamespace
): Promise<void> {
  await kv.delete(cacheKey(workflowId))
}
