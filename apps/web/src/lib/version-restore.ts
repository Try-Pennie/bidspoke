import { api } from '@/lib/api'
import { saveOutcomeMessage } from '@/lib/save-outcome'

/**
 * The canvas's version restore: restore, then read the workflow back. `notice`
 * is what the canvas must tell the person, or null: a restore commits and then
 * refreshes the stored copy the engine reads in an outage, and when that refresh
 * failed the server says so in stored_copy_warning (#1845).
 */
export async function restoreVersion(workflowId: string, versionId: string) {
  const result = await api.versions.restore(workflowId, versionId)
  const workflow = await api.workflows.get(workflowId)
  return { workflow, notice: saveOutcomeMessage(result) }
}
