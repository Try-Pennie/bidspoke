/**
 * A click buyer's clicks against its cap (#1543), drawn as the settled design
 * draws it since #2324 (PM-21): a bar beside the Clicks per day box and "11 of
 * 50 clicks today". The day counted is the Pacific day, so a page left open
 * past the reset names the day it read rather than calling it today. The old
 * date stamp ("on 2026-10-15") and the green "Room under the cap." are gone;
 * only a reached cap says so. An unreadable counter is its own state with no
 * number (L633).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClickUsagePanel, type ClickUsage } from '../ClickUsagePanel'

// 2026-10-15 at 2:00 PM Pacific.
const NOW = Date.parse('2026-10-15T21:00:00.000Z')
const usage = (count: number, date = '2026-10-15'): ClickUsage => ({ sold_on: 'click', count, date, day_zone: 'America/Los_Angeles' })

describe('ClickUsagePanel', () => {
  it('shows the clicks today against the cap as a bar and a sentence', () => {
    render(<ClickUsagePanel usage={usage(11)} error={null} cap={50} otherSellers={[]} partnerName="Liberty1" nowMs={NOW} />)
    expect(screen.getByText('11 of 50 clicks today')).toBeInTheDocument()
    const bar = screen.getByRole('meter', { name: 'Clicks today' })
    expect(bar).toHaveAttribute('aria-valuenow', '11')
    expect(bar).toHaveAttribute('aria-valuemax', '50')
    expect(screen.queryByText(/room under/i)).toBeNull()
    expect(screen.queryByText(/2026-10-15/)).toBeNull()
  })

  it('names the day it counted when that is no longer today in Pacific', () => {
    render(<ClickUsagePanel usage={usage(11, '2026-10-14')} error={null} cap={50} otherSellers={[]} partnerName="Liberty1" nowMs={NOW} />)
    expect(screen.getByText('11 of 50 clicks on Oct 14')).toBeInTheDocument()
  })

  it('says when the cap is reached', () => {
    render(<ClickUsagePanel usage={usage(50)} error={null} cap={50} otherSellers={[]} partnerName="Liberty1" nowMs={NOW} />)
    expect(screen.getByText('50 of 50 clicks today')).toBeInTheDocument()
    expect(screen.getByText('The cap is reached.')).toBeInTheDocument()
  })

  it('with no cap shows the count alone, with no bar', () => {
    render(<ClickUsagePanel usage={usage(11)} error={null} cap={null} otherSellers={[]} partnerName="Liberty1" nowMs={NOW} />)
    expect(screen.getByText('11 clicks today')).toBeInTheDocument()
    expect(screen.queryByRole('meter')).toBeNull()
  })

  it('an unreadable counter says why and shows no number', () => {
    render(<ClickUsagePanel usage={null} error="The click counter did not answer." cap={50} otherSellers={[]} partnerName="Liberty1" nowMs={NOW} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The click counter did not answer.')
    expect(screen.queryByText(/clicks today/)).toBeNull()
  })

  it('names the workflows selling to the buyer outside its clicks', () => {
    render(<ClickUsagePanel usage={usage(11)} error={null} cap={50} otherSellers={[{ id: 'w', name: 'Main Flow' }]} partnerName="Liberty1" nowMs={NOW} />)
    expect(screen.getByText('Main Flow also sells to Liberty1. Those sales are not clicks and are not counted here.')).toBeInTheDocument()
  })
})
