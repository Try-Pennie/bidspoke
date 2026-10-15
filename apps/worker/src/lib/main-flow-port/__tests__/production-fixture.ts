/**
 * The production Main Flow definition the port's tests run over (#2171).
 *
 * It is the money gate's fixture, which the export script refreshes from the
 * `Try-Pennie/bidspoke-workflows` backup and the gate refuses unless it equals
 * production (money-gate/README.md). The port is a transform over whatever the
 * canvas holds, so no hand kept copy of Main Flow exists; these tests read the
 * same file the gate replays.
 */
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import MAIN_FLOW_FIXTURE_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'
import { MAIN_FLOW_WORKFLOW_ID, type Definition } from '../transform'

/** A fresh copy on every call, so no test can change another's input. */
export function productionMainFlow(): Definition {
  const file = JSON.parse(MAIN_FLOW_FIXTURE_RAW as string) as { id: string; definition: Definition }
  if (file.id !== MAIN_FLOW_WORKFLOW_ID) throw new Error(`the Main Flow fixture names workflow ${file.id}`)
  return file.definition
}

type NodeLike = Definition['nodes'][number]

export const nodeByNamespace = (def: Definition, namespace: string): NodeLike => {
  const found = def.nodes.filter((n) => n.namespace === namespace)
  if (found.length !== 1) throw new Error(`expected one node ${namespace}, found ${found.length}`)
  return found[0]
}

/** The namespaces an edge out of `namespace` leads to, with each edge's handle. */
export const nextOf = (def: Definition, namespace: string): string[] => {
  const id = nodeByNamespace(def, namespace).id
  const byId = new Map(def.nodes.map((n) => [n.id, n.namespace]))
  return def.edges.filter((e) => e.source === id).map((e) => `${e.source_handle ?? 'output'}:${byId.get(e.target) ?? e.target}`)
}

/** The relay URL every outcome post shares, read from the fixture rather than written into this repo again. */
export function relayUrls(def: Definition): { submission: string; inquiries: string } {
  return {
    submission: String(nodeByNamespace(def, 'send_salesforce').config.url),
    inquiries: String(nodeByNamespace(def, 'send_salesforce_inquiry').config.url),
  }
}
