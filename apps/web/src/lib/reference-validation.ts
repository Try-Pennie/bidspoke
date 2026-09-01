/**
 * Build-time validation of `steps.X.Y.Z` references (#424).
 *
 * Complementary to the runtime silent-output detector (#410), which catches a
 * field that stops carrying a value. This catches a reference that could never
 * have carried one: a node that does not exist, or one that does not run before
 * the node reading it. Both resolve to `undefined` at run time, and undefined is
 * DROPPED from a JSON body rather than sent empty, so nothing fails and nobody
 * is told (L505). #709 and #1037 are two live instances, each found by a person
 * reading a log line by hand.
 *
 * The reference syntax comes from the shared parser (#433), so what is validated
 * here is what the engine resolves.
 *
 * Deliberately says NOTHING about the field after the namespace. A step's output
 * shape is not knowable from the definition, so a warning there would be noise
 * an author cannot act on, and a validator that cries wolf gets switched off
 * (L36). A client-side rule stricter than the server also blocks input the
 * engine would accept, which leaves the author stuck against a rule nothing
 * states (L99). Only what is provably wrong is reported.
 */
import { extractStepChains } from '@bidspoke/references'

/**
 * The minimum a node has to look like to be validated. Structural rather than
 * the full NodeDef, so the canvas can pass what it already holds instead of
 * assembling a fake definition, and one implementation serves both the live
 * editor and a save-time sweep.
 */
export interface RefNode {
  id: string
  namespace: string
  config?: Record<string, unknown>
  variables?: Record<string, string>
}

export interface RefEdge {
  source: string
  target: string
  condition?: unknown
}

export type ReferenceSeverity = 'error' | 'warning'

export interface ReferenceProblem {
  /** The node the reference is written on. */
  nodeId: string
  namespace: string
  /** The step namespace the reference names. */
  reference: string
  severity: ReferenceSeverity
  message: string
}

/** The namespace a chain names, which is its first segment after the root. */
function referencedNamespace(chain: string): string {
  const parts = chain.replace(/\s+/g, '').replace(/\?\./g, '.').split('.')
  return parts[1] ?? ''
}

/**
 * Every namespace that runs before `nodeId`.
 *
 * A plain reverse walk of the graph. Guarded against revisiting a node so a
 * cycle terminates rather than hanging: a cyclic graph is invalid and reported
 * by findWorkflowCycle, but the author's graph is briefly cyclic while they are
 * dragging an edge, and a hang there would freeze the editor.
 */
export function upstreamNamespaces(nodes: RefNode[], edges: RefEdge[], nodeId: string): Set<string> {
  const namespaceById = new Map(nodes.map((n) => [n.id, n.namespace]))
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    const list = parents.get(e.target)
    if (list) list.push(e.source)
    else parents.set(e.target, [e.source])
  }

  const seen = new Set<string>()
  const out = new Set<string>()
  const stack = [...(parents.get(nodeId) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const ns = namespaceById.get(id)
    if (ns) out.add(ns)
    stack.push(...(parents.get(id) ?? []))
  }
  return out
}

/**
 * Collect `steps.*` chains from a config tree.
 *
 * Skips a `script` key. A code node's script runs in a sandbox and can
 * legitimately mention names the graph does not have: a comment, a string, a
 * local variable. Validating it would produce errors the author cannot act on,
 * and the live definitions carry exactly that (three `$return_value` mentions,
 * all inside comments).
 */
function collectChains(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const chain of extractStepChains(value)) into.add(chain)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectChains(item, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'script') continue
      collectChains(v, into)
    }
  }
}

interface Options {
  /** Extra namespaces treated as reachable, for a config not yet on the graph. */
  extraReachable?: Set<string>
}

/**
 * Problems in one node's config, judged from where that node sits in the graph.
 *
 * Reported once per distinct namespace, not once per occurrence: an author who
 * wrote the same wrong name in six fields has one thing to fix, and six
 * identical messages would bury the other findings.
 */
export function validateNodeReferences(
  nodes: RefNode[],
  edges: RefEdge[],
  nodeId: string,
  config: Record<string, unknown>,
  options: Options = {},
): ReferenceProblem[] {
  const self = nodes.find((n) => n.id === nodeId)
  const known = new Set(nodes.map((n) => n.namespace))
  const upstream = upstreamNamespaces(nodes, edges, nodeId)
  for (const extra of options.extraReachable ?? []) upstream.add(extra)

  const chains = new Set<string>()
  collectChains(config, chains)

  const problems: ReferenceProblem[] = []
  const reported = new Set<string>()
  for (const chain of chains) {
    const ns = referencedNamespace(chain)
    if (!ns || reported.has(ns)) continue
    if (upstream.has(ns)) continue

    let message: string | null = null
    if (self && ns === self.namespace) {
      // Named separately: telling an author there is no node called `x` while
      // they are looking at the node called `x` sends them hunting for the
      // wrong thing (L11).
      message = `This step reads itself (steps.${ns}), which has no output yet when it runs`
    } else if (!known.has(ns)) {
      message = `No step named ${ns} in this workflow`
    } else {
      message = `${ns} does not run before this step, so steps.${ns} is always empty here`
    }

    reported.add(ns)
    problems.push({
      nodeId,
      namespace: self?.namespace ?? nodeId,
      reference: ns,
      severity: 'error',
      message,
    })
  }
  return problems
}

/**
 * Every problem across a whole definition, for a save-time or audit sweep.
 *
 * An edge condition is judged against the edge's SOURCE, because the engine
 * evaluates it after the source has run, so it may read the source's own output.
 * Judging it against the target would report a correct condition as broken.
 */
export function validateDefinitionReferences(nodes: RefNode[], edges: RefEdge[]): ReferenceProblem[] {
  const problems: ReferenceProblem[] = []
  for (const n of nodes) {
    problems.push(...validateNodeReferences(nodes, edges, n.id, n.config ?? {}))
    if (n.variables) problems.push(...validateNodeReferences(nodes, edges, n.id, n.variables))
  }
  for (const e of edges) {
    if (!e.condition) continue
    const source = nodes.find((n) => n.id === e.source)
    if (!source) continue
    problems.push(
      ...validateNodeReferences(nodes, edges, e.source, e.condition as unknown as Record<string, unknown>, {
        extraReachable: new Set([source.namespace]),
      }),
    )
  }
  return problems
}
