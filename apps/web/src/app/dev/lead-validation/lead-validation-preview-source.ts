/**
 * The data the lead validation preview draws (#2590): the settled designs' own
 * fixture (docs/design/lead-validation-node.fixture.json), RML GigFi's six real
 * checks and Lead Economy's phone check, as the node stores it. A test beside
 * this page holds it equal to the fixture, so the preview cannot drift from the
 * data Dan chose from.
 */
const condition = (logic: 'AND' | 'OR', conditions: { field: string; operator: string; value?: unknown }[]) => ({
  logic: 'AND' as const,
  groups: [{ logic, conditions }],
})

export const PREVIEW_NODE = { title: 'Validate bidding and state', id: 'validate_bidding_and_state' }

export const PREVIEW_CONFIG = {
  lead_id_field: 'trigger.payload.leadUuid',
  checks: [
    { id: 'check_1', label: 'Bidding is on', condition: condition('AND', [{ field: 'steps.constants.output.biddingActive', operator: 'is_true' }]), reason: 'bidding not active', on_missing: 'reject' },
    { id: 'check_2', label: 'State is allowed', condition: condition('AND', [{ field: 'trigger.payload.personalInformation.state', operator: 'in_array', value: 'steps.constants.output.states' }]), reason: 'ineligible state', on_missing: 'reject' },
    {
      id: 'check_3',
      label: 'Name has letters',
      condition: condition('AND', [
        { field: 'steps.parsed_name.output.firstName', operator: 'has_letter' },
        { field: 'steps.parsed_name.output.lastName', operator: 'has_letter' },
      ]),
      reason: 'invalid name',
      on_missing: 'reject',
    },
    { id: 'check_4', label: 'Loan within maximum', condition: condition('AND', [{ field: 'trigger.payload.loanInformation.loanAmount', operator: 'lte', value: 'steps.constants.output.maximumLoanAmount' }]), reason: 'loan amount exceeds maximum', on_missing: 'reject' },
    { id: 'check_5', label: 'Not military', condition: condition('AND', [{ field: 'trigger.payload.financialInformation.employmentStatus', operator: 'neq', value: 'military' }]), reason: 'military status ineligible', on_missing: 'reject' },
    { id: 'check_6', label: 'Self employed', condition: condition('AND', [{ field: 'trigger.payload.financialInformation.employmentStatus', operator: 'eq', value: 'self_employed' }]), reason: 'unqualified', on_missing: 'reject' },
    { id: 'check_7', label: 'Phone given', condition: condition('AND', [{ field: 'trigger.payload.personalInformation.primaryPhone', operator: 'not_blank' }]), reason: 'missing phone', on_missing: 'reject' },
  ],
  retries: 0,
}
