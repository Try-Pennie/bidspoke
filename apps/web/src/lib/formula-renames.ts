import { api } from '@/lib/api'

/** A step renamed since the last save, and the partners whose formulas name it. */
export interface QueuedFormulaRename {
  oldNs: string
  newNs: string
  partner_ids: string[]
}

/**
 * Applies the partner formula rewrites a save carries, one rename at a time, and
 * returns one line per failure for the save's message: a rewrite that failed, or
 * one that landed but could not clear the partners' stored outage copies
 * (#1846). A failure never stops the renames after it.
 */
export async function applyFormulaRenames(workflowId: string, renames: QueuedFormulaRename[]): Promise<string[]> {
  const failures: string[] = []
  for (const rn of renames) {
    try {
      const r = await api.workflows.renameApply(workflowId, rn.oldNs, rn.newNs, rn.partner_ids)
      if (r.stored_copy_warning) failures.push(r.stored_copy_warning)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Formula rewrite failed'
      failures.push(`Saved, but failed to rewrite partner formulas for ${rn.oldNs}→${rn.newNs}: ${msg}`)
    }
  }
  return failures
}
