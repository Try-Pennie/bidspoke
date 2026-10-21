import type { ServiceSchema } from './types'

/**
 * What a connection to a service is made of (#2338, PR 1 of its build plan):
 * the Add connection tile's one line (R12), how it signs in, and the fields a
 * person fills in, each saying where its value goes. A value goes into the
 * sealed login (secret, opened only by the ops minter), into the target (the
 * connection's public declaration: which org, which account), or both, as
 * Salesforce's client id does, since its minter refuses a login whose client
 * id is not the declared one.
 *
 * The login and target names are a contract with the ops minters
 * (apps/worker/src/ops/connections/minters/, set on #2411), held by
 * apps/worker/src/ops/connections/__tests__/catalogue-connection-fields.test.ts:
 * a login and target built here by connectionParts must be exactly what the
 * service's minter reads.
 *
 * Every form starts with the connection's own Name, which is neither login nor
 * target, so it is not declared per service.
 */

/** How a connection signs in, one per ops minter (minters/static-key.ts, snowflake.ts, salesforce.ts, google.ts, oauth-user.ts). */
export const CONNECTION_AUTH_KINDS = ['static_key', 'key_pair', 'client_credentials', 'service_account_delegation', 'oauth_user'] as const
export type ConnectionAuthKind = (typeof CONNECTION_AUTH_KINDS)[number]

/**
 * The control a field is drawn with:
 *   - `text`, a one line box;
 *   - `secret`, a masked one line box;
 *   - `secret_block`, a masked box for a multi line key (a PEM);
 *   - `salesforce_org`, the dropdown of the orgs Bidspoke knows, with Another
 *     org last (R15);
 *   - `google_subject`, the dropdown of the organization's company list of
 *     mailboxes and drives (R16, D16), under the choice between a company
 *     mailbox or drive and your own Google account.
 * The Add connection form (apps/web/src/components/connections, build PR 10
 * of #2338) draws each.
 */
export const CONNECTION_INPUTS = ['text', 'secret', 'secret_block', 'salesforce_org', 'google_subject'] as const
export type ConnectionInput = (typeof CONNECTION_INPUTS)[number]

const SECRET_INPUTS: ReadonlySet<ConnectionInput> = new Set(['secret', 'secret_block'])

export interface ConnectionField {
  /** The form's key for the value, unique within the service. */
  readonly key: string
  /** The field's label on the form. */
  readonly label: string
  readonly input: ConnectionInput
  readonly required: boolean
  /** The sealed login field the value is written under. */
  readonly login?: string
  /** The target field the value is declared under. Never for a secret: the target is public. */
  readonly target?: string
}

export interface ConnectionDeclaration {
  /** The tile's one line of what the service connects, under its name (R12). */
  readonly tile: string
  readonly auth: ConnectionAuthKind
  /** In the order the form shows them, after Name. */
  readonly fields: readonly ConnectionField[]
}

/** The first field of every connection form: the connection's own name. */
export const CONNECTION_NAME_LABEL = 'Name'

/** The form's labels in order, Name first. */
export function connectionFormLabels(connection: ConnectionDeclaration): string[] {
  return [CONNECTION_NAME_LABEL, ...connection.fields.map((f) => f.label)]
}

/**
 * What a sentence calls the service's secret ("client secret"), or "login"
 * when it declares none. The save route's refusals and the Connections page's
 * problem notice both word it from here (#2338), so they cannot disagree.
 */
export function connectionSecretLabel(connection: ConnectionDeclaration): string {
  const secret = connection.fields.find((f) => SECRET_INPUTS.has(f.input))
  return secret ? secret.label.toLowerCase() : 'login'
}

/** The login's field names, in form order. */
export function loginFieldNames(connection: ConnectionDeclaration): string[] {
  return connection.fields.flatMap((f) => (f.login === undefined ? [] : [f.login]))
}

/** The target's field names, in form order. */
export function targetFieldNames(connection: ConnectionDeclaration): string[] {
  return connection.fields.flatMap((f) => (f.target === undefined ? [] : [f.target]))
}

export type ConnectionProblemCode =
  | 'tile_missing'
  | 'auth_kind_unknown'
  | 'input_unknown'
  | 'field_key_duplicate'
  | 'field_label_duplicate'
  | 'field_not_placed'
  | 'login_field_duplicate'
  | 'target_field_duplicate'
  | 'secret_in_target'
  | 'secret_not_in_login'

export interface ConnectionProblem {
  readonly code: ConnectionProblemCode
  /** `<service key>` or `<service key>.<field key>`. */
  readonly subject: string
  readonly message: string
}

/** What is wrong with a service's connection declaration; empty when nothing is. */
export function connectionProblems(service: ServiceSchema): ConnectionProblem[] {
  const c = service.connection
  const problems: ConnectionProblem[] = []
  const add = (code: ConnectionProblemCode, subject: string, message: string) => problems.push({ code, subject, message })

  if (c.tile.trim() === '') add('tile_missing', service.key, `${service.key} has no tile line saying what it connects`)
  if (!(CONNECTION_AUTH_KINDS as readonly string[]).includes(c.auth)) add('auth_kind_unknown', service.key, `${service.key} signs in by ${String(c.auth)}, which no ops minter is`)

  const keys = new Set<string>()
  const labels = new Set<string>([CONNECTION_NAME_LABEL])
  const loginNames = new Set<string>()
  const targetNames = new Set<string>()
  for (const f of c.fields) {
    const subject = `${service.key}.${f.key}`
    if (!(CONNECTION_INPUTS as readonly string[]).includes(f.input)) add('input_unknown', subject, `${subject} is drawn as ${String(f.input)}, which is not a connection input`)
    if (keys.has(f.key)) add('field_key_duplicate', subject, `${service.key} declares the field ${f.key} twice`)
    keys.add(f.key)
    if (labels.has(f.label)) add('field_label_duplicate', subject, `${service.key}'s form would show the label ${f.label} twice`)
    labels.add(f.label)
    if (f.login === undefined && f.target === undefined) add('field_not_placed', subject, `${subject} goes into neither the login nor the target, so its value is dropped`)
    if (f.login !== undefined) {
      if (loginNames.has(f.login)) add('login_field_duplicate', subject, `two of ${service.key}'s fields write the login field ${f.login}`)
      loginNames.add(f.login)
    }
    if (f.target !== undefined) {
      if (targetNames.has(f.target)) add('target_field_duplicate', subject, `two of ${service.key}'s fields write the target field ${f.target}`)
      targetNames.add(f.target)
    }
    if (SECRET_INPUTS.has(f.input)) {
      if (f.target !== undefined) add('secret_in_target', subject, `${subject} is a secret declared in the target, which is public`)
      if (f.login === undefined) add('secret_not_in_login', subject, `${subject} is a secret kept out of the sealed login`)
    }
  }
  return problems
}

export type ConnectionParts =
  | { readonly ok: true; readonly login: Record<string, string>; readonly target: Record<string, string> }
  | { readonly ok: false; readonly missing: readonly string[]; readonly unknown: readonly string[] }

/**
 * The login and target a filled in form makes, by field key. A blank value is
 * absent: a required one is named in `missing`, an optional one is left out.
 * Every other value is kept exactly as given (a PEM's line breaks are part of
 * it). A value no field declares is named in `unknown`, never dropped quietly.
 */
export function connectionParts(connection: ConnectionDeclaration, values: Readonly<Record<string, string | undefined>>): ConnectionParts {
  const declaredKeys = new Set(connection.fields.map((f) => f.key))
  const unknown = Object.keys(values).filter((k) => !declaredKeys.has(k))
  const missing: string[] = []
  const login: Record<string, string> = {}
  const target: Record<string, string> = {}
  for (const f of connection.fields) {
    const value = Object.hasOwn(values, f.key) ? values[f.key] : undefined
    if (value === undefined || value.trim() === '') {
      if (f.required) missing.push(f.key)
      continue
    }
    if (f.login !== undefined) login[f.login] = value
    if (f.target !== undefined) target[f.target] = value
  }
  if (missing.length > 0 || unknown.length > 0) return { ok: false, missing, unknown }
  return { ok: true, login, target }
}
