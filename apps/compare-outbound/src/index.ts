/**
 * The compare namespace's outbound Worker (#1708 part B, plan 0.D).
 *
 * A shadow run rehearses a workflow and must send nothing. Its code nodes run
 * in the `bidspoke-code-nodes-compare` dispatch namespace, and the platform
 * routes every request a script in that namespace makes (fetch, and any other
 * subrequest) here instead of to the internet. So a shadow run's code cannot
 * call a partner, Equifax or Salesforce, whatever the script does, which a
 * stub inside the script could never promise.
 *
 * Deny mode only: nothing is forwarded or replayed (plan 0.D drops replay, as
 * there is no recorded egress to replay). The answer names the host so the
 * step's error says what was stopped, and carries neither the path, the query
 * nor the body, which can hold a person's details (L741).
 */

/** 403: the request is understood and will not be sent. */
export const EGRESS_DENIED_STATUS = 403

export default {
  fetch(request: Request): Response {
    const { host } = new URL(request.url)
    console.log(`egress_denied host=${host} method=${request.method}`)
    return Response.json(
      {
        error: 'egress_denied',
        host,
        message: `A shadow run sends nothing: this request to ${host} was stopped before it left Cloudflare.`,
      },
      { status: EGRESS_DENIED_STATUS, headers: { 'x-bidspoke-egress': 'denied' } },
    )
  },
} satisfies ExportedHandler
