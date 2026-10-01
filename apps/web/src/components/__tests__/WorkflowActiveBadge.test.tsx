import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import WorkflowActiveBadge from '../WorkflowActiveBadge'

// New and duplicated workflows start inactive (#1706), and creating one lands the
// person on the canvas, which showed no state at all. One badge, shared by the
// list and the canvas header, says whether the workflow takes traffic.
describe('WorkflowActiveBadge', () => {
  it('says Inactive, and that it takes no traffic, when the workflow is off', () => {
    render(<WorkflowActiveBadge isActive={false} />)
    const badge = screen.getByText('Inactive')
    expect(badge.getAttribute('title')).toBe('Takes no traffic until it is enabled from the Workflows list')
  })

  it('says Active when the workflow is on', () => {
    render(<WorkflowActiveBadge isActive />)
    expect(screen.getByText('Active').getAttribute('title')).toBeNull()
  })

  // The list and the canvas both show the state through this one component, so
  // the two cannot drift into different words for it (L605, L613).
  it('is the only place either screen renders the Active or Inactive words', () => {
    const root = join(__dirname, '..', '..')
    for (const rel of ['app/(app)/workflows/page.tsx', 'components/canvas/WorkflowCanvas.tsx']) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, rel).toContain('<WorkflowActiveBadge')
      expect(src, rel).not.toMatch(/'Active' : 'Inactive'/)
    }
  })
})
