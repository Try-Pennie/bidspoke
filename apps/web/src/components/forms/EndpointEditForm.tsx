'use client'

import { api } from '@/lib/api'
import type { WebhookEndpoint } from '@/lib/api'
import type { WorkflowSummary } from '@/types/workflow'
import EndpointForm from './EndpointForm'

/**
 * Edit mode of the one endpoint form (#556). The fields, validation and layout
 * live in EndpointForm; this supplies what edit does differently: seeding from
 * the existing endpoint, and resolving the workflow name the PUT response does
 * not carry.
 */
interface Props {
  endpoint: WebhookEndpoint
  workflows: WorkflowSummary[]
  onSaved: (endpoint: WebhookEndpoint) => void
  onCancel: () => void
}

export default function EndpointEditForm({ endpoint, workflows, onSaved, onCancel }: Props) {
  return (
    <EndpointForm
      initial={{
        subdomain: endpoint.subdomain,
        // Stored '/' is the single-segment marker; show it as empty in the editor.
        path: endpoint.path === '/' ? '' : endpoint.path,
        workflow_id: endpoint.workflow_id,
        source_name: endpoint.source_name,
      }}
      workflows={workflows}
      submitLabel="Save changes"
      submittingLabel="Saving…"
      failureMessage="Failed to update endpoint"
      onSubmit={async (values) => {
        const updated = await api.endpoints.update(endpoint.id, values)
        // The PUT response doesn't include the joined workflow name; resolve it
        // from the loaded workflows so the list row stays accurate.
        const wf = workflows.find((w) => w.id === updated.workflow_id)
        return { ...updated, workflow_name: wf?.name ?? endpoint.workflow_name }
      }}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
}
