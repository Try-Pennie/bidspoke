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
    const badge = screen.getByText('Inactive', { exact: false }).closest('span[title]')!
    expect(badge.getAttribute('title')).toBe('Takes no traffic until it is enabled from the Workflows list')
  })

  // gray-500 on gray-100 is 4.39:1, under the 4.5:1 small text needs (L149);
  // gray-700 on gray-100 is 9.37:1.
  it('draws Inactive in a colour that clears text contrast on its background', () => {
    render(<WorkflowActiveBadge isActive={false} />)
    const badge = screen.getByText('Inactive', { exact: false }).closest('span[class]')!
    expect(badge.className).toContain('bg-gray-100')
    expect(badge.className).toContain('text-gray-700')
    expect(badge.className).not.toContain('text-gray-500')
  })

  // A title is a mouse only tooltip; the explanation must reach a screen reader too (L20).
  it('gives screen readers the explanation, not only a hover tooltip', () => {
    render(<WorkflowActiveBadge isActive={false} />)
    expect(screen.getByText(/takes no traffic until it is enabled from the Workflows list/i, { selector: '.sr-only' })).toBeTruthy()
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
