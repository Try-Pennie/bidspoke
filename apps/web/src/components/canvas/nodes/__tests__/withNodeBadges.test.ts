import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { withNodeBadges } from '../withNodeBadges'
import { TimeoutWarningBadge } from '../TimeoutWarningBadge'
import { NodeWarningGlow } from '../NodeWarningGlow'
import { SuccessBadge } from '../SuccessBadge'
import { NoteBadge } from '../NoteBadge'

// The web test suite runs in a node environment with no DOM, but a function
// component is just a function returning React element objects — so we can call
// the wrapped component directly and inspect the returned tree (the original
// node element plus the conditional badges) without rendering.
//
// Children order from the HOC: [node, timeoutBadge, successBadge, noteBadge,
// warningGlow]. Each badge slot is `false` when that badge is skipped for the
// type.

const FakeNode = () => null

function callWrapped(
  type: string,
  config: Record<string, unknown> = {},
  namespace = 'step_1',
  extraData: Record<string, unknown> = {},
) {
  const Wrapped = withNodeBadges(FakeNode) as (props: unknown) => ReactElement
  const out = Wrapped({ type, data: { config, namespace, variables: {}, ...extraData }, selected: false })
  const children = (out.props as { children: unknown[] }).children
  return {
    node: children[0] as ReactElement,
    timeoutBadge: children[1],
    successBadge: children[2],
    noteBadge: children[3],
    warningGlow: children[4],
  }
}

describe('withNodeBadges', () => {
  it('always renders the wrapped node and passes props straight through', () => {
    const { node } = callWrapped('data_store', { timeout_ms: 500 }, 'cache_step')
    expect(node.type).toBe(FakeNode)
    expect((node.props as { type: string }).type).toBe('data_store')
    expect((node.props as { data: { namespace: string } }).data.namespace).toBe('cache_step')
  })

  it('appends the timeout badge for a timeout-bearing node type', () => {
    const config = { timeout_ms: 500 }
    const { timeoutBadge } = callWrapped('data_store', config, 'cache_step')
    const el = timeoutBadge as ReactElement
    expect(el.type).toBe(TimeoutWarningBadge)
    expect((el.props as { type: string }).type).toBe('data_store')
    expect((el.props as { config: unknown }).config).toBe(config)
    expect((el.props as { namespace: string }).namespace).toBe('cache_step')
  })

  it.each(['trigger', 'parallel_end', 'branch_end'])(
    'does not append the timeout badge for excluded type %s',
    (type) => {
      const { timeoutBadge } = callWrapped(type)
      expect(timeoutBadge).toBe(false)
    },
  )

  it('appends the success and note badges with data-driven props for a standard node', () => {
    const { successBadge, noteBadge } = callWrapped('code', {}, 'step_1', {
      isSuccessNode: true,
      note: 'check this',
    })
    const success = successBadge as ReactElement
    const noteEl = noteBadge as ReactElement
    expect(success.type).toBe(SuccessBadge)
    expect((success.props as { visible: boolean }).visible).toBe(true)
    expect(noteEl.type).toBe(NoteBadge)
    expect((noteEl.props as { note: string }).note).toBe('check this')
  })

  it.each(['branch_end', 'region'])(
    'skips the corner badges for non-card type %s (its layout positions them itself)',
    (type) => {
      const { successBadge, noteBadge } = callWrapped(type, {}, 'x', { isSuccessNode: true, note: 'n' })
      expect(successBadge).toBe(false)
      expect(noteBadge).toBe(false)
    },
  )

  it('still gives a standard non-timeout type (e.g. filter) its corner badges', () => {
    const { successBadge, noteBadge } = callWrapped('filter', {}, 'f1', { isSuccessNode: false, note: undefined })
    // Elements are present (self-gating on visible/note happens inside them).
    expect((successBadge as ReactElement).type).toBe(SuccessBadge)
    expect((noteBadge as ReactElement).type).toBe(NoteBadge)
  })

  it('appends the warning glow with the node type, config, namespace and hasError', () => {
    const config = { timeout_ms: 500 }
    const { warningGlow } = callWrapped('code', config, 'cn', { hasError: true })
    const el = warningGlow as ReactElement
    expect(el.type).toBe(NodeWarningGlow)
    expect((el.props as { type: string }).type).toBe('code')
    expect((el.props as { config: unknown }).config).toBe(config)
    expect((el.props as { namespace: string }).namespace).toBe('cn')
    expect((el.props as { hasError: boolean }).hasError).toBe(true)
  })

  it.each(['branch_end', 'region'])(
    'skips the warning glow for non-card type %s',
    (type) => {
      const { warningGlow } = callWrapped(type, {}, 'x', { hasError: true })
      expect(warningGlow).toBe(false)
    },
  )

  it('sets a descriptive displayName for devtools', () => {
    const Wrapped = withNodeBadges(FakeNode)
    expect(Wrapped.displayName).toBe('withNodeBadges(FakeNode)')
  })
})
