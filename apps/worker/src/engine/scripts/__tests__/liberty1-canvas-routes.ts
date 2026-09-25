/**
 * Where the Liberty1 click workflow sends each route since Brian's version 4 of
 * it (2026-09-25): LeadConnector webhook triggers rather than the Liberty1
 * Salesforce site his Pipedream flow posts to. Tests prove the BODY against his
 * code (liberty1-pipedream-oracle.ts) and the URL against these.
 *
 * The doubled slash is as saved: the base ends in a slash and each route adds
 * another. Whether that is intended is unconfirmed, so it is pinned as it ships
 * rather than tidied.
 */
const LEADCONNECTOR_BASE = 'https://services.leadconnectorhq.com/hooks/1TkhxxyKTddL2rZ7wHI2/webhook-trigger/'

export const CANVAS_ROUTES = {
  DV1: `${LEADCONNECTOR_BASE}/CTTs3WKFFvjTUTQOlrHF`,
  DI4: `${LEADCONNECTOR_BASE}/AYAF77n9lUw8WbZ4kaRM`,
} as const
