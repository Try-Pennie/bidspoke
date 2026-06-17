/**
 * Branch arm label validation (#164).
 *
 * A branch arm's label is its edge sourceHandle and the engine's `_route` key,
 * so two arms in the same node sharing a label make routing between them
 * arbitrary — a lead can take the wrong branch. Auto-generated names are unique
 * (#95), but a manual rename can collide, and the rename carries the wired edge
 * over with no warning. These pure helpers feed the save-time block and the
 * in-panel marking so a duplicate can't be saved.
 *
 * Labels are compared exactly (no trimming): the engine routes on the exact
 * handle string, so two labels differing only by whitespace are genuinely
 * distinct handles, not a collision.
 */

/** The set of label strings that appear more than once in the list. */
export function duplicateLabelSet(labels: string[]): Set<string> {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const label of labels) {
    if (seen.has(label)) dups.add(label)
    seen.add(label)
  }
  return dups
}

/** Indices of the arms whose label collides with another arm in the same node. */
export function duplicateBranchArmIndices(branches: { label: string }[]): Set<number> {
  const dups = duplicateLabelSet(branches.map((b) => b.label))
  const out = new Set<number>()
  branches.forEach((b, i) => {
    if (dups.has(b.label)) out.add(i)
  })
  return out
}

interface BranchNodeLike {
  type?: string
  data?: {
    label?: string | null
    namespace?: string
    config?: { branches?: { label: string }[] }
  }
}

export interface BranchLabelConflict {
  /** Display name of the offending branch node. */
  node: string
  /** The labels used by more than one arm in that node. */
  labels: string[]
}

/**
 * Walk every branch node and report those with duplicate arm labels. Used by the
 * save-time block so a duplicate in any branch node (not just the open one) is
 * caught.
 */
export function findBranchLabelConflicts(nodes: BranchNodeLike[]): BranchLabelConflict[] {
  const conflicts: BranchLabelConflict[] = []
  for (const n of nodes) {
    if (n.type !== 'branch') continue
    const branches = n.data?.config?.branches ?? []
    const dups = duplicateLabelSet(branches.map((b) => b.label))
    if (dups.size > 0) {
      conflicts.push({ node: n.data?.label || n.data?.namespace || 'branch', labels: [...dups] })
    }
  }
  return conflicts
}
