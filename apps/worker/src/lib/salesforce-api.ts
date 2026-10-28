/**
 * The Salesforce REST API's request, URL and error classification rules
 * (#2335, PR 3 of phase 5 of #1689), which live in the workspace package
 * @bidspoke/salesforce-api since #2337, so the service catalogue's Salesforce
 * actions judge an answer by these same rules. Re-exported whole, so every
 * Worker caller (the Salesforce node, the money identity job, the ops minter
 * and the sf_limits sweep) imports from here as before.
 *
 * Every Salesforce URL in the Worker is built here, never by hand (#2394,
 * apps/web/src/lib/__guards__/worker/salesforce-urls-through-shared-module.test.ts).
 * The object name salesforceSobjectUrl, salesforceRecordUrl and
 * salesforceUpsertUrl take goes into the path as it is, not encoded. An API name
 * holds only letters, digits and underscores, so encoding one changes nothing;
 * a caller with a name from outside the code checks it is one first
 * (isSalesforceApiName in lib/salesforce-names.ts, as bid-range-flags,
 * salesforce-write and schema-sync do, and the catalogue's objectName), so
 * nothing else reaches the URL as more than one path segment. The rule is held
 * by the callers rather than added to the package, because the package is part
 * of every released Salesforce catalogue action's fingerprint, so any edit to it
 * would ask for a new version of all ten of them (D1). The Salesforce node passes
 * its step's configured object unchecked; every live step names an API name.
 */
export * from '@bidspoke/salesforce-api'
