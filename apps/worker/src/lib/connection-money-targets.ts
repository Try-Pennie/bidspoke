/**
 * The money identities an ops connection may never declare (#2338, build PR 5;
 * plan discussion #2329, "at save, bidding compares the declared target against
 * money lane identities").
 *
 * WHY. Ops verify measures what a login authenticates as and refuses money's
 * Salesforce run as user (money_identity_match), but it cannot see whether a
 * declared Snowflake user is one the bidding export signs in as, nor whether a
 * declared client id or project is the bidding Worker's own. So the create
 * route compares the declared target against these first, with no call to an
 * outside service and never touching a plaintext login:
 *   SUPABASE_URL          the money Supabase project, by its ref (the first
 *                         label of its host) and by its host
 *   SALESFORCE_CLIENT_ID  the connected app money bids through, read where it
 *                         really lives: the organization's environment
 *                         variables first, then the Worker env (salesforce-creds.ts
 *                         measured on 2026-09-04 that the Worker env alone does
 *                         not hold it)
 *   every *_USER secret   each Snowflake user bidding signs in as, DERIVED from
 *                         the names in secret-lists.ts so a new one is covered
 *                         without an edit here (L217)
 *
 * SNOWFLAKE_ACCOUNT is not compared on its own. The plan names it WITH the
 * users: an ops connection may use the same account under its own user, so
 * refusing the account would refuse every ops Snowflake connection to Pennie's
 * account. And an account can be spelled two ways (its locator, or
 * organization-account), so requiring the account to match as well could miss
 * money's own user written the other way. So a money user is refused on any
 * account, the harmless side (L648).
 *
 * The comparison is field agnostic: every string the target holds, at any
 * depth, is compared against every money value, trimmed and lower cased, and a
 * URL by its host and the host's first label too. Erring towards a match only
 * ever refuses a save; erring the other way would let an ops step act as money.
 *
 * Values are read by name at request time and never printed: an answer names
 * the secret a match came from, never its value.
 */
import { hostWithin } from '@bidspoke/service-catalogue/schema'
import { PROD_BASE_URL, STAGING_BASE_URL } from '../engine/nodes/achieve-endpoint'
import { ACHIEVE_HOSTS } from '../engine/nodes/achieve-identity'
import { FEATURE_GATED_SECRETS, REQUIRED_PARTNER_SECRETS, REQUIRED_SECRETS } from './secret-lists'

/** Every secret naming a Snowflake user the bidding Worker signs in as, from the secret lists. */
export const MONEY_SNOWFLAKE_USER_NAMES: readonly string[] = (
  [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS, ...FEATURE_GATED_SECRETS] as readonly string[]
).filter((name) => name.endsWith('_USER'))

/**
 * `slack_alert_bot` is not compared here: a bot token's identity is in no
 * target, so the routes compare the bot ops verify measured against the alerts
 * bot (lib/slack-alert-bot.ts, #2337, Dan's decision 6).
 */
export type MoneyTargetKind = 'supabase_project' | 'salesforce_client_id' | 'snowflake_user' | 'slack_alert_bot'

export interface MoneyTarget {
  readonly kind: MoneyTargetKind
  /** The secret or variable the value was read from: what an answer names. */
  readonly source: string
  /** The value's comparable forms. Never printed. */
  readonly forms: readonly string[]
}

const MAX_DEPTH = 8

const norm = (v: string): string => v.trim().toLowerCase()

/** A value's comparable forms: itself, and for a URL its host and the host's first label. */
function formsOf(value: string): string[] {
  const plain = norm(value)
  if (plain === '') return []
  const forms = [plain]
  if (/^https?:\/\//.test(plain)) {
    try {
      const host = new URL(plain).hostname
      if (host !== '') forms.push(host, host.split('.')[0])
    } catch {
      // Not a URL after all: compared as written.
    }
  }
  return forms
}

function readText(env: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = Object.hasOwn(env, name) ? env[name] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The money identities from the Worker env, by name, and the money Salesforce
 * client ids read from the organization store. An unset or blank value is
 * left out, so it can never match a blank declaration.
 */
export function moneyTargetsFrom(env: Readonly<Record<string, unknown>>, salesforceClientIds: readonly string[]): MoneyTarget[] {
  const out: MoneyTarget[] = []
  const supabase = readText(env, 'SUPABASE_URL')
  if (supabase !== null) {
    // formsOf gives [url, host, ref] for a URL: the project is the ref and the
    // host, never the whole URL, which a target could write with a path.
    const forms = formsOf(supabase)
    out.push({ kind: 'supabase_project', source: 'SUPABASE_URL', forms: forms.length === 3 ? forms.slice(1) : forms })
  }
  const clientIds = [...salesforceClientIds, readText(env, 'SALESFORCE_CLIENT_ID') ?? '']
    .map(norm)
    .filter((v) => v !== '')
  if (clientIds.length > 0) out.push({ kind: 'salesforce_client_id', source: 'SALESFORCE_CLIENT_ID', forms: [...new Set(clientIds)] })
  for (const name of MONEY_SNOWFLAKE_USER_NAMES) {
    const user = readText(env, name)
    if (user !== null) out.push({ kind: 'snowflake_user', source: name, forms: [norm(user)] })
  }
  return out
}

function stringsOf(value: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((v) => stringsOf(v, depth + 1))
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap((v) => stringsOf(v, depth + 1))
  return []
}

/** The first money identity the target declares, or null. Names its kind and source only. */
export function moneyTargetIn(target: unknown, moneys: readonly MoneyTarget[]): { kind: MoneyTargetKind; source: string } | null {
  const declared = new Set(stringsOf(target).flatMap(formsOf))
  for (const money of moneys) {
    if (money.forms.some((f) => declared.has(f))) return { kind: money.kind, source: money.source }
  }
  return null
}

/** How the money Salesforce credentials of an organization are resolved: resolveSalesforceCredsFor, bound. */
export type ResolveSalesforceCreds = (organizationId: string) => Promise<{ creds: { clientId: string; instanceUrl: string } | null; missing: string[] }>

export type MoneyTargetsRead = { ok: true; targets: MoneyTarget[] } | { ok: false; detail: string }

/**
 * The money identities at request time. A store that cannot be read is an
 * answer of its own, never an empty set: with nothing to compare against, the
 * route refuses the save rather than passing it.
 */
export async function readMoneyTargets(env: Readonly<Record<string, unknown>>, organizationId: string, resolve: ResolveSalesforceCreds): Promise<MoneyTargetsRead> {
  let clientIds: string[]
  try {
    const { creds } = await resolve(organizationId)
    clientIds = creds ? [creds.clientId] : []
  } catch {
    // The error could name a value: only that the read failed is said.
    return { ok: false, detail: 'the organization\'s environment variables could not be read for the money Salesforce client id' }
  }
  return { ok: true, targets: moneyTargetsFrom(env, clientIds) }
}

// ── The hosts bidding sends to (#2337) ───────────────────────────────────────

/**
 * WHY. An HTTP connection (the catalogue's `http` service) carries any key to
 * the one host it declares, so its host is the only thing that can keep an ops
 * step off the money lane: off a partner the money lane posts leads to, and off
 * the bidding Worker, whose custom endpoints take leads into money workflows.
 * The catalogue's host rule (schema/http-host.ts) already refuses every host a
 * catalogue service owns, Supabase and Salesforce among them, on ops and here;
 * this adds the hosts only the bidding Worker can know. The save refuses an
 * HTTP host that is one of them, before verify sends anything to it.
 *
 * THE SOURCES, each read at the save, each answered by its name alone:
 *   SUPABASE_URL             the money project's host, and every host under it
 *   APP_URL                  the bidding Worker's zone: the parent of its host
 *                            (bidspoke.trypennie.dev gives trypennie.dev), since
 *                            every *.trypennie.dev route reaches this Worker
 *                            (wrangler.toml, partner subdomains), and every host
 *                            under it; the host alone when it has no zone above
 *   SALESFORCE_INSTANCE_URL  the money Salesforce instance, from the
 *                            organization store (resolveSalesforceCredsFor) and
 *                            the Worker env, and every host under it
 *   ACHIEVE_HOSTS            the hosts the achieve_offers node calls, which live
 *                            in code (engine/nodes/achieve-identity.ts,
 *                            achieve-endpoint.ts), exactly
 *   partner_configs          each partner's api_endpoint, dedup_endpoint and
 *                            click_url host, exactly
 *   money workflows          every http(s) host written anywhere in the
 *                            organization's money lane workflow definitions,
 *                            deleted ones left out: webhook URLs, code node
 *                            fetches, partner URLs, exactly
 * A partner or workflow host is taken exactly, never its domain, so a partner's
 * other hosts stay reachable; erring towards a match only ever refuses a save.
 *
 * WHAT IT CANNOT SEE. A host that reaches a money workflow only through an
 * environment variable ({{env.X}}) and is written nowhere else. A host the
 * money lane starts sending to after the HTTP connection was saved is not seen
 * at the save, since ops cannot read bidding's hosts; the daily HTTP connection
 * host check (http-money-host-check.ts, #2761) recomputes these hosts through
 * the same reads (money-host-reads.ts) and pages each saved connection whose
 * host is now among them. It only alerts: the connection keeps working.
 */
export type MoneyHostSource = 'SUPABASE_URL' | 'APP_URL' | 'SALESFORCE_INSTANCE_URL' | 'ACHIEVE_HOSTS' | 'partner_configs' | 'money workflows'

export interface MoneyHost {
  readonly host: string
  /** `domain`: the host and every host under it; `exact`: the host alone. */
  readonly match: 'domain' | 'exact'
  readonly source: MoneyHostSource
}

const URL_HOST = /https?:\/\/([A-Za-z0-9.-]+)/g

function hostOfUrl(value: string): string | null {
  const plain = value.trim()
  if (!/^https?:\/\//i.test(plain)) return null
  try {
    const host = new URL(plain).hostname.toLowerCase().replace(/\.$/, '')
    return host.includes('.') ? host : null
  } catch {
    return null
  }
}

export interface MoneyHostInputs {
  readonly salesforceInstanceUrls: readonly string[]
  readonly partnerUrls: readonly string[]
  /** The money workflows' definitions, as text. */
  readonly moneyDefinitions: readonly string[]
}

/** Every host bidding sends to, from the Worker env and the organization's stores. A blank or unparsable value adds nothing. */
export function moneyHostsFrom(env: Readonly<Record<string, unknown>>, inputs: MoneyHostInputs): MoneyHost[] {
  const out: MoneyHost[] = []
  const add = (host: string | null, match: MoneyHost['match'], source: MoneyHostSource) => {
    if (host !== null && !out.some((h) => h.host === host && h.match === match)) out.push({ host, match, source })
  }
  add(hostOfUrl(readText(env, 'SUPABASE_URL') ?? ''), 'domain', 'SUPABASE_URL')
  const app = hostOfUrl(readText(env, 'APP_URL') ?? '')
  if (app !== null) add(app.split('.').length >= 3 ? app.split('.').slice(1).join('.') : app, 'domain', 'APP_URL')
  for (const url of [...inputs.salesforceInstanceUrls, readText(env, 'SALESFORCE_INSTANCE_URL') ?? '']) add(hostOfUrl(url), 'domain', 'SALESFORCE_INSTANCE_URL')
  for (const host of [...ACHIEVE_HOSTS, hostOfUrl(PROD_BASE_URL), hostOfUrl(STAGING_BASE_URL)]) add(host, 'exact', 'ACHIEVE_HOSTS')
  for (const url of inputs.partnerUrls) add(hostOfUrl(url), 'exact', 'partner_configs')
  for (const text of inputs.moneyDefinitions) {
    for (const m of text.matchAll(URL_HOST)) add(hostOfUrl(`https://${m[1]}`), 'exact', 'money workflows')
  }
  return out
}

/** The money host a declared host is, or null. Names the host and the source only. */
export function moneyHostOf(host: string, hosts: readonly MoneyHost[]): { host: string; source: MoneyHostSource } | null {
  const h = host.toLowerCase()
  const found = hosts.find((m) => (m.match === 'domain' ? hostWithin(h, m.host) : h === m.host))
  return found ? { host: h, source: found.source } : null
}

/** The organization scoped reads behind the money hosts, bound to the bidding client by the route. */
export interface MoneyHostReads {
  readonly salesforce: ResolveSalesforceCreds
  partnerUrls(organizationId: string): Promise<string[]>
  moneyDefinitions(organizationId: string): Promise<string[]>
}

export type MoneyHostsRead = { ok: true; hosts: MoneyHost[] } | { ok: false; detail: string }

/**
 * The money hosts at request time. A source that cannot be read is an answer
 * of its own, never an empty set: the route refuses the save rather than
 * passing it.
 */
export async function readMoneyHosts(env: Readonly<Record<string, unknown>>, organizationId: string, reads: MoneyHostReads): Promise<MoneyHostsRead> {
  // Each error could name a value: only which read failed is said.
  let salesforceInstanceUrls: string[]
  try {
    const { creds } = await reads.salesforce(organizationId)
    salesforceInstanceUrls = creds ? [creds.instanceUrl] : []
  } catch {
    return { ok: false, detail: 'the organization\'s environment variables could not be read for the money Salesforce instance' }
  }
  let partnerUrls: string[]
  try {
    partnerUrls = await reads.partnerUrls(organizationId)
  } catch {
    return { ok: false, detail: 'the partner endpoints could not be read' }
  }
  let moneyDefinitions: string[]
  try {
    moneyDefinitions = await reads.moneyDefinitions(organizationId)
  } catch {
    return { ok: false, detail: 'the money workflows could not be read' }
  }
  return { ok: true, hosts: moneyHostsFrom(env, { salesforceInstanceUrls, partnerUrls, moneyDefinitions }) }
}
