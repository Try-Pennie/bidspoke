/**
 * What the canvas tells the person after a save the server accepted: null when
 * everything landed, otherwise what landed and what did not (#1845). The save
 * itself succeeded in every case here, so each message starts from that.
 */
export interface SaveResult {
  deploy_errors?: { namespace: string; error: string }[]
  /** The server saved the change but could not refresh a stored copy of the old version. */
  stored_copy_warning?: string
}

export function saveOutcomeMessage(result: SaveResult): string | null {
  const parts: string[] = []
  const failed = result.deploy_errors ?? []
  if (failed.length > 0) {
    const list = failed.map((e) => `${e.namespace}: ${e.error}`).join('\n')
    parts.push(`Saved, but ${failed.length === 1 ? 'one code node' : `${failed.length} code nodes`} failed to deploy:\n${list}`)
  }
  if (result.stored_copy_warning) parts.push(result.stored_copy_warning)
  return parts.length > 0 ? parts.join('\n\n') : null
}

/**
 * Whether the save finished: true unless a code node failed to deploy, which
 * keeps the person editing. A stored copy warning is about the copy, not the
 * save, so it never holds the canvas in edit mode.
 */
export function saveFinished(result: SaveResult): boolean {
  return (result.deploy_errors ?? []).length === 0
}

/**
 * What the canvas says when the server found nothing to save. That save still
 * refreshed the stored copies (#1845), so it is how a person clears a stale one,
 * and when the refresh failed again the warning rides along.
 */
export function noChangesMessage(result: SaveResult): string {
  const nothingSaved = 'Nothing was saved: the workflow is identical to the stored version. If you just made an edit, it did not register. Check the node and try saving again.'
  return result.stored_copy_warning ? `${nothingSaved}\n\n${result.stored_copy_warning}` : nothingSaved
}
