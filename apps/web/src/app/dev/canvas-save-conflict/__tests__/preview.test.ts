/**
 * The development preview of the canvas save conflict (#2599): every settled
 * frame reached by its id, each drawing the refusal from the settled design's
 * own fixture, so the design score's two sides draw the same data. The page
 * answers 404 in a production build.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../../../../docs/design/canvas-save-conflict.fixture.json'
import { askOf, previewFrameOf, SETTLED_FRAMES, staleOf } from '../canvas-save-conflict-preview-source'
import { loadTheirsDialog, saveOverDialog, staleWorkflowSentence } from '@/lib/workflow-save-conflict'
import { PREVIEW_WORKFLOW } from '../../connection-field/connection-field-preview-source'

const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', () => ({ notFound: () => notFound() }))

afterEach(() => { vi.unstubAllEnvs() })

describe('the canvas save conflict preview', () => {
  it('lists the settled frames exactly as the settled design does', () => {
    const spec = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../../docs/design/canvas-save-conflict/settled.json'), 'utf8')) as { frames: { id: string }[] }
    expect([...SETTLED_FRAMES]).toEqual(spec.frames.map((f) => f.id))
  })

  it("draws each frame's refusal from the fixture, in the fixture's own words", () => {
    for (const frame of SETTLED_FRAMES) {
      const stale = staleOf(frame)
      expect(stale.version).toBe(fixture.currentVersion)
      expect(stale.changedAt).toBe(fixture.changedAt)
      expect(staleWorkflowSentence(stale)).toContain(`at ${fixture.savedAt},`)
    }
    expect(staleOf('refused').changedByName).toBe(fixture.savedBy)
    expect(staleOf('refused-outside').changedByName).toBeNull()
    expect(saveOverDialog(staleOf('save-over')).description).toContain(fixture.savedAt)
    expect(loadTheirsDialog(staleOf('load-theirs')).title).toBe(`Load ${fixture.savedBy}'s version?`)
  })

  it('the canvas was loaded from a version older than the one the refusal names', () => {
    expect(PREVIEW_WORKFLOW.version).toBeLessThan(fixture.currentVersion)
    expect(PREVIEW_WORKFLOW.name).toBe(fixture.workflow)
  })

  it('opens the dialog a frame asks, and none on the others', () => {
    expect(askOf('save-over')).toBe('Save mine over theirs')
    expect(askOf('load-theirs')).toBe('Load their version')
    expect(askOf('refused')).toBeNull()
    expect(askOf('refused-outside')).toBeNull()
  })

  it('an unknown frame id opens the refused frame', () => {
    expect(previewFrameOf('nonsense')).toBe('refused')
    expect(previewFrameOf(undefined)).toBe('refused')
    expect(previewFrameOf('load-theirs')).toBe('load-theirs')
  })

  it('the page answers 404 in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { default: Page } = await import('../page')
    await expect(Page({ searchParams: Promise.resolve({ frame: 'refused' }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
