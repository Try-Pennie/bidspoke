import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { leadValidationFixtureConfig, LEAD_VALIDATION_FIXTURE } from '@/lib/__tests__/_lead-validation-fixture'
import { PREVIEW_CONFIG, PREVIEW_NODE } from '../lead-validation-preview-source'

vi.mock('next/dynamic', () => ({ default: () => function MockMonaco() { return null } }))
vi.mock('@/lib/api', () => ({ api: {} }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('checks=1'), notFound: vi.fn() }))

// The preview the settled checks files are run against in a browser (#2590):
// it must draw the settled designs' own data, and the built panel and card.
describe('the lead validation preview', () => {
  it('draws exactly the settled fixture', () => {
    const { retries, ...config } = PREVIEW_CONFIG
    expect(retries).toBe(0)
    expect(config).toEqual(leadValidationFixtureConfig())
    expect(PREVIEW_NODE).toEqual({ title: LEAD_VALIDATION_FIXTURE.node.title, id: LEAD_VALIDATION_FIXTURE.node.id })
  })

  it('draws the real settings panel with as many checks as the address asks for', async () => {
    const { LeadValidationPreview } = await import('../LeadValidationPreview')
    render(<LeadValidationPreview />)
    expect(screen.getByText('Check 1 of 1')).toBeInTheDocument()
  })
})
