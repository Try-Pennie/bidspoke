import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { findWorkflowCycle } from '../workflow-validation'

const node = (id: string, namespace = id): Node =>
  ({ id, type: 'code', position: { x: 0, y: 0 }, data: { namespace } }) as unknown as Node
const edge = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target })

describe('findWorkflowCycle (#334)', () => {
  it('returns null for an acyclic chain', () => {
    expect(findWorkflowCycle([node('a'), node('b')], [edge('a', 'b')])).toBeNull()
  })

  it('returns null for a diamond', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
    expect(findWorkflowCycle(nodes, edges)).toBeNull()
  })

  it('detects a back-edge cycle and reports namespaces', () => {
    const nodes = [node('n1', 'validate'), node('n2', 'enrich')]
    const edges = [edge('n1', 'n2'), edge('n2', 'n1')]
    const cycle = findWorkflowCycle(nodes, edges)
    expect(cycle).not.toBeNull()
    expect(cycle).toContain('validate')
    expect(cycle).toContain('enrich')
  })

  it('detects a self-loop', () => {
    const cycle = findWorkflowCycle([node('a', 'loopy')], [edge('a', 'a')])
    expect(cycle).toEqual(['loopy', 'loopy'])
  })

  it('ignores the trigger pseudo-node', () => {
    expect(findWorkflowCycle([node('a'), node('b')], [edge('trigger', 'a'), edge('a', 'b')])).toBeNull()
  })
})
