/**
 * The Connections page opens the connection a link names (#2338 build PR 11,
 * R8): a step's problem line links to /connections?connection=<id>, where the
 * connection is fixed, so the page opens on it rather than on the first one.
 * A name the list does not hold falls back to the first connection (the
 * reducer's keepChosen), so a stale link still lands on the page.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const params = { value: new URLSearchParams() }
vi.mock('next/navigation', () => ({ useSearchParams: () => params.value }))
vi.mock('@/components/NavLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
const seen: unknown[] = []
vi.mock('@/components/connections/ConnectionsScreen', () => ({
  ConnectionsScreen: (props: { initialChosen?: unknown }) => { seen.push(props.initialChosen); return null },
}))

describe('the Connections page', () => {
  it('opens the connection its address names', async () => {
    params.value = new URLSearchParams('connection=c-achieve')
    const { default: ConnectionsPage } = await import('../page')
    seen.length = 0
    render(<ConnectionsPage />)
    expect(seen.at(-1)).toEqual({ kind: 'connection', id: 'c-achieve' })
  })

  it('with no connection named, opens as it always has', async () => {
    params.value = new URLSearchParams('')
    const { default: ConnectionsPage } = await import('../page')
    seen.length = 0
    render(<ConnectionsPage />)
    expect(seen.at(-1)).toBeUndefined()
  })
})
