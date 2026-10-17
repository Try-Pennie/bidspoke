/**
 * The shared section row every partners page tab is built from (#2317, PM-17):
 * the section's name in a column on the left, its settings beside it starting
 * on the name's line.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PartnerSection, PartnerSubsection } from '../PartnerSection'

describe('PartnerSection', () => {
  it('is a region named by its heading, with the settings beside the name', () => {
    render(<PartnerSection title="Circuit breaker"><p>Pause after five errors.</p></PartnerSection>)
    const region = screen.getByRole('region', { name: 'Circuit breaker' })
    const heading = screen.getByRole('heading', { level: 3, name: 'Circuit breaker' })
    expect(region).toContainElement(heading)
    expect(region).toHaveClass('partner-section')
    const body = region.querySelector('.partner-section-body')
    expect(body).not.toBeNull()
    expect(body).toHaveTextContent('Pause after five errors.')
    expect(body).not.toContainElement(heading)
  })

  it('gives two sections with the same name distinct headings to be named by', () => {
    render(<><PartnerSection title="Hours"><p>a</p></PartnerSection><PartnerSection title="Hours"><p>b</p></PartnerSection></>)
    const [a, b] = screen.getAllByRole('region', { name: 'Hours' })
    expect(a.getAttribute('aria-labelledby')).not.toEqual(b.getAttribute('aria-labelledby'))
  })
})

describe('PartnerSubsection', () => {
  it('names a part inside a section with a heading one level below the section', () => {
    render(<PartnerSection title="Bid resolution"><PartnerSubsection title="Matrix"><p>rows</p></PartnerSubsection></PartnerSection>)
    expect(screen.getByRole('heading', { level: 4, name: 'Matrix' })).toBeInTheDocument()
  })
})

describe('PartnerSection region={false}', () => {
  it('is a plain section, not a named region, still headed by its name', () => {
    render(<PartnerSection title="Click URL" region={false}><input aria-label="Click URL" /></PartnerSection>)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'Click URL' })).toBeInTheDocument()
  })
})
