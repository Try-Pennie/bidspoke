/**
 * The partner checkboxes on Salesforce's BidRangeRow__c, read from Salesforce.
 *
 * A bid matrix is the set of rows sharing one combination of these checkboxes
 * (plus IsSellOff__c, which splits a partner's matrix in two). The list was
 * hard coded at 8 while Salesforce grew to 11, so Borrow Better and Lead
 * Economy rows read as the default matrix and the audit reported their bids as
 * edits to it every hour (#1864). It is derived from the describe instead, and
 * a describe that cannot be read refuses the run rather than falling back.
 */

import { parseJson } from './json'

export interface PartnerFlag {
  /** API name, e.g. IsBorrowBetter__c. */
  field: string
  /** The matrix's name as people use it, from the field label: "Borrow Better". */
  label: string
}

interface DescribeField {
  name: string
  type: string
  label: string
}

const NOT_A_PARTNER = new Set(['IsSellOff__c', 'IsDeleted'])

export function partnerFlagsFromDescribe(describe: { fields: DescribeField[] }): PartnerFlag[] {
  const flags = describe.fields
    .filter((f) => f.type === 'boolean' && /^Is\w*__c$/.test(f.name) && !NOT_A_PARTNER.has(f.name))
    // "Is Borrow Better" and "IsBrainsome" carry the prefix; "Island Lending" does not.
    .map((f) => ({ field: f.name, label: f.label.replace(/^Is(?=\s|[A-Z])\s*/, '').trim() || f.name }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
  if (flags.length === 0) {
    throw new Error('the describe has no partner checkbox fields, so no matrix can be told apart from another')
  }
  return flags
}

/**
 * Reads the partner checkboxes of the object a matrix lives on, BidRangeRow__c
 * unless a config names another, so its rows are filtered by its own fields.
 */
export async function fetchPartnerFlags(
  instanceUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  sobject = 'BidRangeRow__c',
): Promise<PartnerFlag[]> {
  const res = await fetchImpl(`${instanceUrl}/services/data/v60.0/sobjects/${encodeURIComponent(sobject)}/describe`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`the describe of ${sobject} failed (${res.status}): ${text.slice(0, 500)}`)
  }
  return partnerFlagsFromDescribe(await parseJson<{ fields: DescribeField[] }>(res))
}

/** The default matrix is the rows no partner has claimed. */
export function defaultMatrixWhere(flags: PartnerFlag[]): string {
  return flags.map((f) => `${f.field} = FALSE`).join(' AND ')
}
