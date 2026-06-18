import { describe, it, expect } from 'vitest'
import { buildPreviewNodes, PREVIEW_TYPES, PREVIEW_STATES } from '../preview-nodes'

describe('buildPreviewNodes', () => {
  it('produces one node per (type, state) with unique ids', () => {
    const nodes = buildPreviewNodes()
    expect(nodes).toHaveLength(PREVIEW_TYPES.length * PREVIEW_STATES.length)
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
  })

  it('sets hasError only on the unconfigured state', () => {
    const nodes = buildPreviewNodes()
    for (const n of nodes) {
      const data = n.data as { hasError?: boolean }
      expect(!!data.hasError).toBe(n.id.endsWith('-unconfigured'))
    }
  })

  it('gives the timeout state a sub-floor timeout so the warning badge/glow fire', () => {
    const node = buildPreviewNodes().find((n) => n.id === 'code-timeout')!
    const config = (node.data as { config: { timeout_ms?: number } }).config
    expect(config.timeout_ms).toBe(10)
  })

  it('attaches an execution status only on the failed/completed states', () => {
    const nodes = buildPreviewNodes()
    const failed = nodes.find((n) => n.id === 'code-failed')!
    const dflt = nodes.find((n) => n.id === 'code-default')!
    expect((failed.data as { executionStep?: { status: string } }).executionStep?.status).toBe('failed')
    expect((dflt.data as { executionStep?: unknown }).executionStep).toBeUndefined()
  })
})
