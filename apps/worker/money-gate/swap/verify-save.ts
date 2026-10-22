/**
 * The check after a lead validation swap is saved (#2592, part of #934): what
 * Dan saved is what was proved, and nothing else in the workflow moved.
 *
 * It compares the saved version with the one before it:
 *  - the version before holds the code step the candidate replaces, with the
 *    script whose md5 the candidate pins (so the proofs compared against what
 *    was actually replaced);
 *  - the saved version holds exactly one step with the candidate's namespace,
 *    and its type, label, config and variables are byte for byte the
 *    candidate's (compared as canonical JSON, so key order does not count);
 *  - every other step is unchanged apart from its position, and every edge is
 *    unchanged once the old step id is read as the new one;
 *  - when the candidate sets Constants values (constants_data, Lead Economy's
 *    minimumLoanAmount, #2594), the one Constants step holds exactly those
 *    values, said as a note when they changed, and nothing else in it moved;
 *  - the live workflow row holds the saved version.
 *
 * What the canvas paste necessarily changes is said apart as a NOTE, never a
 * problem: the pasted step gets a new id (the canvas mints one on every paste),
 * so the two edges into and out of it are made again with new ids, and the
 * canvas re-lays out the cards, which can move them. Everything else is a
 * problem. Pure; the read only CLI is scripts/lead-validation-swap-verify.ts.
 */
import { createHash } from 'node:crypto'
import type { SwapCandidate } from './candidate'

type Json = unknown
interface NodeLike { id: string; namespace?: string; type?: string; position?: Json; config?: Record<string, Json>; [k: string]: Json }
interface EdgeLike { id?: string; source: string; target: string; [k: string]: Json }
export interface DefinitionLike { nodes: NodeLike[]; edges: EdgeLike[]; [k: string]: Json }

export interface DefinitionVersion {
  version_number: number
  definition: DefinitionLike
}

export interface SwapVerification {
  ok: boolean
  problems: string[]
  notes: string[]
}

/** JSON with object keys sorted and undefined dropped, so two equal values print the same. */
export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, Json>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const same = (a: Json, b: Json) => canonical(a) === canonical(b)

/** The paths at which two values differ, as `a.b[2].c`; the root as `(whole)`. */
export function differingPaths(a: Json, b: Json, path = ''): string[] {
  if (same(a, b)) return []
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)
  if (!bothObjects) return [path || '(whole)']
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...differingPaths(a[i], b[i], `${path}[${i}]`))
    return out
  }
  const ao = a as Record<string, Json>
  const bo = b as Record<string, Json>
  const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()
  return keys.flatMap((k) => differingPaths(ao[k], bo[k], path ? `${path}.${k}` : k))
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
/** How a note about a Constants value the candidate set begins, which the report's headline reads. */
const CONSTANTS_NOTE = 'the Constants step\'s '
const nodeName = (n: NodeLike) => `${String(n.namespace ?? '?')} (${n.id})`

export function verifySavedSwap(candidate: SwapCandidate, previous: DefinitionVersion, saved: DefinitionVersion, live: DefinitionLike): SwapVerification {
  const problems: string[] = []
  const notes: string[] = []
  const prev = previous.definition
  const next = saved.definition
  const ns = candidate.replaces.namespace

  // The version before holds the proven script.
  const old = prev.nodes.find((n) => n.id === candidate.replaces.node_id)
  const script = old?.config?.script
  if (!old || old.type !== 'code' || old.namespace !== ns || typeof script !== 'string' || md5(script) !== candidate.replaces.script_md5) {
    problems.push(`version ${previous.version_number} does not hold the script the proofs compared against (code step ${ns}, id ${candidate.replaces.node_id}, md5 ${candidate.replaces.script_md5})`)
  }

  // The saved step is the candidate.
  const matches = next.nodes.filter((n) => n.namespace === ns)
  const swapped = matches.length === 1 ? matches[0] : null
  if (!swapped) problems.push(`version ${saved.version_number} holds ${matches.length} steps named ${ns}, not one`)
  else {
    const want: Record<string, Json> = { namespace: ns, label: candidate.node.label, type: candidate.node.type, config: candidate.node.config, variables: candidate.node.variables ?? {} }
    const { id: _id, position: _position, ...got } = swapped
    for (const p of differingPaths(want, { variables: {}, ...got })) problems.push(`the saved ${ns} step differs from the candidate at ${p}`)
    if (swapped.id !== candidate.replaces.node_id) notes.push(`the step's id changed from ${candidate.replaces.node_id} to ${swapped.id} (the canvas gives a pasted step a new id)`)
  }

  // The live row holds the saved version.
  if (!same(live, next)) problems.push(`the live workflow is not version ${saved.version_number}: ${differingPaths(next, live).slice(0, 10).join(', ')}`)

  // Everything outside the nodes and edges.
  const { nodes: _pn, edges: _pe, ...prevRest } = prev
  const { nodes: _nn, edges: _ne, ...nextRest } = next
  for (const p of differingPaths(prevRest, nextRest)) problems.push(`the definition's ${p} changed`)

  // The Constants values the candidate sets (Lead Economy's minimumLoanAmount,
  // #2594): the one Constants step must hold exactly them, and nothing else in it
  // may move.
  const constantsData = candidate.constants_data ?? {}
  const constantsKeys = Object.keys(constantsData)
  const constantsSteps = prev.nodes.filter((n) => n.type === 'constants')
  if (constantsKeys.length && constantsSteps.length !== 1) {
    problems.push(`the candidate sets Constants values but version ${previous.version_number} has ${constantsSteps.length} Constants steps`)
  }
  const constantsId = constantsKeys.length && constantsSteps.length === 1 ? constantsSteps[0].id : null
  const dataOf = (n: NodeLike): Record<string, Json> => ((n.config?.data ?? {}) as Record<string, Json>)

  // Every other step: unchanged apart from where its card sits.
  const newId = swapped?.id ?? candidate.replaces.node_id
  const prevOthers = new Map(prev.nodes.filter((n) => n.id !== candidate.replaces.node_id).map((n) => [n.id, n]))
  const nextOthers = new Map(next.nodes.filter((n) => n !== swapped).map((n) => [n.id, n]))
  const moved: string[] = []
  for (const [id, n] of prevOthers) {
    const m = nextOthers.get(id)
    if (!m) { problems.push(`step ${nodeName(n)} is missing from version ${saved.version_number}`); continue }
    const { position: pp, ...pn } = n
    const { position: mp, ...mn } = m
    if (id === constantsId) {
      const was = dataOf(n)
      const now = dataOf(m)
      for (const k of constantsKeys) {
        if (!same(now[k], constantsData[k])) problems.push(`the Constants step's ${k} is ${JSON.stringify(now[k])}, not the ${JSON.stringify(constantsData[k])} the candidate sets`)
        else if (!same(was[k], constantsData[k])) notes.push(`${CONSTANTS_NOTE}${k} changed from ${JSON.stringify(was[k])} to ${JSON.stringify(constantsData[k])}, as the candidate sets`)
      }
      // Everything else in the step, compared with the candidate's values in place.
      const expected = { ...pn, config: { ...(pn.config ?? {}), data: { ...was, ...constantsData } } }
      const asSet = { ...mn, config: { ...(mn.config ?? {}), data: { ...now, ...constantsData } } }
      for (const p of differingPaths(expected, asSet)) problems.push(`step ${nodeName(n)} changed at ${p}`)
    } else {
      for (const p of differingPaths(pn, mn)) problems.push(`step ${nodeName(n)} changed at ${p}`)
    }
    if (!same(pp, mp)) moved.push(String(n.namespace ?? id))
  }
  for (const [id, m] of nextOthers) if (!prevOthers.has(id)) problems.push(`step ${nodeName(m)} is new in version ${saved.version_number}`)
  if (moved.length) notes.push(`moved on the canvas only: ${moved.join(', ')}`)

  // Every edge, with the old step id read as the new one, compared without its id.
  const mapId = (id: string) => (id === candidate.replaces.node_id ? newId : id)
  const key = ({ id: _i, ...e }: EdgeLike) => canonical({ ...e, source: mapId(e.source), target: mapId(e.target) })
  const nextByKey = new Map<string, EdgeLike[]>()
  for (const e of next.edges) nextByKey.set(key(e), [...(nextByKey.get(key(e)) ?? []), e])
  let remade = 0
  for (const e of prev.edges) {
    const k = key(e)
    const pool = nextByKey.get(k)
    if (!pool?.length) { problems.push(`edge ${String(e.id)} (${e.source} to ${e.target}) is missing or changed in version ${saved.version_number}`); continue }
    const exact = pool.findIndex((x) => x.id === e.id)
    const [match] = pool.splice(exact >= 0 ? exact : 0, 1)
    if (match.id === e.id) continue
    const touches = e.source === candidate.replaces.node_id || e.target === candidate.replaces.node_id
    if (touches) remade += 1
    else problems.push(`edge ${String(e.id)} (${e.source} to ${e.target}) does not touch the step but is now ${String(match.id)}`)
  }
  for (const pool of nextByKey.values()) for (const e of pool) problems.push(`edge ${String(e.id)} (${e.source} to ${e.target}) is new in version ${saved.version_number}`)
  if (remade) notes.push(`${remade} edges into or out of the step were made again with new ids, joining the same steps by the same outputs`)

  return { ok: problems.length === 0, problems, notes }
}

/** The report the CLI prints. */
export function formatSwapVerification(r: SwapVerification, label: string): string {
  const setConstants = r.notes.some((n) => n.startsWith(CONSTANTS_NOTE))
  const pass = `PASS, only the validation step${setConstants ? ' and the Constants values the candidate sets' : ''} changed`
  const lines = [`${label}: ${r.ok ? pass : `FAIL, ${r.problems.length} difference(s)`}`]
  for (const p of r.problems) lines.push(`  problem: ${p}`)
  for (const n of r.notes) lines.push(`  note: ${n}`)
  return lines.join('\n')
}
