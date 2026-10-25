/**
 * The App Action card draws its service's own mark (#2339, round 2 of
 * docs/design/app-action-node-card.html: "Service's own icon"), from the
 * catalogue's display data, at Google Drive's size and place; a service with no
 * mark draws the plain box.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { SERVICE_MARKS } from '@bidspoke/service-catalogue/schema'
import { nodeTypes } from '../registry'

function card(config: Record<string, unknown>) {
  const { container } = render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow nodeTypes={nodeTypes} nodes={[{ id: 'n1', type: 'app_action', position: { x: 0, y: 0 }, data: { namespace: 'step', label: 'Step', config, isReachable: true, variables: {} } }]} edges={[]} />
      </div>
    </ReactFlowProvider>,
  )
  return container
}

describe('the App Action card\'s mark', () => {
  it.each([
    ['google.drive', { service: 'google', action: 'google.drive-list-files', actionVersion: 1 }],
    ['google.gmail', { service: 'google', action: 'google.gmail-send-email', actionVersion: 1 }],
    ['google.sheets', { service: 'google', action: 'google.sheets-add-row', actionVersion: 1 }],
    ['google.calendar', { service: 'google', action: 'google.calendar-create-event', actionVersion: 1 }],
    ['snowflake', { service: 'snowflake', action: 'snowflake.execute-sql-query', actionVersion: 1 }],
    ['anthropic', { service: 'anthropic', action: 'anthropic.chat', actionVersion: 1 }],
    ['salesforce', { service: 'salesforce', action: 'salesforce.create-record', actionVersion: 1 }],
  ])('draws %s\'s own mark at Drive\'s size, in its colours', (key, config) => {
    const svg = card(config).querySelector(`svg[data-mark="${key}"]`)
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('class')).toBe('h-4 w-4 shrink-0')
    expect(svg?.getAttribute('viewBox')).toBe(SERVICE_MARKS[key].viewBox)
    expect([...(svg?.querySelectorAll('path') ?? [])].map((p) => p.getAttribute('fill'))).toEqual(SERVICE_MARKS[key].paths.map((p) => p.fill))
  })

  it('keeps Google Drive\'s mark exactly as the settled card draws it', () => {
    const fills = [...(card({ service: 'google', action: 'google.drive-list-files', actionVersion: 1 }).querySelectorAll('svg[data-mark] path'))].map((p) => p.getAttribute('fill'))
    expect(fills).toEqual(['#0066da', '#00ac47', '#ea4335', '#00832d', '#2684fc', '#ffba00'])
  })

  it('draws Salesforce\'s lettering with its own even odd rule, as its logo does', () => {
    const paths = [...(card({ service: 'salesforce', action: 'salesforce.create-record', actionVersion: 1 }).querySelectorAll('svg[data-mark] path'))]
    expect(paths.filter((p) => p.getAttribute('fill-rule') === 'evenodd')).toHaveLength(6)
  })

  it('draws the plain box for a service with no mark', () => {
    const c = card({ service: 'slack', action: 'slack.send-message', actionVersion: 1 })
    expect(c.querySelector('svg[data-mark]')).toBeNull()
    expect(c.querySelector('svg.lucide-box')).not.toBeNull()
  })
})
