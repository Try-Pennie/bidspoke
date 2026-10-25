/**
 * The development preview's data for the App Action card (#2339): the settled
 * design's own fixture (docs/design/app-action-node-card.fixture.json) as the
 * step its captured canvas shows, Google Drive's List files in place of the
 * Salesforce step of the Connection field preview's workflow (Achieve report
 * import), which the design's chrome was captured from. No network. Not served
 * in a production build.
 */
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import type { Workflow } from '@/types/workflow'
import fixture from '../../../../../../docs/design/app-action-node-card.fixture.json'
import sendFixture from '../../../../../../docs/design/app-action-test-send.fixture.json'
import formFixture from '../../../../../../docs/design/app-action-step-form.fixture.json'
import { PREVIEW_WORKFLOW as CONNECTION_FIELD_WORKFLOW } from '../connection-field/connection-field-preview-source'

/** The settled frames (docs/design/app-action-node-card/settled.json): the design score's built side. */
export const SETTLED_FRAMES = ['app-action-card'] as const
/**
 * The tick box before a test that sends for real (#2339,
 * docs/design/app-action-test-send/settled.json): the step opened, Test this
 * node expanded, the box unticked and then ticked.
 */
export const TEST_SEND_FRAMES = ['send-unticked', 'send-ticked'] as const
/**
 * The step's settings form (#2338, docs/design/app-action-step-form/settled.json):
 * a finished step, an unfinished one with no connection and To empty, and the
 * data picker open on To.
 */
export const FORM_FRAMES = ['form-finished', 'form-unfinished', 'form-picker'] as const
export type PreviewFrame = (typeof SETTLED_FRAMES)[number] | (typeof TEST_SEND_FRAMES)[number] | (typeof FORM_FRAMES)[number]

const FRAMES: readonly string[] = [...SETTLED_FRAMES, ...TEST_SEND_FRAMES, ...FORM_FRAMES]

export const isFormFrame = (frame: PreviewFrame): boolean => (FORM_FRAMES as readonly string[]).includes(frame)

export function previewFrameOf(frame: string | undefined): PreviewFrame {
  return (FRAMES.includes(frame ?? '') ? frame : SETTLED_FRAMES[0]) as PreviewFrame
}

export const isTestSendFrame = (frame: PreviewFrame): boolean => (TEST_SEND_FRAMES as readonly string[]).includes(frame)

/** The step's settings: the catalogue action the fixture names, on a made up connection id. */
export const PREVIEW_STEP_CONFIG: Record<string, unknown> = {
  service: 'google',
  action: 'google.drive-list-files',
  actionVersion: 1,
  connection: '00000000-0000-4000-8000-000000002339',
  args: {},
}

export const PREVIEW_WORKFLOW: Workflow = {
  ...CONNECTION_FIELD_WORKFLOW,
  id: '00000000-0000-4000-8000-000000002339',
  definition: {
    ...CONNECTION_FIELD_WORKFLOW.definition,
    nodes: CONNECTION_FIELD_WORKFLOW.definition.nodes.map((n) =>
      n.id === 'n1' ? { ...n, type: 'app_action' as const, namespace: fixture.namespace, label: fixture.label, config: PREVIEW_STEP_CONFIG } : n,
    ),
  },
}

/** The send frames' connection: the fixture's, on a made up id. */
export const SEND_CONNECTION_ID = '00000000-0000-4000-8000-0000000023c1'

/** The send frames' step: Gmail's Send an email on the fixture's connection. */
export const SEND_STEP_CONFIG: Record<string, unknown> = {
  service: 'google',
  action: 'google.gmail-send-email',
  actionVersion: 1,
  connection: SEND_CONNECTION_ID,
  args: {},
}

export const SEND_WORKFLOW: Workflow = {
  ...PREVIEW_WORKFLOW,
  definition: {
    ...PREVIEW_WORKFLOW.definition,
    nodes: PREVIEW_WORKFLOW.definition.nodes.map((n) =>
      n.id === 'n1' ? { ...n, namespace: sendFixture.namespace, label: sendFixture.label, config: SEND_STEP_CONFIG } : n,
    ),
  },
}

const SEND_CONNECTION: ConnectionListRow = {
  id: SEND_CONNECTION_ID,
  name: sendFixture.connection,
  service: 'google',
  service_name: 'Google',
  alert_login: false,
  acts_as: null,
  person_bound: false,
  owner: null,
  target: null,
  status: 'ok',
  status_word: 'Working',
  health: null,
  used_by: 1,
  workflows: [],
  created_at: '2026-10-01T16:00:00Z',
  updated_at: '2026-10-01T16:00:00Z',
}

/** What GET /api/connections answers in the send frames: the fixture's connection alone. */
export const SEND_CONNECTIONS: ConnectionList = {
  connections: [SEND_CONNECTION],
  statuses: { as_of: '2026-10-23T16:00:00Z', stale: false, unavailable: null },
}

/** The form frames' connection: the fixture's mailbox, acting as its address. */
export const FORM_CONNECTIONS: ConnectionList = {
  connections: [{ ...SEND_CONNECTION, name: formFixture.connection, acts_as: formFixture.actsAs }],
  statuses: SEND_CONNECTIONS.statuses,
}

/** Each form frame's step: Gmail's Send an email, finished, or with no connection and To empty. */
export function formStepConfig(frame: PreviewFrame): Record<string, unknown> {
  const unfinished = frame === 'form-unfinished'
  const args = frame === 'form-finished' ? formFixture.finished : formFixture.unfinished
  return {
    service: 'google',
    action: 'google.gmail-send-email',
    actionVersion: 1,
    ...(unfinished ? {} : { connection: SEND_CONNECTION_ID }),
    args,
  }
}

/** The form frames' workflow: the send step, with the trigger's test payload the picker reads. */
export function formWorkflow(frame: PreviewFrame): Workflow {
  return {
    ...PREVIEW_WORKFLOW,
    definition: {
      ...PREVIEW_WORKFLOW.definition,
      nodes: PREVIEW_WORKFLOW.definition.nodes.map((n) =>
        n.id === 'n1' ? { ...n, namespace: formFixture.namespace, label: formFixture.label, config: formStepConfig(frame) } : n,
      ),
    },
    test_payloads: [{ name: 'Lead', payload: formFixture.triggerPayload }],
  } as Workflow
}
