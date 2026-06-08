import { describe, it, expect } from 'vitest'
import { findSubFloorNodes, scanWorkflowDefinitions, warningsSignature, findOverProvisionedNodes, suggestedTimeoutMs, type NodeDurationStats } from '../timeout-audit'
import type { WorkflowDefinition, NodeDefinition } from '../../types'

function node(partial: Partial<NodeDefinition> & { id: string; type: NodeDefinition['type'] }): NodeDefinition {
  return { namespace: partial.id, config: {}, ...partial }
}

function def(nodes: NodeDefinition[]): WorkflowDefinition {
  return { id: 'wf', name: 'wf', trigger: {} as WorkflowDefinition['trigger'], nodes, edges: [] }
}

describe('findSubFloorNodes', () => {
  it('flags a code node below the 150ms dispatch floor', () => {
    const out = findSubFloorNodes(def([node({ id: 'parsed_name', type: 'code', config: { timeout_ms: 50 } })]))
    expect(out).toEqual([
      { node_id: 'parsed_name', namespace: 'parsed_name', label: null, type: 'code', configured_ms: 50, floor_ms: 150 },
    ])
  })

  it('flags a network node below the 50ms floor and keeps the label', () => {
    const out = findSubFloorNodes(def([node({ id: 'sf', type: 'salesforce', label: 'Create Prospect', config: { timeout_ms: 25 } })]))
    expect(out[0]).toMatchObject({ node_id: 'sf', label: 'Create Prospect', configured_ms: 25, floor_ms: 50 })
  })

  it('does not flag a timeout that clears the floor', () => {
    expect(findSubFloorNodes(def([node({ id: 'c', type: 'code', config: { timeout_ms: 150 } })]))).toEqual([])
    expect(findSubFloorNodes(def([node({ id: 'c', type: 'code', config: { timeout_ms: 1000 } })]))).toEqual([])
  })

  it('ignores nodes with no timeout or a non-numeric timeout', () => {
    expect(findSubFloorNodes(def([node({ id: 'a', type: 'code', config: {} })]))).toEqual([])
    expect(findSubFloorNodes(def([node({ id: 'b', type: 'code', config: { timeout_ms: '50' as unknown as number } })]))).toEqual([])
  })

  it('returns empty for a missing or malformed definition', () => {
    expect(findSubFloorNodes(null)).toEqual([])
    expect(findSubFloorNodes(undefined)).toEqual([])
    expect(findSubFloorNodes({} as unknown as WorkflowDefinition)).toEqual([])
  })
})

describe('scanWorkflowDefinitions', () => {
  it('keeps only workflows that have at least one offending node', () => {
    const out = scanWorkflowDefinitions([
      { id: 'wf1', name: 'Engine Bidding', definition: def([node({ id: 'parsed_name', type: 'code', config: { timeout_ms: 50 } })]) },
      { id: 'wf2', name: 'Clean Flow', definition: def([node({ id: 'ok', type: 'code', config: { timeout_ms: 1000 } })]) },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ workflow_id: 'wf1', workflow_name: 'Engine Bidding' })
    expect(out[0].nodes).toHaveLength(1)
  })
})

describe('warningsSignature', () => {
  const a = scanWorkflowDefinitions([
    { id: 'wf1', name: 'A', definition: def([node({ id: 'n1', type: 'code', config: { timeout_ms: 50 } })]) },
    { id: 'wf2', name: 'B', definition: def([node({ id: 'n2', type: 'salesforce', config: { timeout_ms: 25 } })]) },
  ])

  it('is stable regardless of input ordering', () => {
    const reversed = [...a].reverse()
    expect(warningsSignature(a)).toBe(warningsSignature(reversed))
  })

  it('changes when a configured value changes', () => {
    const b = scanWorkflowDefinitions([
      { id: 'wf1', name: 'A', definition: def([node({ id: 'n1', type: 'code', config: { timeout_ms: 75 } })]) },
      { id: 'wf2', name: 'B', definition: def([node({ id: 'n2', type: 'salesforce', config: { timeout_ms: 25 } })]) },
    ])
    expect(warningsSignature(b)).not.toBe(warningsSignature(a))
  })

  it('is empty when there are no offenders', () => {
    expect(warningsSignature([])).toBe('')
  })
})

describe('suggestedTimeoutMs', () => {
  it('uses p99 x1.5 with max headroom, never below the floor', () => {
    // code floor = 150; p99 != max so max*1.05 applies
    expect(suggestedTimeoutMs('code', 200, 300)).toBe(315) // max(300, 315, 150)
    // p99 == max: just p99*1.5
    expect(suggestedTimeoutMs('code', 200, 200)).toBe(300)
    // tiny durations clamp up to the node-type floor
    expect(suggestedTimeoutMs('code', 10, 20)).toBe(150)
  })
})

describe('findOverProvisionedNodes', () => {
  const stats = (s: Partial<NodeDurationStats>): NodeDurationStats =>
    ({ p99: 200, max_ms: 300, sample_size: 100, ...s })

  it('flags a node configured far above its suggested value', () => {
    // suggested = 315; 3x = 945; configured 5000 > 945
    const out = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 5000 } })]),
      new Map([['n1', stats({})]])
    )
    expect(out[0]).toMatchObject({ node_id: 'n1', configured_ms: 5000, suggested_ms: 315, p99_ms: 200, sample_size: 100 })
  })

  it('does not flag when configured is within 3x of suggested', () => {
    const out = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 900 } })]), // < 945
      new Map([['n1', stats({})]])
    )
    expect(out).toEqual([])
  })

  it('does not flag without enough run history', () => {
    const out = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 5000 } })]),
      new Map([['n1', stats({ sample_size: 49 })]])
    )
    expect(out).toEqual([])
  })

  it('skips nodes with no stats, no timeout, or a non-numeric timeout', () => {
    const d = def([
      node({ id: 'no_stats', type: 'code', config: { timeout_ms: 5000 } }),
      node({ id: 'no_timeout', type: 'code', config: {} }),
    ])
    expect(findOverProvisionedNodes(d, new Map())).toEqual([])
  })
})
