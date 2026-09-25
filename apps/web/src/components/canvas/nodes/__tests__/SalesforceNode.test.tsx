import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { SalesforceNode } from '../SalesforceNode'

// #1568: a query names its object inside its SOQL and has no `object` field, so
// the card read "Unconfigured" on every complete query node. "Unconfigured" is
// the canvas's word for a node that is not ready, so it must mean exactly that.
function renderCard(config: Record<string, unknown>) {
  const props = {
    id: 'n1',
    data: { namespace: 'find_lead', label: 'Find the lead', config, isReachable: true },
    selected: false,
  } as unknown as NodeProps
  return render(<ReactFlowProvider><SalesforceNode {...props} /></ReactFlowProvider>)
}

describe('SalesforceNode subtitle for a query (#1568)', () => {
  it('names the object the SOQL reads from', () => {
    renderCard({ operation: 'query', soql: "SELECT Id, Lead__c FROM Submission__c WHERE Id = '{{steps.x.output.id}}'" })
    expect(screen.getByText('Query Submission__c')).toBeInTheDocument()
    expect(screen.queryByText('Unconfigured')).toBeNull()
  })

  it('names the outer object, never one inside a parenthesised subquery', () => {
    renderCard({ operation: 'query', soql: 'SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Id IN (SELECT AccountId FROM Case)' })
    expect(screen.getByText('Query Account')).toBeInTheDocument()
  })

  it('reads Query when the whole SOQL is a template, so no object can be named', () => {
    renderCard({ operation: 'query', soql: '{{steps.resolve_input.output.prospect_soql}}' })
    expect(screen.getByText('Query')).toBeInTheDocument()
    expect(screen.queryByText('Unconfigured')).toBeNull()
  })

  it('reads Unconfigured only when there is no SOQL', () => {
    renderCard({ operation: 'query', soql: '   ' })
    expect(screen.getByText('Unconfigured')).toBeInTheDocument()
  })

  it('keeps the object subtitle for a write', () => {
    renderCard({ operation: 'update', object: 'Lead' })
    expect(screen.getByText('Update Lead')).toBeInTheDocument()
  })
})
