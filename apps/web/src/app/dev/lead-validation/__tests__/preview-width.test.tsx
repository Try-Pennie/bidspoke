import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/dynamic', () => ({ default: () => function MockMonaco() { return null } }))
vi.mock('@/lib/api', () => ({ api: {} }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('checks=1'), notFound: vi.fn() }))

// The table's value is swapped for one no copy of the number could match, so the
// test fails if the preview carries its own width instead of the canvas's.
vi.mock('@/lib/panel-widths', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/panel-widths')>()
  return { ...real, PANEL_WIDTH_DEFAULTS: { ...real.PANEL_WIDTH_DEFAULTS, checks: 503 } }
})

// #2595: the preview the settled checks are run against must open the panel at
// the width the canvas opens a lead validation step at, from the one table.
describe('the lead validation preview width', () => {
  it('opens the panel at the canvas opening width for a lead validation step', async () => {
    const { LeadValidationPreview } = await import('../LeadValidationPreview')
    render(<LeadValidationPreview />)
    const width = Number(screen.getByRole('separator', { name: 'Resize panel' }).getAttribute('aria-valuenow'))
    expect(width).toBe(503)
  })
})
