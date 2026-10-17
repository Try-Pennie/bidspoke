/**
 * ConnectionTokenObject, the first ops Durable Object (#2334, phase 4 of #1689,
 * plan: discussion #2329).
 *
 * What it will be (Phase 5): one object per person bound connection, holding
 * the OAuth refresh in flight so a refresh is single flight, writing a rotated
 * refresh token to its own storage before the new access token is returned
 * (L33, L561), and handing the rotated envelope back to the bidding database's
 * row by compare and set. Dan decided on 2026-10-17 to build person bound
 * logins in this milestone (decision 1).
 *
 * What it is in this deploy: inert. Durable Object migrations are one way
 * (ADR 0011), so the class ships in a deploy that adds nothing a running path
 * depends on: it is exported from src/ops/index.ts, bound as CONNECTION_TOKENS
 * in wrangler.ops.toml, created SQLite backed by the ops Worker's migration v1,
 * and called by nothing. Every request is refused by name, and it writes
 * nothing to its storage. The ops Worker's rollback floor is migration v1 from
 * the deploy that adds it (docs/disaster-recovery.md).
 *
 * Who may call it: only the ops Worker, through its own binding. A Durable
 * Object has no public route, and the bidding Worker binds no ops object (the
 * ops config test refuses a script_name, so neither Worker reaches the other's
 * objects).
 */

/** The refusal every request gets until Phase 5 gives the object its methods. */
export const CONNECTION_TOKEN_OBJECT_INERT = 'connection_token_object_inert'

export class ConnectionTokenObject implements DurableObject {
  constructor(_state: DurableObjectState, _env: unknown) {}

  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify({ error: CONNECTION_TOKEN_OBJECT_INERT }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
  }
}
