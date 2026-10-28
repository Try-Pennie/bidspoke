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

/**
 * What a reader of the variables it reads is given (#2702): the plain values,
 * or why not. none_kept: no variables were kept to judge by (a version saved
 * before they were, or no saved version at all). refused: some it reads are
 * secret (an ops run or step is never given a secret) or missing, each named.
 * The one judgement the ops run (ops/run-walk.ts), the ops step test
 * (ops/step-test.ts) and the bidding Worker's live save and switch on check
 * (routes/api/workflows.ts) make, each wording it for its own reader.
 */
export type VariablesJudged =
  | { kind: 'given'; env: Record<string, string> }
  | { kind: 'none_kept' }
  | { kind: 'refused'; secret: string[]; missing: string[] }

export function judgeVariables(
  reads: readonly string[], variables: { values: Readonly<Record<string, string>>; secretKeys: readonly string[] } | null,
): VariablesJudged {
  if (reads.length === 0) return { kind: 'given', env: {} }
  if (variables === null) return { kind: 'none_kept' }
  const secret = reads.filter((k) => variables.secretKeys.includes(k))
  const missing = reads.filter((k) => !secret.includes(k) && !Object.hasOwn(variables.values, k))
  if (secret.length > 0 || missing.length > 0) return { kind: 'refused', secret, missing }
  return { kind: 'given', env: Object.fromEntries(reads.map((k) => [k, variables.values[k]])) }
}

/** Variable names as a definition writes them: env.A, env.B. */
export const namedVariables = (keys: readonly string[]) => keys.map((k) => `env.${k}`).join(', ')
