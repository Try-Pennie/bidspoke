/**
 * The development preview's data for the App Action card (#2339): the settled
 * design's own fixture (docs/design/app-action-node-card.fixture.json) as the
 * step its captured canvas shows, Google Drive's List files in place of the
 * Salesforce step of the Connection field preview's workflow (Achieve report
 * import), which the design's chrome was captured from. No network. Not served
 * in a production build.
 */
import type { Workflow } from '@/types/workflow'
import fixture from '../../../../../../docs/design/app-action-node-card.fixture.json'
import { PREVIEW_WORKFLOW as CONNECTION_FIELD_WORKFLOW } from '../connection-field/connection-field-preview-source'

/** The settled frames (docs/design/app-action-node-card/settled.json): the design score's built side. */
export const SETTLED_FRAMES = ['app-action-card'] as const
export type PreviewFrame = (typeof SETTLED_FRAMES)[number]

export function previewFrameOf(frame: string | undefined): PreviewFrame {
  return ((SETTLED_FRAMES as readonly string[]).includes(frame ?? '') ? frame : SETTLED_FRAMES[0]) as PreviewFrame
}

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
