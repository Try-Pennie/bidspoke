/**
 * The Salesforce REST API's request, URL and error classification rules
 * (#2335, PR 3 of phase 5 of #1689), which live in the workspace package
 * @bidspoke/salesforce-api since #2337, so the service catalogue's Salesforce
 * actions judge an answer by these same rules. Re-exported whole, so every
 * Worker caller (the Salesforce node, the money identity job, the ops minter
 * and the sf_limits sweep) imports from here as before.
 */
export * from '@bidspoke/salesforce-api'
