/**
 * The grids of synthetic leads instrument 1 runs (#2591), one per workflow whose
 * validation script is being replaced.
 *
 * Each covers every arm the script has: each rejection reason, each field
 * missing, null, blank or of the wrong kind (a number, a boolean, a list, an
 * object), the parents of those fields missing outright, names with only
 * non-ASCII letters, and the amounts either side of every limit. The limits and
 * lists come from the workflow's own committed Constants data, so the grid moves
 * when the workflow's configuration does. No value here comes from a real lead.
 */
import { UNSET, type GridDimension, type GridSpec, type GridValue } from './grid'

type ConstantsData = Record<string, unknown>

const list = (data: ConstantsData, key: string): string[] => {
  const v = data[key]
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string')) throw new Error(`the Constants data has no list of text at ${key}`)
  return v as string[]
}
const num = (data: ConstantsData, key: string): number => {
  const v = data[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`the Constants data has no number at ${key}`)
  return v
}

/** Missing, null, blank, and every kind of value that is not text. */
function notText(good: string, rejects: boolean): GridValue[] {
  return [
    { label: '(unset)', value: UNSET, rejects },
    { label: 'null', value: null },
    { label: "''", value: '' },
    { label: "'   '", value: '   ' },
    { label: '5', value: 5 },
    { label: 'true', value: true },
    { label: `[${good}]`, value: [good] },
    { label: '{}', value: {} },
  ]
}

function stateDimension(allowed: string[]): GridDimension {
  const good = allowed[0]
  return {
    name: 'state',
    path: 'payload.personalInformation.state',
    values: [
      { label: 'ZZ', value: 'ZZ', rejects: true },
      ...allowed.map((s) => ({ label: s, value: s })),
      { label: `${good.toLowerCase()}`, value: good.toLowerCase() },
      { label: ` ${good}`, value: ` ${good}` },
      // A Cyrillic letter that looks like the first of the allowed state.
      { label: `${good} with a Cyrillic first letter`, value: `Т${good.slice(1)}` },
      ...notText(good, false),
    ],
  }
}

function nameDimension(name: string, path: string): GridDimension {
  return {
    name,
    path,
    values: [
      { label: "'1'", value: '1', rejects: true },
      { label: "'José'", value: 'José' },
      { label: "'Ñ'", value: 'Ñ' },
      { label: "'李'", value: '李' },
      { label: "'Ünal'", value: 'Ünal' },
      { label: "'  Dana  '", value: '  Dana  ' },
      ...notText('Dana', false),
    ],
  }
}

function amountValues(limit: number, over: 'above' | 'below', rejects: GridValue): GridValue[] {
  const bad = over === 'above' ? limit + 1 : limit - 1
  return [
    rejects,
    { label: `limit ${limit}`, value: limit },
    { label: `limit ${over === 'above' ? 'minus' : 'plus'} one`, value: over === 'above' ? limit - 1 : limit + 1 },
    { label: `limit ${over === 'above' ? 'plus' : 'minus'} one`, value: bad },
    { label: 'limit plus a cent', value: limit + 0.01 },
    { label: 'limit minus a cent', value: limit - 0.01 },
    { label: '0', value: 0 },
    { label: '-1', value: -1 },
    { label: "'limit' as text", value: String(limit) },
    { label: "' limit ' as text", value: ` ${limit} ` },
    { label: "'over limit' as text", value: String(over === 'above' ? limit + 1 : limit - 1) },
    { label: "'1,000' as text", value: '1,000' },
    { label: "'abc'", value: 'abc' },
    { label: '(unset)', value: UNSET },
    { label: 'null', value: null },
    { label: "''", value: '' },
    { label: "'   '", value: '   ' },
    { label: 'true', value: true },
    { label: 'false', value: false },
    { label: '[limit]', value: [limit] },
    { label: '{}', value: {} },
  ]
}

const EMPLOYMENT_STATUSES = ['employed', 'employed_full_time', 'employed_part_time', 'military', 'not_employed', 'other', 'retired', 'self_employed']

function employmentDimension(good: string, firstRejecting: string): GridDimension {
  return {
    name: 'employmentStatus',
    path: 'payload.financialInformation.employmentStatus',
    values: [
      { label: firstRejecting, value: firstRejecting, rejects: true },
      ...EMPLOYMENT_STATUSES.filter((s) => s !== firstRejecting).map((s) => ({ label: s, value: s })),
      { label: 'MILITARY', value: 'MILITARY' },
      { label: "' military'", value: ' military' },
      { label: 'SELF_EMPLOYED', value: 'SELF_EMPLOYED' },
      ...notText(good, false),
      { label: '[military]', value: ['military'] },
    ],
  }
}

const parents = (rejects: boolean): GridDimension[] => [
  { name: 'personalInformation', path: 'payload.personalInformation', values: [{ label: '(unset)', value: UNSET, rejects }, { label: 'null', value: null }] },
  { name: 'loanInformation', path: 'payload.loanInformation', values: [{ label: '(unset)', value: UNSET, rejects }, { label: 'null', value: null }] },
  { name: 'financialInformation', path: 'payload.financialInformation', values: [{ label: '(unset)', value: UNSET, rejects }, { label: 'null', value: null }] },
]

/**
 * RML GigFi and RML LendSwift: the same script shape, read from the
 * `parse_name` (LendSwift) or `parsed_name` (GigFi) step. GigFi takes only self
 * employed leads; LendSwift rejects a missing employment status.
 */
export function rmlGrid(constants: ConstantsData, nameStep: string, selfEmployedOnly: boolean): GridSpec {
  const states = list(constants, 'states')
  const max = num(constants, 'maximumLoanAmount')
  const good = selfEmployedOnly ? 'self_employed' : 'employed'
  return {
    base: {
      trace_id: 'trace-grid',
      payload: {
        leadUuid: 'lead-grid-1',
        personalInformation: { state: states[0], firstName: 'Dana', lastName: 'Reyes' },
        loanInformation: { loanAmount: Math.min(1000, max), purpose: 'debt_consolidation' },
        financialInformation: { employmentStatus: good, annualIncome: 50000 },
      },
      steps: {
        constants: { output: structuredClone(constants) },
        [nameStep]: { output: { firstName: 'Dana', lastName: 'Reyes', middleName: '' } },
      },
    },
    dimensions: [
      { name: 'biddingActive', path: 'steps.constants.output.biddingActive', values: [{ label: 'false', value: false, rejects: true }] },
      stateDimension(states),
      nameDimension('firstName', `steps.${nameStep}.output.firstName`),
      nameDimension('lastName', `steps.${nameStep}.output.lastName`),
      { name: 'loanAmount', path: 'payload.loanInformation.loanAmount', values: amountValues(max, 'above', { label: 'over the maximum', value: max * 2, rejects: true }) },
      employmentDimension(good, 'military'),
      { name: 'leadUuid', path: 'payload.leadUuid', values: [{ label: '(unset)', value: UNSET }, { label: '42', value: 42 }, { label: 'null', value: null }] },
      ...parents(true),
    ],
  }
}

/** Lead Economy: bidding from Salesforce's `IsActive`, a phone, and one unqualified check over four values. */
export function leadEconomyGrid(constants: ConstantsData, swapConstants: ConstantsData): GridSpec {
  const states = list(constants, 'states')
  const purposes = list(constants, 'allowedPurposes')
  const statuses = list(constants, 'allowedEmploymentStatuses')
  // The limit the node will read after the swap: the script's hard coded floor
  // and the Constants value it becomes are the same number then.
  const minLoan = num({ ...constants, ...swapConstants }, 'minimumLoanAmount')
  const oldMinLoan = num(constants, 'minimumLoanAmount')
  const minIncome = num(constants, 'minimumAnnualIncome')
  return {
    base: {
      trace_id: 'trace-grid',
      payload: {
        leadId1: 'lead-grid-1',
        personalInformation: { state: states[0], firstName: 'Dana', lastName: 'Reyes', primaryPhone: '5555550100' },
        loanInformation: { loanAmount: minLoan * 2, purpose: purposes[0] },
        financialInformation: { employmentStatus: statuses[0], annualIncome: minIncome * 2 },
      },
      steps: {
        constants: { output: structuredClone(constants) },
        parsed_name: { output: { firstName: 'Dana', lastName: 'Reyes', middleName: '' } },
        custom_request: { output: { status: 200, body: { IsActive: true } } },
      },
    },
    dimensions: [
      {
        name: 'IsActive',
        path: 'steps.custom_request.output.body.IsActive',
        values: [
          { label: 'false', value: false, rejects: true },
          { label: "'true'", value: 'true' },
          { label: '1', value: 1 },
          { label: '(unset)', value: UNSET },
          { label: 'null', value: null },
        ],
      },
      { name: 'custom_request body', path: 'steps.custom_request.output.body', values: [{ label: '(unset)', value: UNSET }, { label: 'null', value: null }] },
      stateDimension(states),
      nameDimension('firstName', 'steps.parsed_name.output.firstName'),
      nameDimension('lastName', 'steps.parsed_name.output.lastName'),
      {
        name: 'primaryPhone',
        path: 'payload.personalInformation.primaryPhone',
        values: [{ label: "''", value: '', rejects: true }, { label: "'٥٥٥'", value: '٥٥٥' }, ...notText('5555550100', false).filter((v) => v.label !== "''")],
      },
      {
        name: 'loanAmount',
        path: 'payload.loanInformation.loanAmount',
        values: [
          ...amountValues(minLoan, 'below', { label: 'under the minimum', value: Math.floor(minLoan / 2), rejects: true }),
          { label: `between the old minimum ${oldMinLoan} and the new`, value: Math.round((oldMinLoan + minLoan) / 2) },
          { label: `old minimum ${oldMinLoan}`, value: oldMinLoan },
        ],
      },
      { name: 'annualIncome', path: 'payload.financialInformation.annualIncome', values: amountValues(minIncome, 'below', { label: 'under the minimum', value: Math.floor(minIncome / 2), rejects: true }) },
      {
        name: 'purpose',
        path: 'payload.loanInformation.purpose',
        values: [
          { label: 'vacation', value: 'vacation', rejects: true },
          ...purposes.map((p) => ({ label: p, value: p })),
          { label: purposes[0].toUpperCase(), value: purposes[0].toUpperCase() },
          ...notText(purposes[0], false),
        ],
      },
      employmentDimension(statuses[0], 'retired'),
      { name: 'leadId1', path: 'payload.leadId1', values: [{ label: '(unset)', value: UNSET }, { label: '42', value: 42 }, { label: 'null', value: null }] },
      ...parents(true),
    ],
  }
}
