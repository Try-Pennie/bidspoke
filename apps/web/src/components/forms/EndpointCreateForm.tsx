'use client'

import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'
import type { WorkflowSummary } from '@/types/workflow'
import EndpointForm from './EndpointForm'

/**
 * Create mode of the one endpoint form (#556). The fields, validation and layout
 * live in EndpointForm; this supplies what create does differently: blank seed
 * values, slug-to-source-name mirroring, the optional locked workflow, and the
 * create call.
 */
interface Props {
  /** Available workflows. Required unless lockWorkflow is true. */
  workflows?: WorkflowSummary[]
  /** Pre-selected workflow. Required if lockWorkflow is true. */
  workflowId?: string
  /** Display name shown when workflow is locked. */
  workflowName?: string
  /** When true, hides the workflow picker and uses workflowId. */
  lockWorkflow?: boolean
  /** Auto-focus the first input on mount. */
  autoFocus?: boolean
  onCreated: (endpoint: WebhookEndpoint) => void
  onCancel: () => void
}

export default function EndpointCreateForm({
  workflows = [],
  workflowId,
  workflowName,
  lockWorkflow = false,
  autoFocus = false,
  onCreated,
  onCancel,
}: Props) {
  return (
    <EndpointForm
      initial={{ subdomain: '', path: '', workflow_id: workflowId ?? '', source_name: '' }}
      workflows={workflows}
      lockWorkflow={lockWorkflow}
      workflowName={workflowName}
      autoFocus={autoFocus}
      mirrorSourceName
      submitLabel="Create endpoint"
      submittingLabel="Creating…"
      failureMessage="Failed to create endpoint"
      onSubmit={(values) => api.endpoints.create(values)}
      onSaved={onCreated}
      onCancel={onCancel}
    />
  )
}
