import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import type { Env } from '../index'
import type { WorkflowDefinition, EdgeDefinition } from '../types'
import { decryptSecret, secretKeys } from './secret-crypto'
import { parseJson } from './json'

interface ConfigDiff {
  before: unknown
  after: unknown
}

interface NodeAdded {
  namespace: string
  type: string
  label?: string
  config: Record<string, unknown>
}

interface NodeRemoved {
  namespace: string
  type: string
  label?: string
}

interface NodeModified {
  namespace: string
  type: string
  label_change?: { before?: string; after?: string }
  config_changes: Record<string, ConfigDiff>
}

interface EdgeChange {
  from: string
  to: string
  handle: string
}

export interface WorkflowDiff {
  nodes_added: NodeAdded[]
  nodes_removed: NodeRemoved[]
  nodes_modified: NodeModified[]
  edges_added: EdgeChange[]
  edges_removed: EdgeChange[]
  trigger_changed?: { before: unknown; after: unknown }
}

const edgeKey = (e: EdgeDefinition) => `${e.source}->${e.target}@${e.source_handle ?? 'output'}`

// branch_end / parallel_end nodes carry an auto-generated namespace
// (e.g. "branch_end_3"), but the canvas displays them with a derived
// namespace built from the paired start node (e.g. "engine_ok_branch_end").
// The changelog should match what the user sees on the canvas, so substitute
// the derived namespace before handing the diff to the LLM.
function buildDerivedNamespaces(def: WorkflowDefinition): Map<string, string> {
  const out = new Map<string, string>()
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]))
  for (const n of def.nodes) {
    if (n.type !== 'branch_end' && n.type !== 'parallel_end') continue
    const startType = n.type === 'branch_end' ? 'branch' : 'parallel'
    // Pair is found via the backbone edge: start --(output)--> end.
    const pairEdge = def.edges.find((e) => e.target === n.id && nodesById.get(e.source)?.type === startType)
    if (!pairEdge) continue
    const startNode = nodesById.get(pairEdge.source)
    if (!startNode) continue
    out.set(n.namespace, `${startNode.namespace}_end`)
  }
  return out
}

function rename(ns: string, derived: Map<string, string>): string {
  return derived.get(ns) ?? ns
}

export function computeDiff(oldDef: WorkflowDefinition, newDef: WorkflowDefinition): WorkflowDiff {
  const oldDerived = buildDerivedNamespaces(oldDef)
  const newDerived = buildDerivedNamespaces(newDef)
  const oldNodes = new Map(oldDef.nodes.map((n) => [n.namespace, n]))
  const newNodes = new Map(newDef.nodes.map((n) => [n.namespace, n]))

  const nodes_added: NodeAdded[] = []
  const nodes_removed: NodeRemoved[] = []
  const nodes_modified: NodeModified[] = []

  for (const [ns, n] of newNodes) {
    if (!oldNodes.has(ns)) {
      nodes_added.push({ namespace: rename(ns, newDerived), type: n.type, label: n.label, config: n.config as Record<string, unknown> })
    }
  }
  for (const [ns, n] of oldNodes) {
    if (!newNodes.has(ns)) {
      nodes_removed.push({ namespace: rename(ns, oldDerived), type: n.type, label: n.label })
    }
  }

  for (const [ns, newNode] of newNodes) {
    const oldNode = oldNodes.get(ns)
    if (!oldNode) continue
    const config_changes: Record<string, ConfigDiff> = {}
    const allKeys = new Set([...Object.keys(oldNode.config ?? {}), ...Object.keys(newNode.config ?? {})])
    for (const key of allKeys) {
      const oldVal = (oldNode.config as Record<string, unknown> | undefined)?.[key]
      const newVal = (newNode.config as Record<string, unknown> | undefined)?.[key]
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        config_changes[key] = { before: oldVal, after: newVal }
      }
    }
    const labelChanged = (oldNode.label ?? '') !== (newNode.label ?? '')
    if (Object.keys(config_changes).length > 0 || labelChanged) {
      nodes_modified.push({
        namespace: rename(ns, newDerived),
        type: newNode.type,
        ...(labelChanged ? { label_change: { before: oldNode.label, after: newNode.label } } : {}),
        config_changes,
      })
    }
  }

  // Edges reference node namespaces too — translate source/target so the LLM
  // sees consistent names across the diff (no half-derived references).
  const nsById = new Map<string, string>()
  for (const n of newDef.nodes) nsById.set(n.id, rename(n.namespace, newDerived))
  for (const n of oldDef.nodes) if (!nsById.has(n.id)) nsById.set(n.id, rename(n.namespace, oldDerived))
  const resolveEnd = (id: string) => nsById.get(id) ?? id

  const oldEdgeKeys = new Set(oldDef.edges.map(edgeKey))
  const newEdgeKeys = new Set(newDef.edges.map(edgeKey))
  const edges_added = newDef.edges
    .filter((e) => !oldEdgeKeys.has(edgeKey(e)))
    .map((e) => ({ from: resolveEnd(e.source), to: resolveEnd(e.target), handle: e.source_handle ?? 'output' }))
  const edges_removed = oldDef.edges
    .filter((e) => !newEdgeKeys.has(edgeKey(e)))
    .map((e) => ({ from: resolveEnd(e.source), to: resolveEnd(e.target), handle: e.source_handle ?? 'output' }))

  const triggerChanged = JSON.stringify(oldDef.trigger) !== JSON.stringify(newDef.trigger)

  return {
    nodes_added,
    nodes_removed,
    nodes_modified,
    edges_added,
    edges_removed,
    ...(triggerChanged ? { trigger_changed: { before: oldDef.trigger, after: newDef.trigger } } : {}),
  }
}

export function diffIsEmpty(d: WorkflowDiff): boolean {
  return (
    d.nodes_added.length === 0 &&
    d.nodes_removed.length === 0 &&
    d.nodes_modified.length === 0 &&
    d.edges_added.length === 0 &&
    d.edges_removed.length === 0 &&
    !d.trigger_changed
  )
}

export async function hashDefinition(def: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(def))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const SYSTEM_PROMPT = `You write changelog summaries for workflow edits in Bidspoke, a lead-routing automation platform where workflows orchestrate API calls, conditional logic, partner bidding, and Salesforce updates.

Output one or two short sentences (max 140 chars) describing exactly what changed. State the change concretely. Do not invent or infer the author's motivation. Examples:
- added credit score filter before partner bidding
- raised Tripoint timeout from 5s to 15s
- added fallback edge from bid evaluation to engine partner
- replaced hardcoded API key with env.TRIPOINT_KEY reference
- added two branches and an else path on the equifax_debt branch node

Common node types and what they do:
- filter: pass/exit gate based on rules
- branch: N-way conditional split
- branch_end: where a branch's arms rejoin
- code: arbitrary JS in a sandbox
- partner_bid: outbound bid request to a partner
- bid_group: fan out to partners and pick a winner
- parallel: fan-out to children
- parallel_end: where a parallel's children rejoin
- transform: field mapping
- constants: workflow constants plus partner data
- data_store: KV read/write with a TTL
- latency_gate: mark a time, then gate on the elapsed time
- achieve_offers: collect Achieve offers, log only
- buyer_select: sell the lead to the highest ranked eligible buyer
- buyer_click_send: send one clicked prospect to a click buyer once, and count it
- buyer_click_check: decide whether a click buyer may be offered this lead, against its profile and today's clicks
- lead_validation: ordered checks a lead must pass; the first it fails answers the source with that check's rejection reason
- response/exit: terminate with HTTP response
- salesforce: SF object create/update
- webhook: outbound HTTP call

Rules:
- Past tense, sentence case, no trailing period.
- No preamble. Never start with "this commit", "the user", "in this update".
- Name the node by its label or namespace when the change is scoped to one node.
- Be specific about what changed: which field, which value, which edge, which node added or removed.
- Do not append a rationale clause ("to handle X", "so that Y", "to avoid Z") unless it is literally encoded in the diff (e.g., a comment field). The author did not tell you why.
- Plain text only, no markdown.`

// Resolves the Anthropic API key. Prefers the org-scoped DB setting, falls back
// to the worker-level ANTHROPIC_API_KEY env. Returns null if neither is set.
export async function getAnthropicKey(
  env: Env,
  supabase: SupabaseClient,
  orgId: string
): Promise<string | null> {
  if (env.SECRET_ENCRYPTION_KEY) {
    const { data, error: dataError } = await supabase
      .from('app_settings')
      .select('value_encrypted')
      .eq('organization_id', orgId)
      .eq('key', 'anthropic_api_key')
      .maybeSingle()
    logReadFailure('changelog-drafter', 'workflow versions', dataError)
    if (data?.value_encrypted) {
      try {
        return await decryptSecret(data.value_encrypted as string, secretKeys(env))
      } catch (e) {
        console.error('[changelog-drafter] failed to decrypt anthropic_api_key:', e)
      }
    }
  }
  return env.ANTHROPIC_API_KEY ?? null
}

export async function draftChangelog(
  apiKey: string,
  diff: WorkflowDiff,
  workflowName: string
): Promise<string | null> {
  if (!apiKey) return null

  const userMsg = `Workflow: ${workflowName}\n\nDiff:\n${JSON.stringify(diff, null, 2)}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Anthropic ${res.status}: ${txt}`)
  }

  const data = await parseJson<{ content?: Array<{ type: string; text?: string }> }>(res)
  const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
  return text.trim() || null
}
