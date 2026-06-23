import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import NodePalette from '../NodePalette'

// #307: the outbound HTTP node is labeled 'HTTP Request' (not 'Webhook'), to
// avoid colliding with the inbound 'webhook' trigger that starts a workflow.
// The underlying node `type` stays `webhook`.
describe('NodePalette — outbound node label (#307)', () => {
  it('labels the outbound HTTP node "HTTP Request"', () => {
    render(<NodePalette onDragStart={vi.fn()} />)
    expect(screen.getByText('HTTP Request')).toBeInTheDocument()
  })

  it('does not label any palette node just "Webhook"', () => {
    render(<NodePalette onDragStart={vi.fn()} />)
    expect(screen.queryByText('Webhook')).not.toBeInTheDocument()
  })
})
