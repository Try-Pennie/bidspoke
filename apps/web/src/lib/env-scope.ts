import type { EnvVar } from '@/types/workflow'

/**
 * Which runs read an environment variable (#1774).
 *
 * Since #1681 a run reads the values saved for its own workflow, and takes them
 * over a value of the same key saved for every workflow. These two rules say
 * that to a person: which keys a workflow's steps can reference, and who reads
 * each row on the Environment Variables page.
 */
type Scoped = Pick<EnvVar, 'key' | 'scope' | 'workflow_id'>

const isOwn = (v: Scoped): boolean => v.scope === 'workflow' && !!v.workflow_id

/** The keys a workflow's runs can read: every key saved for all workflows, plus its own, each once. */
export function envKeysForWorkflow(vars: ReadonlyArray<Scoped>, workflowId: string): string[] {
  const keys = new Set<string>()
  for (const v of vars) {
    if (!isOwn(v) || v.workflow_id === workflowId) keys.add(v.key)
  }
  return [...keys].sort()
}

/**
 * Who reads a row's value. A workflow's own row names that workflow. A row for
 * every workflow names the workflows that read their own value of the key
 * instead, because "all workflows" would be false for them.
 *
 * `names` holds the organization's live workflows, so a workflow missing from
 * it is deleted and has no runs to except. `null` means the names could not be
 * loaded, and then nothing is named and nothing is left out on a guess.
 */
export function usedByLabel(row: Scoped, vars: ReadonlyArray<Scoped>, names: ReadonlyMap<string, string> | null): string {
  if (isOwn(row)) {
    if (names === null) return 'Workflow name unavailable'
    return names.get(row.workflow_id as string) ?? 'A deleted workflow'
  }

  const overriding = new Set<string>()
  for (const v of vars) {
    if (isOwn(v) && v.key === row.key) overriding.add(v.workflow_id as string)
  }
  const live = names === null ? [...overriding] : [...overriding].filter((id) => names.has(id))
  if (live.length === 0) return 'All workflows'
  if (names === null || live.length > 2) return `All workflows except the ${live.length} that set their own`

  const listed = live
    .map((id) => names.get(id) as string)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return `All workflows except ${listed.join(' and ')}`
}
