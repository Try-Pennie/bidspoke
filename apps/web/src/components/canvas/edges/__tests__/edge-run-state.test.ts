/**
 * Which edges an execution took (#1503).
 *
 * The canvas used to call an edge taken whenever the nodes at both ends ran.
 * Buyer Select's four exits all converge on Build Response Body, which runs on
 * every lead, so every exit read as taken and the real path was unreadable.
 * A node that records its choice in `_route` is now judged by that choice, the
 * same way the engine picks its next edge.
 */
import { describe, it, expect } from 'vitest'
import { edgeRunStates, type RunStep } from '../edge-run-state'

// Buyer Select as wired on the Engine workflow: sold and no_sale go straight
// to build_response_body, not_applicable and deferred go through tripoint_ping.
const edges = [
  { id: 'in', source: 'trigger', target: 'select', sourceHandle: null },
  { id: 'sold', source: 'select', target: 'build', sourceHandle: 'sold' },
  { id: 'no_sale', source: 'select', target: 'build', sourceHandle: 'no_sale' },
  { id: 'not_applicable', source: 'select', target: 'tripoint', sourceHandle: 'not_applicable' },
  { id: 'deferred', source: 'select', target: 'tripoint', sourceHandle: 'deferred' },
  { id: 'tp_out', source: 'tripoint', target: 'build', sourceHandle: 'output' },
]

function stepsFor(steps: Record<string, RunStep>) {
  return (nodeId: string) => steps[nodeId]
}

describe('edgeRunStates', () => {
  it('marks only the exit the node routed to as taken when exits converge', () => {
    const states = edgeRunStates(edges, stepsFor({
      select: { status: 'completed', route: 'deferred' },
      tripoint: { status: 'completed' },
      build: { status: 'completed' },
    }))
    expect(states.get('deferred')).toBe('taken')
    expect(states.get('sold')).toBe('not_taken')
    expect(states.get('no_sale')).toBe('not_taken')
    expect(states.get('not_applicable')).toBe('not_taken')
    expect(states.get('tp_out')).toBe('taken')
    expect(states.get('in')).toBe('taken')
  })

  it('reads the route from the step output when no summary route is present', () => {
    // Test runs stream full steps, output included, with no separate route field.
    const states = edgeRunStates(edges, stepsFor({
      select: { status: 'completed', output: { _route: 'sold' } },
      build: { status: 'completed' },
    }))
    expect(states.get('sold')).toBe('taken')
    expect(states.get('no_sale')).toBe('not_taken')
    expect(states.get('not_applicable')).toBe('not_taken')
  })

  it('keeps the both ends ran rule for a node that records no route', () => {
    const states = edgeRunStates(edges, stepsFor({
      select: { status: 'completed' },
      tripoint: { status: 'completed' },
      build: { status: 'completed' },
    }))
    expect(states.get('sold')).toBe('taken')
    expect(states.get('deferred')).toBe('taken')
  })

  it('falls back to the both ends ran rule when no exit is wired to the route', () => {
    // The engine falls back to edge conditions here, which the canvas cannot
    // evaluate, so it must not grey out every exit.
    const states = edgeRunStates(edges, stepsFor({
      select: { status: 'completed', route: 'unwired_handle' },
      build: { status: 'completed' },
    }))
    expect(states.get('sold')).toBe('taken')
    expect(states.get('not_applicable')).toBe('not_taken')
  })

  it('marks a taken edge failed when either end failed', () => {
    const states = edgeRunStates(edges, stepsFor({
      select: { status: 'completed', route: 'deferred' },
      tripoint: { status: 'failed' },
    }))
    expect(states.get('deferred')).toBe('taken_failed')
  })

  it('leaves edges out of a node that never ran unreached', () => {
    const states = edgeRunStates(edges, stepsFor({}))
    expect(states.get('in')).toBe('not_taken')
    expect(states.get('sold')).toBe('unreached')
  })
})
