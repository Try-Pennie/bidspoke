/**
 * Records one porting decision (#2979) for scripts/porting/record-decision.ts:
 * reads what is stored for the workflow, plans the decision (decisions.ts),
 * and only with apply writes it and reads it back. Without apply it returns the
 * plan and writes nothing, as the loader does.
 */
import { decisionDifferences, planDecision, type DecisionRequest } from './decisions.ts'
import { readDecisionTarget, writeDecision } from './store.ts'

export const DECISION_USAGE = [
  'usage: record-decision.ts --retire <hashid> --by <who decided> --reason <why> [--apply]',
  '       record-decision.ts --unretire <hashid> [--apply]',
  '       record-decision.ts --drop-step <hashid> --step <step namespace> --export <export dir> --by <who decided> --reason <why> [--apply]',
  '       record-decision.ts --keep-step <hashid> --step <step namespace> [--apply]',
].join('\n')

const MODES = ['--retire', '--unretire', '--drop-step', '--keep-step'] as const

export interface DecisionArgs { request: DecisionRequest; exportDir: string | null; apply: boolean }

/** Reads the command line into one decision, refusing anything missing or ambiguous by name. */
export function parseDecisionArgs(argv: string[]): DecisionArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i === -1) return undefined
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${DECISION_USAGE}`)
    return v
  }
  const required = (flag: string): string => {
    const v = value(flag)
    if (v === undefined) throw new Error(`${flag} is required for this decision\n${DECISION_USAGE}`)
    return v
  }
  const modes = MODES.filter((m) => argv.includes(m))
  if (modes.length === 0) throw new Error(DECISION_USAGE)
  if (modes.length > 1) throw new Error(`give one of ${MODES.join(', ')}, not ${modes.join(' and ')}`)
  const mode = modes[0]
  const hashid = required(mode)
  if (!/^p_[A-Za-z0-9]+$/.test(hashid)) throw new Error(`${hashid} is not a Pipedream workflow id (p_ and letters or digits)`)
  const apply = argv.includes('--apply')

  switch (mode) {
    case '--retire':
      return { request: { kind: 'retire', hashid, by: required('--by'), reason: required('--reason') }, exportDir: null, apply }
    case '--unretire':
      return { request: { kind: 'unretire', hashid }, exportDir: null, apply }
    case '--drop-step':
      return { request: { kind: 'drop_step', hashid, step: required('--step'), by: required('--by'), reason: required('--reason') }, exportDir: required('--export'), apply }
    case '--keep-step':
      return { request: { kind: 'keep_step', hashid, step: required('--step') }, exportDir: null, apply }
  }
}

export interface RecordOptions {
  apply: boolean
  now: string
  /** The workflow's step namespaces in the export the person named; only a dropped step needs them. */
  exportSteps: string[] | null
}

/** Returns the lines to print. Throws, having written nothing, on any refusal; throws after a write that did not land as planned. */
export async function recordDecision(f: typeof fetch, url: string, key: string, req: DecisionRequest, opts: RecordOptions): Promise<string[]> {
  const before = await readDecisionTarget(f, url, key, req.hashid)
  const plan = planDecision(req, before, opts.exportSteps, opts.now)
  const lines = [`Plan: ${plan.describe}`]
  if (!opts.apply) return [...lines, 'Nothing written: run again with --apply to write.']

  await writeDecision(f, url, key, plan.write, opts.now)
  const after = await readDecisionTarget(f, url, key, req.hashid)
  const wrong = decisionDifferences(plan.write, after)
  if (wrong.length > 0) throw new Error(`Written, but the read back differs: ${wrong.join('; ')}`)
  return [...lines, 'Written, and read back as planned.']
}
