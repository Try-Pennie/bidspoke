import { describe, expect, it } from 'vitest'
import { readWorkflow } from './_scan-utils'

/**
 * A pull request's CI and outage drill runs are cancelled when a newer commit
 * lands on the same pull request, and nothing else is.
 *
 * Measured 2026-10-22: with several sessions pushing and merge-when-ready
 * updating branches onto a moving main, 14 CI runs, 5 deploys and 5 outage
 * drills sat queued at once, and a merge helper ran out of its three hours with
 * all 9 checks of its head never started. Every update of a branch started a
 * full run while the superseded one still held or awaited runner slots, so the
 * queue grew with the work it was meant to clear (L301, L307).
 *
 * Cancelling is safe here only because both workflows WRITE nothing on a pull
 * request: they read the pull request's file list and upload reports (L671).
 * ci.yml also runs on every push to main, where its security steps read live
 * systems and a cancelled run would leave a commit unchecked, so a main push is
 * never cancelled: its group is its own commit and cancel-in-progress is false
 * for it. Each group is prefixed with the workflow's name, because concurrency
 * groups are shared across the whole repository and CI must never cancel the
 * outage drill of the same pull request, or the reverse.
 */
const CANCELLED_ON_PULL_REQUEST = ['.github/workflows/ci.yml', '.github/workflows/outage-drill.yml']

/** The top level `concurrency:` block of a workflow, as its two settings. */
function topLevelConcurrency(yaml: string): { group: string; cancel: string } | null {
  const lines = yaml.split('\n')
  const at = lines.findIndex((l) => /^concurrency:\s*$/.test(l))
  if (at < 0) return null
  const block: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line) && line.trim() !== '') break
    block.push(line)
  }
  const value = (key: string) => block.map((l) => l.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`))?.[1]).find(Boolean) ?? ''
  return { group: value('group'), cancel: value('cancel-in-progress') }
}

describe('superseded pull request runs are cancelled, main pushes never are', () => {
  for (const file of CANCELLED_ON_PULL_REQUEST) {
    describe(file, () => {
      const concurrency = topLevelConcurrency(readWorkflow(file))

      it('has a top level concurrency block', () => {
        expect(concurrency, `${file} has no top level concurrency: block`).not.toBeNull()
      })

      it('groups by workflow and pull request, falling back to the commit for a push', () => {
        expect(concurrency?.group).toBe('${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}')
      })

      it('cancels only on a pull request, so a run for a push to main always finishes', () => {
        expect(concurrency?.cancel).toBe("${{ github.event_name == 'pull_request' }}")
      })
    })
  }

  it('reads a block that would cancel a main push as wrong', () => {
    const bad = topLevelConcurrency('on:\n  push:\nconcurrency:\n  group: ci\n  cancel-in-progress: true\njobs:\n')
    expect(bad?.group).not.toBe('${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}')
    expect(bad?.cancel).not.toBe("${{ github.event_name == 'pull_request' }}")
  })
})
