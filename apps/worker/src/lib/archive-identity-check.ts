/**
 * Verifying what each archive identity can actually do, daily (#914).
 *
 * The decision is in `archive/identity-permissions.ts` and is pure. This asks
 * Snowflake, as each identity in turn.
 *
 * THE DELETE PROBE IS THE POINT. Reading `SHOW GRANTS` tells you what the
 * account says; running a delete tells you what happens. A guard is only real
 * once it has been seen to refuse something (L1), and this is the only thing in
 * the system that ever asks the writer or reader to destroy an archived row.
 *
 * The statement is built by `deleteProbeStatement` below, which interpolates
 * NOTHING and always carries a constant-false predicate, and a test asserts
 * exactly that. It matters more than it looks: this runs daily, as an identity
 * that may hold DELETE, against 13 months of unredacted identity data. The
 * predicate is the only thing standing between a permission check and an
 * erasure, so it is not allowed to be built from anything a caller supplies.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { withJobRun } from './job-run-record'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { executeStatement, SnowflakeStatementError, type SnowflakeStatementResponse } from './snowflake'
import {
  archiveConfig,
  ARCHIVE_DATABASE,
  ARCHIVE_SCHEMA,
  ARCHIVE_TABLE,
  ARCHIVE_ROLES,
  unsetSecretNamed,
  type ArchiveIdentity,
} from './archive-snowflake'
import {
  identityFindings,
  type IdentityObservation,
  type IdentityFinding,
  type IdentityName,
} from '../archive/identity-permissions'
import type { Env } from '../index'

/**
 * The three Snowflake archive identities are not split as declared, or could not
 * be checked. This is about GRANTS, not about data moving anywhere.
 */
export const ARCHIVE_IDENTITY_REMEDY: AlertRemedy = {
  consequence:
    'The least privilege split between the three archive identities is not in force, or could not be ' +
    'verified. Nothing was sent anywhere and no data is missing: what is wrong is who is able to do ' +
    'what to thirteen months of unredacted identity data:',
  fixHint:
    'Act in Snowflake. Revoke DELETE on the archive table from the writer and reader, grant it to the ' +
    'eraser, and clear default secondary roles on any identity that has them active. If a line says a ' +
    'secret is not set, set it with wrangler secret put and its name, --name bidspoke-worker.',
  headlineVerb: 'found a permission problem',
  itemNoun: { one: 'finding', many: 'findings' },
}

/**
 * The fix line for THIS run's findings (#835).
 *
 * "The named secret is the fix" used to be printed for every identity that
 * could not be verified, including a Snowflake 5xx, a timeout or a shape this
 * could not read, where setting a secret changes nothing. Each sentence now
 * appears only for the finding it fixes.
 */
export function identityRemedyFor(findings: readonly IdentityFinding[]): AlertRemedy {
  const fixes: string[] = []
  if (findings.some((f) => f.code !== 'unreadable')) {
    fixes.push(
      'Act in Snowflake. Revoke DELETE on the archive table from the writer and reader, grant it to the ' +
        'eraser, and clear default secondary roles on any identity that has them active.',
    )
  }
  const unreadable = findings.filter((f) => f.code === 'unreadable')
  const unset = [...new Set(unreadable.map((f) => unsetSecretNamed(f.message)).filter((n): n is string => n !== null))]
  for (const name of unset) {
    fixes.push(`Set ${name} with wrangler secret put ${name} --name bidspoke-worker, piping the value in.`)
  }
  if (unreadable.some((f) => unsetSecretNamed(f.message) === null)) {
    fixes.push(
      'Where an identity could not be verified for another reason, the line carries the error Snowflake ' +
        'gave: an outage or a timeout is checked again on the next daily run, and anything else needs that ' +
        "role's grants read in Snowflake.",
    )
  }
  return { ...ARCHIVE_IDENTITY_REMEDY, fixHint: fixes.join(' ') }
}

export const ARCHIVE_IDENTITY_JOB = 'execution-archive-identities'

const QUALIFIED_TABLE = `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`

/**
 * Snowflake codes that mean the role was refused on privileges.
 *
 * 003001 is "Insufficient privileges to operate on <object>". 003011 is the
 * same shape for a statement the role may not run at all.
 */
const INSUFFICIENT_PRIVILEGE_CODES = new Set(['003001', '003011'])

/**
 * Codes Snowflake uses for "does not exist OR not authorized", deliberately
 * conflating the two so an unauthorised caller cannot probe for object names.
 * Resolved by the decision using the other identities in the same run.
 */
const AMBIGUOUS_CODES = new Set(['002003'])

/**
 * The probe statement. Takes no arguments and interpolates nothing.
 *
 * `WHERE FALSE` is a constant-false predicate, so the statement can match no row
 * under any circumstances. It exists to be REFUSED: for the writer and reader a
 * privilege error is the only outcome a correct account can produce, and success
 * is the finding.
 */
export function deleteProbeStatement(): string {
  return `DELETE FROM ${QUALIFIED_TABLE} WHERE FALSE`
}

export interface IdentityCheckResult {
  observations: IdentityObservation[]
  findings: IdentityFinding[]
  alerted: boolean
}

export interface IdentityCheckDeps {
  /** Runs a statement AS the given identity. Injected so tests drive the real logic. */
  query?: (identity: ArchiveIdentity, statement: string) => Promise<SnowflakeStatementResponse>
}

function columnAt(response: SnowflakeStatementResponse, name: string): number {
  const names = response.resultSetMetaData?.rowType?.map((c) => c.name.toLowerCase()) ?? []
  return names.indexOf(name.toLowerCase())
}

/**
 * Privileges SHOW GRANTS reports on the archive table.
 *
 * Read by column NAME and matched on the object name, because a role holds
 * grants on the database and schema too and counting those as table privileges
 * would report a role as holding whatever it holds anywhere (L135).
 */
function tablePrivileges(response: SnowflakeStatementResponse): string[] | null {
  const privilegeAt = columnAt(response, 'privilege')
  const nameAt = columnAt(response, 'name')
  const onAt = columnAt(response, 'granted_on')
  if (privilegeAt < 0 || nameAt < 0 || onAt < 0) return null

  const wanted = QUALIFIED_TABLE.toUpperCase()
  const found: string[] = []
  for (const row of response.data ?? []) {
    if (String(row[onAt]).toUpperCase() !== 'TABLE') continue
    if (String(row[nameAt]).toUpperCase() !== wanted) continue
    found.push(String(row[privilegeAt]))
  }
  return found
}

async function observe(
  identity: ArchiveIdentity,
  query: (identity: ArchiveIdentity, statement: string) => Promise<SnowflakeStatementResponse>,
): Promise<IdentityObservation> {
  const observation: IdentityObservation = {
    identity: identity as IdentityName,
    tablePrivileges: null,
    secondaryRoles: null,
    deleteProbe: 'unknown',
    unreadable: [],
  }

  // Why each read failed, in the read's own words, kept alongside the messages
  // so identical causes can be recognised at the end.
  const causes: string[] = []

  // Each read in its own try. The delete probe is the one that matters, so it
  // must run even if the grant listing failed: a check that stopped at the first
  // error would skip the only observed evidence it collects.
  try {
    const response = await query(identity, `SHOW GRANTS TO ROLE ${ARCHIVE_ROLES[identity]}`)
    const privileges = tablePrivileges(response)
    if (privileges === null) {
      observation.unreadable.push('SHOW GRANTS came back in a shape with no privilege, name or granted_on column')
    } else {
      observation.tablePrivileges = privileges
    }
  } catch (err) {
    const cause = formatErr(err)
    causes.push(cause)
    observation.unreadable.push(`its grants could not be read: ${cause}`)
  }

  try {
    const response = await query(identity, 'SELECT CURRENT_SECONDARY_ROLES()')
    const cell = response.data?.[0]?.[0]
    if (cell === null || cell === undefined) {
      observation.secondaryRoles = ''
    } else if (typeof cell === 'string' || typeof cell === 'number') {
      observation.secondaryRoles = String(cell)
    } else {
      // Not stringified blindly. An object renders as "[object Object]", which
      // reads as roles being active and produces an alert nobody can act on.
      observation.unreadable.push(
        `its active secondary roles came back as ${JSON.stringify(cell)}, which is not a value this can read`,
      )
    }
  } catch (err) {
    const cause = formatErr(err)
    causes.push(cause)
    observation.unreadable.push(`its active secondary roles could not be read: ${cause}`)
  }

  try {
    await query(identity, deleteProbeStatement())
    // It RAN. For an identity that must hold no DELETE this is the finding, not
    // a success.
    observation.deleteProbe = 'allowed'
  } catch (err) {
    // Classified on Snowflake's own error CODE, never on words in the message.
    // The wording is Snowflake's to change, and an unrecognised message would
    // fall to whichever side a regex happened to leave it, which for this check
    // means silently reporting an outage as a verified control (L35, L11).
    const code = err instanceof SnowflakeStatementError ? err.code : null
    if (code !== null && INSUFFICIENT_PRIVILEGE_CODES.has(code)) {
      observation.deleteProbe = 'refused'
    } else if (code !== null && AMBIGUOUS_CODES.has(code)) {
      observation.deleteProbe = 'ambiguous'
    } else {
      const cause = formatErr(err)
      causes.push(cause)
      observation.unreadable.push(
        `its delete probe failed for a reason other than permissions: ${cause}`,
      )
    }
  }

  // ONE CAUSE MUST READ AS ONE CAUSE. An unset credential fails every read
  // before a request leaves the Worker, and on 2026-08-23 two missing secrets
  // produced six alert lines, three per identity, each naming the same secret.
  // Six lines cannot be told from six problems, and the repetition buried the
  // one genuine finding in the same alert.
  //
  // Collapsed only on an EXACT match of the causes, and only when every
  // unreadable entry came from a failed read, so two genuinely different
  // failures stay two findings (L11). Keyed on the causes rather than on a
  // count of the reads, so adding a fourth read cannot silently unfix this.
  if (causes.length >= 2 && causes.length === observation.unreadable.length && new Set(causes).size === 1) {
    observation.unreadable = [causes[0]]
  }

  return observation
}

export async function checkArchiveIdentities(
  env: Env,
  supabase: SupabaseClient,
  deps: IdentityCheckDeps = {},
): Promise<IdentityCheckResult> {
  // See the note on the settings check: a check whose only liveness sign is an
  // alert cannot be told apart from one that died (#1251).
  return withJobRun(
    supabase,
    ARCHIVE_IDENTITY_JOB,
    () => identityPass(env, supabase, deps),
    (result) => ({
      outcome: result.findings.length === 0 ? 'ok' : 'findings',
      detail:
        result.findings.length === 0
          ? undefined
          : `${result.findings.length} identity finding${result.findings.length === 1 ? '' : 's'}`,
      summary: { findings: result.findings.length, alerted: result.alerted },
    }),
  )
}

async function identityPass(
  env: Env,
  supabase: SupabaseClient,
  deps: IdentityCheckDeps = {},
): Promise<IdentityCheckResult> {
  const query =
    deps.query ??
    ((identity: ArchiveIdentity, statement: string) => executeStatement(archiveConfig(env, identity), statement))

  const observations: IdentityObservation[] = []
  for (const identity of ['writer', 'reader', 'eraser'] as ArchiveIdentity[]) {
    observations.push(await observe(identity, query))
  }

  const findings = identityFindings(observations)
  await notifyExportFailure(
    supabase,
    ARCHIVE_IDENTITY_JOB,
    findings.map((f) => f.message),
    env.IDEMPOTENCY,
    findings.length === 0 ? ARCHIVE_IDENTITY_REMEDY : identityRemedyFor(findings),
  )

  console.log(
    `[archive-identities] ${observations
      .map((o) => `${o.identity}:${o.deleteProbe}`)
      .join(' ')} findings=${findings.length}`,
  )

  return { observations, findings, alerted: findings.length > 0 }
}
