import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import NavLayout from '../NavLayout'

// NavLayout pulls in next/navigation and the supabase client; stub both so the
// shell renders in jsdom. We only assert the a11y landmarks (#288).
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}))

describe('NavLayout skip-to-content (#288)', () => {
  it('renders a skip link that targets the main content', () => {
    render(<NavLayout><div>page</div></NavLayout>)
    const link = screen.getByRole('link', { name: 'Skip to main content' })
    expect(link).toHaveAttribute('href', '#main-content')
  })

  it('marks <main> as a focusable target with matching id', () => {
    render(<NavLayout><div>page</div></NavLayout>)
    const main = document.getElementById('main-content')
    expect(main?.tagName.toLowerCase()).toBe('main')
    expect(main).toHaveAttribute('tabindex', '-1')
  })
})
