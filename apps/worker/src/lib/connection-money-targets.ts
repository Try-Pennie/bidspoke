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
import { FEATURE_GATED_SECRETS, REQUIRED_PARTNER_SECRETS, REQUIRED_SECRETS } from './secret-lists'

/** Every secret naming a Snowflake user the bidding Worker signs in as, from the secret lists. */
export const MONEY_SNOWFLAKE_USER_NAMES: readonly string[] = (
  [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS, ...FEATURE_GATED_SECRETS] as readonly string[]
).filter((name) => name.endsWith('_USER'))

export type MoneyTargetKind = 'supabase_project' | 'salesforce_client_id' | 'snowflake_user'

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
export type ResolveSalesforceCreds = (organizationId: string) => Promise<{ creds: { clientId: string } | null; missing: string[] }>

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
