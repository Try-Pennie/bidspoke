/**
 * The environment variables a workflow definition reads (#2702): env.X as a
 * path, or {{env.X}} in a template, in its steps and its edge conditions.
 *
 * The one reading of that question for the ops lane. The bidding Worker uses
 * it to serve an ops run, and an ops step test, only the current values of the
 * variables its definition reads (ops-gateway.ts readOpsRunVariables,
 * routes/api/ops-step-test.ts), and to refuse a live save that reads one that
 * does not exist (routes/api/workflows.ts); the ops run uses it (run-walk.ts)
 * to refuse, before any step, a definition reading one it was not given
 * (ops/run-variables.ts, runVariablesFor). So none of them can disagree about
 * which variables a definition reads. No imports, so the ops Worker takes nothing of the bidding
 * Worker's with it.
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
 * Whether every variable a definition or step reads has a value for it (#3003,
 * phase 7 of #2982): given, or refused naming each it reads that has none. A
 * secret counts as any other value: an ops run and an ops step test are given
 * a secret's current value (Dan, 2026-10-29: "Yes, ops reads secrets", and
 * "Any secret, no exceptions"). `present` is every name that has a value now.
 * The one judgement the bidding Worker's live save, switch on and restore
 * check (routes/api/workflows.ts) and the ops step test (ops/step-test.ts)
 * make, each wording it for its own reader.
 */
export type VariablesJudged = { kind: 'given' } | { kind: 'refused'; missing: string[] }

export function judgeVariables(reads: readonly string[], present: Iterable<string>): VariablesJudged {
  const has = new Set(present)
  const missing = reads.filter((k) => !has.has(k))
  return missing.length > 0 ? { kind: 'refused', missing } : { kind: 'given' }
}

/** Variable names as a definition writes them: env.A, env.B. */
export const namedVariables = (keys: readonly string[]) => keys.map((k) => `env.${k}`).join(', ')
