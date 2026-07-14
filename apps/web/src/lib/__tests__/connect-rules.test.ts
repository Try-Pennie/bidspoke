import { describe, it, expect } from 'vitest'
import type { Edge } from '@xyflow/react'
import { isDuplicateConnection } from '../connect-rules'

const edge = (id: string, source: string, target: string, sourceHandle?: string | null, hidden?: boolean): Edge => ({
  id,
  source,
  target,
  ...(sourceHandle !== undefined ? { sourceHandle } : {}),
  ...(hidden ? { hidden: true } : {}),
})

describe('isDuplicateConnection (#566)', () => {
  it('does NOT count the hidden branch/branch_end backbone edge as a user connection', () => {
    // Every branch is created with a hidden backbone edge (branch -> branch_end,
    // sourceHandle 'output') purely so Dagre ranks the end below the start. It is
    // layout scaffolding, not a wire the user drew. Counting it as a duplicate is
    // what made "connect an arm straight to its own branch_end" silently do
    // nothing: the pair was already taken, forever, on every branch.
    const edges = [edge('backbone', 'branch', 'branch_end', 'output', true)]
    expect(
      isDuplicateConnection(edges, { source: 'branch', sourceHandle: 'else', target: 'branch_end' }),
    ).toBe(false)
  })

  it('lets two different arms of the same branch fold into the same node', () => {
    // Two arms converging on one destination is a real graph ("neither of these
    // paths needs special handling"), not a mistake. Keying the duplicate check on
    // source+target alone forbade it, so the SECOND arm would hit the same wall
    // the first one just cleared.
    const edges = [edge('e1', 'branch', 'branch_end', 'branch_1')]
    expect(
      isDuplicateConnection(edges, { source: 'branch', sourceHandle: 'else', target: 'branch_end' }),
    ).toBe(false)
  })

  it('still rejects a genuine duplicate: the same handle wired to the same target twice', () => {
    const edges = [edge('e1', 'branch', 'branch_end', 'else')]
    expect(
      isDuplicateConnection(edges, { source: 'branch', sourceHandle: 'else', target: 'branch_end' }),
    ).toBe(true)
  })

  it('treats a legacy null handle and an explicit "output" handle as the SAME output', () => {
    // The original reason this check existed: an unstyled node used to produce a
    // null-handle edge, and re-wiring it after the renderer landed added a second
    // 'output' edge to the same target. Same physical output, so still a duplicate.
    expect(
      isDuplicateConnection([edge('e1', 'code', 'resp', null)], {
        source: 'code',
        sourceHandle: 'output',
        target: 'resp',
      }),
    ).toBe(true)
    expect(
      isDuplicateConnection([edge('e1', 'code', 'resp', 'output')], {
        source: 'code',
        sourceHandle: null,
        target: 'resp',
      }),
    ).toBe(true)
    expect(
      isDuplicateConnection([edge('e1', 'code', 'resp')], {
        source: 'code',
        sourceHandle: undefined,
        target: 'resp',
      }),
    ).toBe(true)
  })

  it('allows the same handle to reach a different target', () => {
    const edges = [edge('e1', 'branch', 'nodeA', 'else')]
    expect(
      isDuplicateConnection(edges, { source: 'branch', sourceHandle: 'else', target: 'nodeB' }),
    ).toBe(false)
  })
})
