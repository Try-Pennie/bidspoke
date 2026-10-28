/**
 * The environment variables a workflow definition reads (#2702): env.X as a
 * path, or {{env.X}} in a template, in its steps and its edge conditions.
 *
 * The one reading of that question for the ops lane. The bidding Worker uses
 * it to serve an ops version only the variables its definition reads
 * (version-variables.ts), and the ops run uses it to refuse, before any step,
 * a definition reading one it was not given (ops/run-walk.ts), so the two can
 * never disagree about which variables a definition reads. No imports, so the
 * ops Worker takes nothing of the bidding Worker's with it.
 */

/** The form a variable's name takes wherever a definition can read it. */
export const ENV_KEY = /^[A-Za-z0-9_]+$/

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function collect(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/(?:^|\{\{\s*)env\.([A-Za-z0-9_]+)/g)) found.add(m[1])
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, found)
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) collect(v, found)
  }
}

/** The names of the variables a definition's steps and edges read, each once, in the order first read. */
export function envReferences(definition: Record<string, unknown>): string[] {
  const found = new Set<string>()
  if (Array.isArray(definition.nodes)) collect(definition.nodes, found)
  if (Array.isArray(definition.edges)) collect(definition.edges, found)
  return [...found]
}
