import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// NavLayout pulls in nav/auth chrome irrelevant to the toggle under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    integrations: {
      getSlack: vi.fn(),
      updateSlackSettings: vi.fn().mockResolvedValue({ ok: true }),
      searchSlackChannels: vi.fn().mockResolvedValue({ channels: [] }),
      resolveSlack: vi.fn(),
      saveSlack: vi.fn(),
    },
    servicePresets: { list: vi.fn().mockResolvedValue([]) },
  },
}))

import IntegrationsPage from '../page'
import { api } from '@/lib/api'

const connectedSlack = {
  connected: true,
  workspace_name: 'Pennie HQ',
  default_channel: '#alerts',
  volume_alerts_enabled: true,
  matrix_alerts_enabled: true,
  config_alerts_enabled: true,
  backup_alerts_enabled: true,
  matrix_alerts_channel: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.integrations.getSlack).mockResolvedValue(connectedSlack as never)
  vi.mocked(api.integrations.updateSlackSettings).mockResolvedValue({ ok: true } as never)
  vi.mocked(api.servicePresets.list).mockResolvedValue([] as never)
})

describe('Integrations page — backup failure alerts toggle (#223)', () => {
  it('renders the dedicated backup-failure toggle, on by default', async () => {
    render(<IntegrationsPage />)
    const toggle = await screen.findByRole('switch', { name: 'Backup failure alerts' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('persists the dedicated backup_alerts_enabled flag (not config_alerts) when toggled off', async () => {
    render(<IntegrationsPage />)
    const toggle = await screen.findByRole('switch', { name: 'Backup failure alerts' })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(api.integrations.updateSlackSettings).toHaveBeenCalledWith({ backup_alerts_enabled: false }),
    )
    // optimistic flip
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})

/**
 * Saving a token Slack rejects (#2331). The Worker refuses it with code
 * slack_token_invalid and the sentence Dan chose, which api.ts surfaces as the
 * thrown Error's message. The page must show that sentence as an error, keep
 * the form so the token can be fixed, and never read as connected or empty.
 */
describe('Integrations page: a token Slack rejects on save (#2331)', () => {
  const FAKE_TOKEN = 'xoxb-fake'

  async function saveRejectedWith(message: string) {
    vi.mocked(api.integrations.getSlack).mockResolvedValue({ connected: false } as never)
    vi.mocked(api.integrations.resolveSlack).mockResolvedValue({ workspace_name: 'Pennie HQ', channels: [{ id: 'C1', name: 'alerts' }] } as never)
    vi.mocked(api.integrations.saveSlack).mockRejectedValue(Object.assign(new Error(message), { status: 400 }))
    render(<IntegrationsPage />)
    const input = await screen.findByLabelText('Bot token')
    fireEvent.change(input, { target: { value: FAKE_TOKEN } })
    fireEvent.blur(input)
    await screen.findByText('Pennie HQ')
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }))
    await waitFor(() => expect(api.integrations.saveSlack).toHaveBeenCalled())
  }

  it.each([
    'Slack did not accept this token (token_revoked), so nothing was saved.',
    'Slack did not accept this token, so nothing was saved.',
  ])('shows "%s" as an error, keeping the form and claiming no connection', async (message) => {
    await saveRejectedWith(message)
    const shown = await screen.findByText(message)
    // The error banner, not a neutral note or an empty state.
    expect(shown.className).toMatch(/text-red-700/)
    expect(screen.queryByText('Slack connected successfully.')).toBeNull()
    expect(screen.queryByText('Connected')).toBeNull()
    // The form is still there with the token, so it can be corrected and saved again.
    expect(screen.getByLabelText('Bot token')).toHaveValue(FAKE_TOKEN)
    expect(screen.getByRole('button', { name: 'Connect Slack' })).toBeInTheDocument()
  })
})
