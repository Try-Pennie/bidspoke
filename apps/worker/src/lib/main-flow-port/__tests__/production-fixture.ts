/**
 * The production Main Flow definition the port's tests run over (#2171, #2173).
 *
 * It is Main Flow version 169, the last version saved before any stage was
 * applied, read from `workflow_versions` and committed beside these tests as
 * their own fixed input (`fixtures/main-flow-v169.json`). Until the first canary
 * they read the money gate's fixture directly, but once a stage is live that
 * fixture is part ported, and the transform's tests need the definition the port
 * starts from: nine relay posts, none of them native yet.
 *
 * The gate's fixture is held to this copy instead: `gate-fixture.test.ts`
 * requires it to equal the transform of version 169 at the stage last applied,
 * so a canvas save on Main Flow that the port did not make fails there by name
 * on the next fixture refresh.
 */
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import MAIN_FLOW_V169_RAW from './fixtures/main-flow-v169.json?raw'
import { MAIN_FLOW_WORKFLOW_ID, type Definition } from '../transform'

/** The Main Flow version the copy is, as `workflow_versions` numbers it. */
export const PRE_PORT_VERSION = 169

/** A fresh copy on every call, so no test can change another's input. */
export function productionMainFlow(): Definition {
  const file = JSON.parse(MAIN_FLOW_V169_RAW as string) as { id: string; version_number: number; definition: Definition }
  if (file.id !== MAIN_FLOW_WORKFLOW_ID) throw new Error(`the Main Flow fixture names workflow ${file.id}`)
  if (file.version_number !== PRE_PORT_VERSION) throw new Error(`the Main Flow fixture is version ${file.version_number}, not ${PRE_PORT_VERSION}`)
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
