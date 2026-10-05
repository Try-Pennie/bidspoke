import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { envKeysForWorkflow } from '@/lib/env-scope'

/**
 * The environment variable keys a workflow's runs can read, for the canvas's
 * `env.KEY` suggestions (#1774): every key saved for all workflows plus the
 * workflow's own, never another workflow's.
 *
 * A failed read leaves the list empty and says nothing, because these are
 * suggestions only: every reference still works when typed by hand, and the
 * Environment Variables page reports a list that cannot be read.
 */
export function useWorkflowEnvKeys(workflowId: string): string[] {
  const [keys, setKeys] = useState<string[]>([])
  useEffect(() => {
    let live = true
    api.env.list()
      .then((vars) => { if (live) setKeys(envKeysForWorkflow(vars, workflowId)) })
      .catch(() => {})
    return () => { live = false }
  }, [workflowId])
  return keys
}
