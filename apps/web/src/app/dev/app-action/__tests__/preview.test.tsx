/**
 * The development preview of the App Action card (#2339): the settled design's
 * frames, drawn on the real canvas from the design's own fixture, so the design
 * score's built side and the settled design draw the same data. The page answers
 * 404 in a production build.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { nodeTypes } from '@/components/canvas/nodes/registry'
import { appActionDisplay } from '@/lib/app-action-display'
import fixture from '../../../../../../../docs/design/app-action-node-card.fixture.json'
import { PREVIEW_STEP_CONFIG, PREVIEW_WORKFLOW, SEND_CONNECTIONS, SEND_STEP_CONFIG, SEND_WORKFLOW, SETTLED_FRAMES, TEST_SEND_FRAMES, previewFrameOf } from '../app-action-preview-source'
import sendFixture from '../../../../../../../docs/design/app-action-test-send.fixture.json'
import formFixture from '../../../../../../../docs/design/app-action-step-form.fixture.json'
import { FORM_CONNECTIONS, FORM_FRAMES, formStepConfig, formWorkflow } from '../app-action-preview-source'
import { appActionSchema } from '@/lib/app-action-display'
import { sampleLabel, sampleRows } from '@bidspoke/references'
import { appActionRealSend } from '@/lib/app-action-display'

const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', () => ({ notFound: () => notFound() }))

afterEach(() => { vi.unstubAllEnvs() })

describe('the App Action card preview', () => {
  it('lists the settled frames exactly as the settled design does', () => {
    const spec = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../../docs/design/app-action-node-card/settled.json'), 'utf8')) as { frames: { id: string }[] }
    expect([...SETTLED_FRAMES]).toEqual(spec.frames.map((f) => f.id))
  })

  it("the step's catalogue action reads as the fixture's service and action, so the card draws the design's words", () => {
    expect(appActionDisplay(PREVIEW_STEP_CONFIG)).toMatchObject({ service: fixture.service, action: fixture.action, mark: 'google-drive' })
    const step = PREVIEW_WORKFLOW.definition.nodes.find((n) => n.type === 'app_action')
    expect(step).toMatchObject({ label: fixture.label, namespace: fixture.namespace, config: PREVIEW_STEP_CONFIG })
  })

  it('draws the card with the service, the action chip, the step name and its step id', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodeTypes={nodeTypes} nodes={[{ id: 'n1', type: 'app_action', position: { x: 0, y: 0 }, data: { namespace: fixture.namespace, label: fixture.label, config: PREVIEW_STEP_CONFIG, isReachable: true, variables: {} } }]} edges={[]} />
        </div>
      </ReactFlowProvider>,
    )
    for (const text of [fixture.service, fixture.action, fixture.label, fixture.namespace]) expect(screen.getByText(text)).toBeTruthy()
  })

  it('lists the send frames exactly as the tick box\'s settled design does (#2339)', () => {
    const spec = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../../docs/design/app-action-test-send/settled.json'), 'utf8')) as { frames: { id: string }[] }
    expect([...TEST_SEND_FRAMES]).toEqual(spec.frames.map((f) => f.id))
    for (const frame of TEST_SEND_FRAMES) expect(previewFrameOf(frame)).toBe(frame)
  })

  it('the send frames\' step and connection read as the fixture\'s, so the tick box says the design\'s words', () => {
    expect(appActionDisplay(SEND_STEP_CONFIG)).toMatchObject({ service: sendFixture.service, action: sendFixture.action })
    const step = SEND_WORKFLOW.definition.nodes.find((n) => n.type === 'app_action')
    expect(step).toMatchObject({ label: sendFixture.label, namespace: sendFixture.namespace, config: SEND_STEP_CONFIG })
    const name = SEND_CONNECTIONS.connections.find((c) => c.id === SEND_STEP_CONFIG.connection)?.name ?? null
    expect(appActionRealSend(SEND_STEP_CONFIG, name)).toBe(`Send for real. This ${sendFixture.realSend} from ${sendFixture.connection}. It cannot be taken back.`)
  })

  it('lists the form frames exactly as the settings form\'s settled design does (#2338)', () => {
    const spec = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../../docs/design/app-action-step-form/settled.json'), 'utf8')) as { frames: { id: string }[] }
    expect([...FORM_FRAMES]).toEqual(spec.frames.map((f) => f.id))
  })

  it('the form fixture\'s fields are the catalogue\'s, so the settled design draws what the form draws', () => {
    const schema = appActionSchema(formStepConfig('form-finished'))
    expect(schema?.arguments.map((a) => ({ key: a.key, label: sampleLabel(a.key), required: a.required, insert: a.allowsVariables, multiline: a.multiline === true || a.type === 'code' })))
      .toEqual(formFixture.fields)
    expect(appActionDisplay(formStepConfig('form-finished'))).toMatchObject({ service: formFixture.service, action: formFixture.action })
    expect(FORM_CONNECTIONS.connections[0]).toMatchObject({ name: formFixture.connection, acts_as: formFixture.actsAs })
    expect(sampleRows('trigger.payload', formFixture.triggerPayload).rows.map((r) => r.label)).toEqual(['Email', 'First name', 'Last name', 'Phone', 'Enrolled debt'])
  })

  it('the unfinished frame has no connection and no To, the finished one both', () => {
    expect(formStepConfig('form-unfinished')).not.toHaveProperty('connection')
    expect((formStepConfig('form-unfinished').args as Record<string, unknown>).to).toBeUndefined()
    expect(formStepConfig('form-finished')).toHaveProperty('connection')
    expect(formWorkflow('form-picker').test_payloads).toEqual([{ name: 'Lead', payload: formFixture.triggerPayload }])
  })

  it('answers 404 in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { default: Page } = await import('../page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
