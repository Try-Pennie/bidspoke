import type { SupabaseClient } from '@supabase/supabase-js'
import type { LoadedWorkflow, WorkflowDefinition } from '../types'
import { isNotFoundError } from '../lib/api-error'

// Thrown when the requested workflow doesn't exist, is deleted, or is inactive.
// A typed error so routes can map it to 404 by instanceof rather than matching
// substrings in a message (which mis-maps any internal error containing "not
// found"/"inactive") — and so the external response can stay generic (#107).
export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string, inactive: boolean) {
    super(`Workflow ${workflowId} ${inactive ? 'not found or inactive' : 'not found'}`)
    this.name = 'WorkflowNotFoundError'
  }
}

const CACHE_TTL_SECONDS = 300
const cacheKey = (workflowId: string) => `workflow-def-${workflowId}`

interface CachedDefinition {
  definition: WorkflowDefinition
  workflow_version_id: string
  workflow_name: string
  org_id: string
  slack_channel: string | null
  capture_sightings: boolean
}

export async function loadWorkflowDefinition(
  workflowId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  options: { allowInactive?: boolean } = {}
): Promise<LoadedWorkflow> {
  const { allowInactive = false } = options

  // Skip the cache for test runs against inactive workflows so we don't
  // pollute the cache with definitions that real webhooks shouldn't serve.
  if (!allowInactive) {
    const cached = await kv.get<CachedDefinition>(cacheKey(workflowId), 'json')
    if (cached) {
      return cached
    }
  }

  // Load from Supabase
  let query = supabase
    .from('workflows')
    .select(`
      id,
      name,
      organization_id,
      slack_channel,
      definition,
      is_active,
      capture_sightings,
      workflow_versions (id, version_number)
    `)
    .eq('id', workflowId)
    .is('deleted_at', null)
    .order('version_number', { referencedTable: 'workflow_versions', ascending: false })
    .limit(1, { referencedTable: 'workflow_versions' })

  if (!allowInactive) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query.single()

  // A transient DB error must NOT masquerade as a missing workflow: callers map
  // WorkflowNotFoundError to 404, which a lead source treats as "endpoint gone"
  // and stops retrying — dropping the lead (#303). PGRST116 is the genuine
  // no-rows / inactive case (→ WorkflowNotFoundError); any other error is a real
  // failure that should surface as a retryable 5xx.
  if (error && !isNotFoundError(error)) {
    throw new Error(`Failed to load workflow ${workflowId}: ${error.message}`)
  }
  if (!data) {
    throw new WorkflowNotFoundError(workflowId, !allowInactive)
  }

  const versions = data.workflow_versions as { id: string }[]
  const workflow_version_id = versions[0]?.id
  if (!workflow_version_id) {
    throw new Error(`Workflow ${workflowId} has no versions`)
  }

  const result: LoadedWorkflow = {
    definition: data.definition as WorkflowDefinition,
    workflow_version_id,
    workflow_name: data.name as string,
    org_id: data.organization_id as string,
    slack_channel: (data.slack_channel as string | null) ?? null,
    capture_sightings: (data.capture_sightings as boolean | null) ?? true,
  }

  // Cache for 5min — KV is eventually consistent; invalidation fires on save, and
  // the scheduled pre-warm cron keeps active workflows hot (PRD 2.6).
  // Don't cache inactive defs — webhook callers must hit the active check.
  if (!allowInactive) {
    await kv.put(cacheKey(workflowId), JSON.stringify(result), {
      expirationTtl: CACHE_TTL_SECONDS,
    })
  }

  return result
}

// Called on workflow save to invalidate the KV cache immediately
export async function invalidateWorkflowCache(
  workflowId: string,
  kv: KVNamespace
): Promise<void> {
  await kv.delete(cacheKey(workflowId))
}
