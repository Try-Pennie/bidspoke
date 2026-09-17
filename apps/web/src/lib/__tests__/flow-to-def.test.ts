/**
 * flowToDef is the one serialiser every canvas save goes through, so it is where a code
 * node's script is cleaned before it leaves the browser (#1117). It has to happen HERE and
 * not only on the server: the dirty signature and the save both read flowToDef, so a server
 * side trim alone would make the stored definition differ from what the canvas just sent,
 * and save verification would report a false mismatch.
 */
import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { flowToDef } from '../flow-to-def'

const trigger = { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } as const

function codeNode(id: string, script: string): Node {
  return {
    id,
    type: 'code',
    position: { x: 0, y: 0 },
    data: { namespace: id, label: id, config: { script, retries: 2 } },
  }
}

describe('flowToDef (#1117)', () => {
  it('strips trailing whitespace from a code node script, leaving template literal lines alone', () => {
    const padded = 'const a = 1;    \nconst body = `keep   \n`;   \nreturn body;   '
    const def = flowToDef([codeNode('c1', padded)], [], trigger)
    expect(def.nodes[0].config.script).toBe('const a = 1;\nconst body = `keep   \n`;\nreturn body;')
  })

  it('leaves the rest of the node config and a clean script untouched', () => {
    const def = flowToDef([codeNode('c1', 'return 1;\n')], [], trigger)
    expect(def.nodes[0].config).toEqual({ script: 'return 1;\n', retries: 2 })
  })

  it('drops the trigger pseudo node and serialises edges with their handle', () => {
    const triggerNode: Node = { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }
    const edge: Edge = { id: 'e1', source: 'trigger', target: 'c1', sourceHandle: 'out' }
    const def = flowToDef([triggerNode, codeNode('c1', 'return 1;')], [edge], trigger)
    expect(def.nodes.map((n) => n.id)).toEqual(['c1'])
    expect(def.edges).toEqual([{ id: 'e1', source: 'trigger', target: 'c1', source_handle: 'out', condition: undefined }])
  })
})
