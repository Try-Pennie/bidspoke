/**
 * The sell-off offer as shown (#2142): the details are HTML a person typed, so
 * the preview builds only an allowlist of elements as React nodes and never
 * hands the text to the browser as markup.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OfferPreview } from '../OfferPreview'

// Sofi's details as stored in production (partners.json fixture), the closing quote included.
const SOFI = '<p>Access up to $100,000 with rates tailored to your income</p><ul><li>Terms and rates based on your income</li><li>Approval in minutes, not weeks</li></ul>"'

describe('OfferPreview', () => {
  it('shows the title, the paragraph and each bullet as the offer shows them', () => {
    render(<OfferPreview title="Denied a personal loan?" details={SOFI} />)
    expect(screen.getByText('Denied a personal loan?')).toBeVisible()
    expect(screen.getByText('Access up to $100,000 with rates tailored to your income').tagName).toBe('P')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Terms and rates based on your income', 'Approval in minutes, not weeks'])
  })

  it('never runs what it is given: a script, a handler or a javascript link is text or nothing', () => {
    const { container } = render(<OfferPreview title="t" details={'<p onclick="alert(1)">Hi</p><script>alert(2)</script><img src=x onerror="alert(3)"><a href="javascript:alert(4)">go</a><a href="https://sofi.com">site</a>'} />)
    expect(container.querySelector('script, img, [onclick], [onerror]')).toBeNull()
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(screen.getByText('go').tagName).toBe('SPAN')
    expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute('href', 'https://sofi.com')
  })

  it('plain text is shown as it is', () => {
    render(<OfferPreview title="t" details="Rates from 8%." />)
    expect(screen.getByText('Rates from 8%.')).toBeVisible()
  })

  it('says when there is nothing to show yet', () => {
    render(<OfferPreview title="" details="" />)
    expect(screen.getByText('Nothing to show until a title or details are filled in.')).toBeVisible()
  })
})
