/**
 * Issue #728. A failed allowlist READ used to be indistinguishable from a
 * genuine denial: both landed here, both told the person their account lacks
 * permission, and both signed them out. Telling a legitimate employee they were
 * denied, when what actually happened is that a database read failed, is a
 * message claiming more than its check measured, and signing them out adds a
 * login to a recovery that only needed a retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import AccessDeniedPage from '../page'

const signOut = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut } }) }))

let params = new URLSearchParams()
vi.mock('next/navigation', () => ({ useSearchParams: () => params }))

describe('access-denied: a genuine refusal', () => {
  beforeEach(() => {
    signOut.mockClear()
    params = new URLSearchParams()
  })

  it('says the account lacks permission', () => {
    render(<AccessDeniedPage />)
    expect(screen.getByRole('heading', { name: /access denied/i })).toBeInTheDocument()
    expect(screen.getByText(/doesn't have permission/i)).toBeInTheDocument()
  })

  it('signs the session out so a protected route cannot loop back here', async () => {
    render(<AccessDeniedPage />)
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('link', { name: /back to sign in/i })).toBeInTheDocument()
  })
})

describe('access-denied: the gate could not read the allowlist', () => {
  beforeEach(() => {
    signOut.mockClear()
    params = new URLSearchParams('reason=gate_unavailable')
  })

  it('does not claim the account lacks permission', () => {
    render(<AccessDeniedPage />)
    expect(screen.queryByText(/doesn't have permission/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^access denied$/i })).not.toBeInTheDocument()
  })

  it('says the check itself failed, and that they are still signed in', () => {
    render(<AccessDeniedPage />)
    expect(screen.getByRole('heading', { name: /can't check your access/i })).toBeInTheDocument()
    expect(screen.getByText(/still signed in/i)).toBeInTheDocument()
  })

  it('does NOT sign a legitimate employee out over a failed read', async () => {
    render(<AccessDeniedPage />)
    // Give the effect a chance to run before asserting it did nothing.
    await waitFor(() => expect(screen.getByRole('link', { name: /try again/i })).toBeInTheDocument())
    expect(signOut).not.toHaveBeenCalled()
  })

  it('offers a retry that goes back into the app, not to a fresh login', async () => {
    render(<AccessDeniedPage />)
    const retry = await screen.findByRole('link', { name: /try again/i })
    expect(retry).toHaveAttribute('href', '/workflows')
    expect(screen.queryByRole('link', { name: /back to sign in/i })).not.toBeInTheDocument()
  })
})
