import { describe, it, expect } from 'vitest'
import { findWorkflowCycle } from '../workflow-validation'

// The shared cycle check reads a node's namespace at the top level (#1698); the
// canvas maps its React Flow nodes to this shape before calling it.
const node = (id: string, namespace = id) => ({ id, namespace })
const edge = (source: string, target: string) => ({ source, target })

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
