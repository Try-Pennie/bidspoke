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
