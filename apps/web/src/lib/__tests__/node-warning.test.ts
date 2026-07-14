import { describe, it, expect } from 'vitest'
import type { Node } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import type { ValidationError } from '../workflow-validation'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NODE_WARNING_CLASS,
  NODE_WARNING_COLOR,
  NODE_WARNING_RING,
  applyValidationToNodes,
  nodeWarningVariant,
  validationSignature,
} from '../node-warning'

describe('nodeWarningVariant', () => {
  it('returns null for a healthy node', () => {
    expect(nodeWarningVariant(false, false)).toBeNull()
    expect(nodeWarningVariant(undefined, false)).toBeNull()
  })

  it('returns unconfigured when the node is missing required config', () => {
    expect(nodeWarningVariant(true, false)).toBe('unconfigured')
  })

  it('returns timeout when only the timeout is below the suggested value', () => {
    expect(nodeWarningVariant(false, true)).toBe('timeout')
  })

  it('prefers unconfigured when both apply: it is the condition that blocks saving', () => {
    expect(nodeWarningVariant(true, true)).toBe('unconfigured')
  })
})

describe('NODE_WARNING_CLASS', () => {
  it('gives the two conditions visually distinct glows', () => {
    expect(NODE_WARNING_CLASS.unconfigured).not.toBe(NODE_WARNING_CLASS.timeout)
  })
})

function makeNode(id: string, data: Partial<CanvasNodeData> = {}): Node {
  return {
    id,
    type: 'code',
    position: { x: 0, y: 0 },
    data: { namespace: id, config: {}, variables: {}, ...data } as unknown as Node['data'],
  }
}

function makeError(nodeId: string, message: string): ValidationError {
  return { nodeId, namespace: nodeId, message }
}

describe('applyValidationToNodes', () => {
  it('injects hasError and the human-readable reason onto a flagged node', () => {
    const nodes = [makeNode('a')]
    const flagged = new Map([['a', makeError('a', 'No script written')]])
    const out = applyValidationToNodes(nodes, flagged)
    const data = out[0].data as unknown as CanvasNodeData
    expect(data.hasError).toBe(true)
    expect(data.errorMessage).toBe('No script written')
  })

  it('clears both fields when a node stops being flagged', () => {
    const nodes = [makeNode('a', { hasError: true, errorMessage: 'No script written' })]
    const out = applyValidationToNodes(nodes, new Map())
    const data = out[0].data as unknown as CanvasNodeData
    expect(data.hasError).toBe(false)
    expect(data.errorMessage).toBeUndefined()
  })

  it('returns the same node objects when nothing changed, so React Flow skips the re-render', () => {
    const nodes = [makeNode('a', { hasError: true, errorMessage: 'No script written' })]
    const flagged = new Map([['a', makeError('a', 'No script written')]])
    const out = applyValidationToNodes(nodes, flagged)
    expect(out[0]).toBe(nodes[0])
  })

  it('updates a node whose reason changed even though it stayed flagged', () => {
    const nodes = [makeNode('a', { hasError: true, errorMessage: 'No branches defined' })]
    const flagged = new Map([['a', makeError('a', 'A branch arm has no conditions set')]])
    const out = applyValidationToNodes(nodes, flagged)
    expect((out[0].data as unknown as CanvasNodeData).errorMessage).toBe('A branch arm has no conditions set')
  })
})

describe('validationSignature', () => {
  it('changes when a node is flagged or cleared', () => {
    const before = validationSignature(new Map())
    const after = validationSignature(new Map([['a', makeError('a', 'No script written')]]))
    expect(before).not.toBe(after)
  })

  it('changes when the reason changes but the flagged set does not', () => {
    const before = validationSignature(new Map([['a', makeError('a', 'No branches defined')]]))
    const after = validationSignature(new Map([['a', makeError('a', 'A branch arm has no conditions set')]]))
    expect(before).not.toBe(after)
  })

  it('is stable for the same errors regardless of map insertion order', () => {
    const a = validationSignature(
      new Map([
        ['a', makeError('a', 'No script written')],
        ['b', makeError('b', 'No URL configured')],
      ]),
    )
    const b = validationSignature(
      new Map([
        ['b', makeError('b', 'No URL configured')],
        ['a', makeError('a', 'No script written')],
      ]),
    )
    expect(a).toBe(b)
  })
})

describe('NODE_WARNING_COLOR', () => {
  // CSS can't import TS, so the minimap's hexes and the glow's box-shadow colors
  // are two independent copies of the same two colors. That's the one seam where
  // the surfaces #563/#656 unified can still silently drift apart, so pin them.
  const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8')

  /**
   * Every CSS rule that paints the glow class. Matches the class EXACTLY:
   * `\.node-warning\b` would also match `.node-warning-timeout` (the `\b` sits
   * happily between the "g" and the "-"), which would let the amber variant pass
   * by reading the violet variant's rules.
   */
  function glowRules(className: string): string {
    const selector = new RegExp(`\\.${className}(?![\\w-])[^{]*\\{[\\s\\S]*?\\n\\}`, 'g')
    const blocks = [...css.matchAll(selector)].map((b) => b[0])
    expect(
      blocks.length,
      `no rule for .${className} in globals.css — was the glow class renamed or deleted?`,
    ).toBeGreaterThan(0)
    return blocks.join('\n')
  }

  /**
   * The animation the class runs. Kept separate from the class rules on purpose:
   * an earlier version of this guard OR'd the two together, so renaming the class
   * still passed by matching the (untouched) keyframes — a guard that could not
   * fail. Both must be found independently.
   */
  function glowKeyframes(className: string): string {
    const rules = glowRules(className)
    const name = rules.match(/animation:\s*([\w-]+)/)?.[1]
    expect(name, `.${className} runs no animation — the pulsing glow is gone`).toBeDefined()
    const block = css.match(new RegExp(`@keyframes ${name}\\b[^{]*\\{[\\s\\S]*?\\n\\}`))
    expect(block, `.${className} animates "${name}" but no such @keyframes exists`).not.toBeNull()
    return block![0]
  }

  it.each(['unconfigured', 'timeout'] as const)('uses the same hex as the %s glow in globals.css', (variant) => {
    const hex = NODE_WARNING_COLOR[variant].toLowerCase()
    const className = NODE_WARNING_CLASS[variant]
    const css2 = (glowRules(className) + glowKeyframes(className)).toLowerCase()
    expect(
      css2.includes(hex),
      `${variant}: the minimap paints ${hex} but the .${className} glow never mentions it`,
    ).toBe(true)
  })

  it('rings each variant in a color distinct from its fill, or the ring is invisible', () => {
    expect(NODE_WARNING_RING.unconfigured).not.toBe(NODE_WARNING_COLOR.unconfigured)
    expect(NODE_WARNING_RING.timeout).not.toBe(NODE_WARNING_COLOR.timeout)
  })

  it('gives the two conditions distinct minimap fills, the whole point of #656', () => {
    expect(NODE_WARNING_COLOR.unconfigured).not.toBe(NODE_WARNING_COLOR.timeout)
  })
})
