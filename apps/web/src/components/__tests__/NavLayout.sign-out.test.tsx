/**
 * Sign out asks the page's leave guard first (#2138, PM-5, L247): with a draft
 * on screen it opens the page's own dialog and signs nobody out until the
 * person says so; with nothing to lose it signs out at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ usePathname: () => '/partners', useRouter: () => ({ push }) }))
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }))
vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))
const signOut = vi.fn().mockResolvedValue({})
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut } }) }))

import NavLayout from '../NavLayout'
import { useLeaveGuard, type LeaveRequest } from '@/lib/leave-guard'

function Page({ blocking, onAsk }: { blocking: boolean; onAsk: (r: LeaveRequest) => void }) {
  useLeaveGuard({ blocking, onAsk })
  return <p>page</p>
}

beforeEach(() => vi.clearAllMocks())

describe('sign out (#2138)', () => {
  it('with a draft on screen, asks the page and signs out only once the person proceeds', async () => {
    const onAsk = vi.fn()
    render(<NavLayout><Page blocking onAsk={onAsk} /></NavLayout>)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onAsk).toHaveBeenCalledTimes(1)
    const request = onAsk.mock.calls[0][0] as LeaveRequest
    expect(request.destination).toEqual({ kind: 'sign-out' })
    expect(signOut).not.toHaveBeenCalled()
    request.proceed()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('with nothing to lose, signs out at once', async () => {
    const onAsk = vi.fn()
    render(<NavLayout><Page blocking={false} onAsk={onAsk} /></NavLayout>)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'))
    expect(onAsk).not.toHaveBeenCalled()
  })
})
