/**
 * Salesforce names: an API name, and a 15 or 18 character record id. Nothing
 * else reaches a URL or a query. A leaf module, so the engine's Salesforce node,
 * the replay tool (#471) and the read-back (#2023) share one rule without an
 * import cycle between them.
 */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/

export const isSalesforceApiName = (name: string): boolean => API_NAME.test(name)
export const isSalesforceRecordId = (id: string): boolean => RECORD_ID.test(id)
