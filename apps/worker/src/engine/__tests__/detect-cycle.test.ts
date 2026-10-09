/**
 * Cycle detection for the save-time acyclicity guard (#334). A cyclic workflow
 * definition would loop forever at run time (bounded only by the #260 step
 * ceiling); rejecting it at save catches the misconfiguration in the editor
 * before it ever processes a lead.
 */
import { describe, it, expect } from 'vitest'
// The one cycle check both apps share (#1698). This suite drives it with the
// worker's own NodeDefinition/EdgeDefinition, proving they flow through the
// shared function exactly as the removed detectCycle did.
import { findWorkflowCycle } from '@bidspoke/workflow-definition'
import type { NodeDefinition, EdgeDefinition } from '../../types'

const node = (id: string, namespace = id): NodeDefinition => ({ id, namespace, type: 'code', config: {} })
const edge = (source: string, target: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target })

describe('findWorkflowCycle (#334)', () => {
  it('returns null for a linear chain', () => {
    expect(findWorkflowCycle([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')])).toBeNull()
  })

  it('returns null for a diamond (convergent but acyclic)', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
    expect(findWorkflowCycle(nodes, edges)).toBeNull()
  })

  it('detects a back-edge cycle and names the looping nodes', () => {
    const nodes = [node('a'), node('b'), node('c')]
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')]
    const cycle = findWorkflowCycle(nodes, edges)
    expect(cycle).not.toBeNull()
    // b and c form the loop.
    expect(cycle).toContain('b')
    expect(cycle).toContain('c')
  })

  it('detects a self-loop', () => {
    expect(findWorkflowCycle([node('a')], [edge('a', 'a')])).toEqual(['a', 'a'])
  })

  it('reports node namespaces, not raw ids', () => {
    const nodes = [node('n1', 'validate'), node('n2', 'enrich')]
    const edges = [edge('n1', 'n2'), edge('n2', 'n1')]
    const cycle = findWorkflowCycle(nodes, edges)
    expect(cycle).toContain('validate')
    expect(cycle).toContain('enrich')
  })

  it('ignores the trigger pseudo-node (no incoming edge, can not be in a cycle)', () => {
    const nodes = [node('a'), node('b')]
    const edges = [edge('trigger', 'a'), edge('a', 'b')]
    expect(findWorkflowCycle(nodes, edges)).toBeNull()
  })

  it('returns null for an empty graph', () => {
    expect(findWorkflowCycle([], [])).toBeNull()
  })
})
