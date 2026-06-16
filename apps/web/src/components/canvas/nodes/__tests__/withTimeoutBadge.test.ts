import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { withTimeoutBadge } from '../withTimeoutBadge'
import { TimeoutWarningBadge } from '../TimeoutWarningBadge'

// The web test suite runs in a node environment with no DOM, but a function
// component is just a function returning React element objects — so we can call
// the wrapped component directly and inspect the returned tree (the original
// node element plus the conditional badge) without rendering.

const FakeNode = () => null

function callWrapped(type: string, config: Record<string, unknown> = {}, namespace = 'step_1') {
  const Wrapped = withTimeoutBadge(FakeNode) as (props: unknown) => ReactElement
  const out = Wrapped({ type, data: { config, namespace, variables: {} }, selected: false })
  const children = (out.props as { children: unknown[] }).children
  return { node: children[0] as ReactElement, badge: children[1] }
}

describe('withTimeoutBadge', () => {
  it('always renders the wrapped node and passes props straight through', () => {
    const { node } = callWrapped('data_store', { timeout_ms: 500 }, 'cache_step')
    expect(node.type).toBe(FakeNode)
    expect((node.props as { type: string }).type).toBe('data_store')
    expect((node.props as { data: { namespace: string } }).data.namespace).toBe('cache_step')
  })

  it('appends the timeout badge for a timeout-bearing node type', () => {
    const config = { timeout_ms: 500 }
    const { badge } = callWrapped('data_store', config, 'cache_step')
    const el = badge as ReactElement
    expect(el.type).toBe(TimeoutWarningBadge)
    expect((el.props as { type: string }).type).toBe('data_store')
    expect((el.props as { config: unknown }).config).toBe(config)
    expect((el.props as { namespace: string }).namespace).toBe('cache_step')
  })

  it.each(['trigger', 'parallel_end', 'branch_end'])(
    'does not append the badge for excluded type %s',
    (type) => {
      const { badge } = callWrapped(type)
      expect(badge).toBe(false)
    },
  )

  it('sets a descriptive displayName for devtools', () => {
    const Wrapped = withTimeoutBadge(FakeNode)
    expect(Wrapped.displayName).toBe('withTimeoutBadge(FakeNode)')
  })
})
