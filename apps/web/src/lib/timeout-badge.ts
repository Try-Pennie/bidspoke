// Which node types show the canvas timeout-warning badge. The badge is attached
// once to the whole nodeTypes registry (via withTimeoutBadge in WorkflowCanvas),
// so every node type opts IN by default and a newly added type is covered with
// no per-card wiring. Only the types below opt out: the trigger (configured via
// its own TriggerConfigPanel, never the timeout field) and the passive join
// markers parallel_end / branch_end. Mirrors the config panel's own exclusion,
// which renders the timeout field for every type except those two.
export const NO_TIMEOUT_BADGE_TYPES = new Set(['trigger', 'parallel_end', 'branch_end'])

export function nodeTypeGetsTimeoutBadge(type: string): boolean {
  return !NO_TIMEOUT_BADGE_TYPES.has(type)
}
