/**
 * The ops namespace's outbound Worker (#1709 part 3, plan 0.E).
 *
 * Ops workflows' code nodes will run in the `bidspoke-code-nodes-ops` dispatch
 * namespace, and the platform routes every request a script there makes (fetch,
 * and any other subrequest) here instead of to the internet. Until Phase 2
 * defines what ops code may reach, nothing is: every request is refused, so an
 * ops script can reach neither a partner, nor the bidding database, nor the
 * bidding Worker, whatever it does.
 *
 * A mirror of apps/compare-outbound rather than a reuse of it. The two refuse
 * alike today, but the compare Worker must refuse everything for ever (a shadow
 * run sends nothing), while this one is where Phase 2's allowlist lands. One
 * Worker serving both would make loosening ops egress loosen shadow runs too.
 *
 * The answer names the host so the step's error says what was stopped, and
 * carries neither the path, the query nor the body, which can hold a person's
 * details (L741). The log line is this Worker's own, so an ops refusal is never
 * read as a shadow run's.
 */

/** 403: the request is understood and will not be sent. */
export const EGRESS_DENIED_STATUS = 403

export default {
  fetch(request: Request): Response {
    const { host } = new URL(request.url)
    console.log(`ops_egress_denied host=${host} method=${request.method}`)
    return Response.json(
      {
        error: 'egress_denied',
        host,
        message: `ops code may reach nothing until its allowed egress is defined: this request to ${host} was stopped before it left Cloudflare.`,
      },
      { status: EGRESS_DENIED_STATUS, headers: { 'x-bidspoke-egress': 'denied' } },
    )
  },
} satisfies ExportedHandler
