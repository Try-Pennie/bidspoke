import { HTTP_SERVICE_KEY } from '../http-host'
import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * HTTP (#2337, phase 7 of #1689): any web API that takes a key, on one host.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted):
 *   http-custom-request   638 steps in 188 workflows, 62 of them disabled
 *   http-post-request       5 steps in 3 workflows
 *   http-get-request        none
 * The export redacts every one of their settings (`httpRequest` reads
 * `<redacted>`), so which method, host and key each uses is read off
 * Pipedream when its workflow is ported. Pipedream's POST request is its
 * custom request with POST chosen (PipedreamHQ/pipedream
 * components/http/actions/post-request/post-request.mjs spreads
 * custom-request.mjs, at commit b7d67916), so it ports to the custom request
 * with method POST and is not an action of its own. The GET request is one for
 * its traits: a read is retried and refused by no run that is not real, where
 * a custom request is neither, whatever method it names.
 *
 * The connection (decided in #2337, see the pull request):
 *   host        the one host connectionFetch lets it reach, a bare host or a
 *               whole address it is read out of (schema/http-host.ts). Never a
 *               host another catalogue service owns, never an address by
 *               number, and at save never one bidding sends to
 *               (apps/worker lib/connection-money-targets.ts).
 *   header      the header the key is sent in (X-API-Key, Authorization).
 *   check_path  a GET on that host which needs the key and changes nothing:
 *               verify and the connection check ask it, and a 2xx proves the
 *               key (apps/worker src/ops/connections/http-service.ts).
 *   api_key     the header's whole value, sealed: "Bearer abc" for a bearer
 *               token, the key alone for a key header. The static key minter
 *               sends it as written (minters/static-key.ts headerPlacement).
 */

const text = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: false })
const json = (key: string): ActionArgument => ({ key, type: 'text', required: false, allowsVariables: true, parseJson: true })

// A path on the connection's host, or a whole https address on it.
const URL_ARG = text('url', true)
// An object of query parameters, each text, a number or true or false.
const QUERY = json('query')
// An object of header names to text values. The connection's key is put on by connectionFetch, never here.
const HEADERS = json('headers')
// true returns { status, headers, data }, where Pipedream exported the headers beside the data.
const INCLUDE_HEADERS: ActionArgument = { key: 'include_headers', type: 'text', required: false, allowsVariables: false, parseJson: true }

export const HTTP_GET_REQUEST_V1: ActionSchema = {
  key: 'http.get-request',
  name: 'Send a GET request',
  version: 1,
  arguments: [URL_ARG, QUERY, HEADERS, INCLUDE_HEADERS],
  sideEffect: false,
  idempotent: true,
  idempotentBecause:
    'HTTP defines GET as safe (RFC 9110, 9.2.1): it asks for what is there and changes nothing, so sending it again after an uncertain outcome reads the same thing again.',
}

export const HTTP_CUSTOM_REQUEST_V1: ActionSchema = {
  key: 'http.custom-request',
  name: 'Send any HTTP request',
  version: 1,
  arguments: [
    // GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS, fixed when the step is saved.
    { key: 'method', type: 'text', required: true, allowsVariables: false, parseJson: false },
    URL_ARG,
    QUERY,
    HEADERS,
    // A JSON body, sent as application/json unless the step's headers name another type.
    json('body'),
    // A body sent exactly as written, for a type that is not JSON.
    text('body_text'),
    // An object sent as application/x-www-form-urlencoded.
    json('form'),
    INCLUDE_HEADERS,
  ],
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'Its method is the step\'s to choose, and a POST or PATCH to an API Bidspoke does not know may create or change something each time it arrives, so after an uncertain outcome a person decides whether to send it again.',
}

export const HTTP_SERVICE: ServiceSchema = {
  key: HTTP_SERVICE_KEY,
  name: 'HTTP',
  actions: [HTTP_GET_REQUEST_V1, HTTP_CUSTOM_REQUEST_V1],
  // The static key minter reads `api_key` from the login and the ops HTTP entry
  // reads `host`, `header` and `check_path` from the target (http-service.ts).
  connection: {
    tile: 'Any web API that takes a key',
    auth: 'static_key',
    fields: [
      { key: 'host', label: 'Host', input: 'text', required: true, target: 'host' },
      { key: 'header', label: 'Header', input: 'text', required: true, target: 'header' },
      { key: 'check_path', label: 'Check path', input: 'text', required: true, target: 'check_path' },
      { key: 'api_key', label: 'Header value', input: 'secret', required: true, login: 'api_key' },
    ],
  },
}
