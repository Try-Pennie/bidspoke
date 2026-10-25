/**
 * The services the ops Worker serves connections for (#2335, PR 8 of phase 5 of
 * #1689): the one registry OpsConnections and connectionFetch read their rules
 * from (ops-connections.ts passes its rules to connectionFetch, so the two
 * cannot disagree).
 *
 * Each service's entry arrives with its catalogue runtime entry and its actions
 * (Phase 7, #2337), built from its minter (./minters), its declared hosts, its
 * identity measurement (./identity.ts) and, where it has lookups, its schema
 * target. Snowflake was the first (snowflake-service.ts), then the ops Slack
 * bot (slack-service.ts, Dan's decision 6: never the alerts bot), then OpenAI
 * (openai-service.ts, a project's API key) and Anthropic (anthropic-service.ts,
 * a workspace's API key) and HTTP (http-service.ts, a key in a declared header
 * to one declared host). Salesforce
 * (salesforce-service.ts) was registered ahead of its actions, which followed in
 * #2337's Salesforce pull request; verify, lookups and steps reach the ops pool, which grants them only within the caps Dan
 * approved for the org (Decision 11, ops migration 20261020010000: the
 * trypennie org alone so far) and refuses every other one by name
 * (sf_cap_unset, or sf_org_unmeasured before verify has measured the org).
 * Google (google-service.ts, #2337) is built per request
 * by opsServiceRegistry, since its minter checks the ops database's delegation
 * list and signs with the ops Worker's key, neither of which exists at module
 * load; its token memo is kept here for the isolate's life all the same.
 * Every service not listed here is refused by
 * name (connection_service_unknown).
 *
 * No entry holds a fetch: a minter that asks a token endpoint asks it through
 * connectionFetch (AuthorizeInput.fetch), so registering a service adds no
 * path to the platform's fetch.
 */
import { anthropicServiceEntry } from './anthropic-service'
import { googleServiceEntry, type GoogleServiceDeps } from './google-service'
import { httpServiceEntry } from './http-service'
import { googleTokenMemo } from './minters/google'
import { oauthUserCache } from './minters/oauth-user'
import { openaiServiceEntry } from './openai-service'
import type { OpsServiceEntry } from './ops-connections'
import { salesforceServiceEntry } from './salesforce-service'
import { slackServiceEntry } from './slack-service'
import { snowflakeServiceEntry } from './snowflake-service'

const REGISTERED: Readonly<Record<string, OpsServiceEntry>> = {
  // Each minter's memo is per isolate, keyed on connection, generation and user.
  snowflake: snowflakeServiceEntry({ now: () => Date.now() }),
  salesforce: salesforceServiceEntry({ now: () => Date.now() }),
  // A static bot token: nothing is minted, so there is no memo.
  slack: slackServiceEntry(),
  // A static API key, sent with the declared project: nothing is minted, so there is no memo.
  openai: openaiServiceEntry(),
  // A static API key, sent with the declared workspace: nothing is minted, so there is no memo.
  anthropic: anthropicServiceEntry(),
  // A static key in a declared header, to one declared host: nothing is minted, so there is no memo.
  http: httpServiceEntry(),
}

/** The services built per request, with what each needs from the request's Worker. */
export const PER_REQUEST_SERVICES = ['google'] as const

/**
 * What the per request services need: Google's delegation list check and the
 * ops Worker's key, and the token objects of a person's own Google account
 * (#2338).
 */
export interface OpsServiceDeps {
  readonly google: Pick<GoogleServiceDeps, 'checkDelegation' | 'serviceAccountKey' | 'tokens'>
}

/** Google's token memo, per isolate, keyed on connection, generation, mailbox and scope (minters/google.ts). */
const GOOGLE_MEMO = googleTokenMemo({ now: () => Date.now() })
/** A person's own Google account's memo and token ids, per isolate, so a renewal names the token an earlier request handed out (#2338). */
const GOOGLE_OWN_ACCOUNT_CACHE = oauthUserCache({ now: () => Date.now() })

/**
 * A module scoped entry for a service key, or undefined: every registered
 * service but the per request ones, which only opsServiceRegistry builds. An
 * own key only: a 'constructor' must not reach Object.prototype.
 */
export function opsServiceEntry(service: string): OpsServiceEntry | undefined {
  return Object.hasOwn(REGISTERED, service) ? REGISTERED[service] : undefined
}

/** Every registered service's entry, the per request ones built with the deps given. What the live wiring passes. */
export function opsServiceRegistry(deps: OpsServiceDeps): (service: string) => OpsServiceEntry | undefined {
  const google = googleServiceEntry({ now: () => Date.now(), memo: GOOGLE_MEMO, ownAccountCache: GOOGLE_OWN_ACCOUNT_CACHE, ...deps.google })
  return (service) => (service === 'google' ? google : opsServiceEntry(service))
}

/** The registered service keys, for tests and the status of this deploy. */
export function registeredOpsServices(): string[] {
  return [...Object.keys(REGISTERED), ...PER_REQUEST_SERVICES]
}
