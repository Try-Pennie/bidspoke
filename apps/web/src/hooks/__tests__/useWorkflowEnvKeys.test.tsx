/**
 * Issue #1774: the canvas offers `env.KEY` references a workflow's runs can
 * actually read, so another workflow's own keys are never suggested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/api', () => ({ api: { env: { list: vi.fn() } } }))

import { api } from '@/lib/api'
import { useWorkflowEnvKeys } from '../useWorkflowEnvKeys'

beforeEach(() => vi.clearAllMocks())

describe('useWorkflowEnvKeys (#1774)', () => {
  it("returns the company keys and the open workflow's own, not another workflow's", async () => {
    vi.mocked(api.env.list).mockResolvedValue([
      { id: '1', key: 'API_URL', value: 'x', is_secret: false, scope: 'global', workflow_id: null, updated_at: '' },
      { id: '2', key: 'CHANNEL', value: 'y', is_secret: false, scope: 'workflow', workflow_id: 'wf-main', updated_at: '' },
      { id: '3', key: 'ACHIEVE_ONLY', value: 'z', is_secret: false, scope: 'workflow', workflow_id: 'wf-achieve', updated_at: '' },
    ])

    const { result } = renderHook(() => useWorkflowEnvKeys('wf-main'))

    await waitFor(() => expect(result.current).toEqual(['API_URL', 'CHANNEL']))
  })

  // The canvas has no render harness, so its wiring is read from the source: it
  // takes its suggestions from this hook for its own workflow, and never lists
  // the organization's keys itself, which is how other workflows' keys got in.
  // Comments are dropped first, so a note that names the hook cannot stand in for
  // the call, and the hook's result must be what the suggestions are spread from.
  // Loose on purpose past that: formatting and other uses of the list stay free.
  it("is where the canvas takes its env suggestions, for the open workflow's id", () => {
    const raw = readFileSync(join(__dirname, '..', '..', 'components', 'canvas', 'WorkflowCanvas.tsx'), 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

    expect(code).toMatch(/const envKeys = useWorkflowEnvKeys\(workflow\.id\)/)
    expect(code).toMatch(/\.\.\.envKeys\.map\(/)
    expect(code).not.toContain('api.env.list(')
  })

  it('offers no keys while the list cannot be read, and the canvas carries on', async () => {
    vi.mocked(api.env.list).mockRejectedValue(new Error('503'))

    const { result } = renderHook(() => useWorkflowEnvKeys('wf-main'))

    await waitFor(() => expect(api.env.list).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual([])
  })
})
