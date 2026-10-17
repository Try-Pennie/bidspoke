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

  // #2327, PM-24: with nothing filled in, the card is still drawn (the design
  // always shows one), holding the boxes' own example in the hint grey, where
  // it used to be a sentence with no card.
  it('with nothing filled in, draws the card with the example in grey, never a sentence instead', () => {
    const { container } = render(<OfferPreview title="" details="" example={{ title: 'Get up to $50,000', details: 'Personal loans from $5,000.' }} />)
    const card = container.querySelector('[data-offer-preview]')!
    expect(card).not.toBeNull()
    expect(card).toHaveAttribute('data-example', 'true')
    expect(screen.getByText('Get up to $50,000')).toHaveClass('text-hint')
    expect(screen.getByText('Personal loans from $5,000.')).toHaveClass('text-hint')
    expect(screen.queryByText(/Nothing to show/)).toBeNull()
  })

  it('a filled in offer is drawn in the card as itself, not as the example', () => {
    const { container } = render(<OfferPreview title="Denied?" details="" example={{ title: 'Get up to $50,000', details: 'Personal loans from $5,000.' }} />)
    expect(container.querySelector('[data-offer-preview]')).toHaveAttribute('data-example', 'false')
    expect(screen.getByText('Denied?')).not.toHaveClass('text-hint')
    expect(screen.queryByText('Get up to $50,000')).toBeNull()
  })
})
