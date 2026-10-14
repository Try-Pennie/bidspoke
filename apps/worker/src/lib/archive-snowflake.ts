/**
 * Snowflake client configuration for the execution archive (#871, Phase A3).
 *
 * The destination is NOT configuration. The database, schema, warehouse and the
 * three role names are fixed strings created by docs/snowflake-archive-setup.sql,
 * so they live here as constants rather than as six more Worker secrets. A secret
 * that can only ever hold one value is a value with an extra way to be wrong, and
 * it would need adding to the required-secrets check, the recovery inventory and
 * the sandbox policy for no benefit.
 *
 * What IS per identity is the two secrets that cannot be constants: the service
 * user's name and the private half of its key pair.
 */
import { executeStatement, type SnowflakeConfig, type SnowflakeStatementResponse } from './snowflake'
import type { Env } from '../index'

export const ARCHIVE_DATABASE = 'BIDSPOKE_ARCHIVE'
export const ARCHIVE_SCHEMA = 'EXECUTIONS'
export const ARCHIVE_WAREHOUSE = 'ARCHIVE_WH'
export const ARCHIVE_TABLE = 'EXECUTION_ARCHIVE'

/**
 * The archive table's Time Travel window, in days.
 *
 * DECLARED HERE so there is one number the ADR, the setup script and the daily
 * read-back (#980) all mean. It is the whole content of the undo story: a
 * Snowflake DELETE leaves the prior row readable through AT/BEFORE for this many
 * days, and then in Fail-safe for seven more that nobody can query or purge.
 *
 * Set by hand in docs/snowflake-archive-setup.sql, which is exactly why it is
 * read back on a schedule: it was recorded in ADR 0009 as a measured fact, was
 * wrong for days because nobody had established the account edition, and was
 * caught only because somebody happened to probe (#909, #911).
 */
export const ARCHIVE_UNDO_WINDOW_DAYS = 30

/**
 * Split by what each identity may DESTROY. The writer and reader hold no DELETE,
 * so a bug or a leaked credential on the hourly ingest or the read path cannot
 * remove archived rows.
 */
export const ARCHIVE_ROLES = {
  writer: 'bidspoke_archive_writer',
  reader: 'bidspoke_archive_reader',
  eraser: 'bidspoke_archive_eraser',
} as const

export type ArchiveIdentity = keyof typeof ARCHIVE_ROLES

export const ARCHIVE_IDENTITIES = Object.keys(ARCHIVE_ROLES) as ArchiveIdentity[]

/** Flags the verification script understands, so a mistyped one is not read as an identity. */
const KNOWN_FLAGS = ['--check-delete']

/**
 * Which identity a run was asked about. A misspelling REFUSES rather than
 * falling back to the writer: a fallback would verify an identity nobody asked
 * about and print a pass, so someone checking the eraser would be reassured
 * about the eraser on the strength of the writer (L75).
 */
export function resolveIdentity(args: string[]): ArchiveIdentity {
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.includes(arg)) {
        throw new Error(`unknown flag "${arg}", expected one of ${KNOWN_FLAGS.join(', ')}`)
      }
      continue
    }
    if (!ARCHIVE_IDENTITIES.includes(arg as ArchiveIdentity)) {
      throw new Error(`unknown identity "${arg}", expected one of ${ARCHIVE_IDENTITIES.join(', ')}`)
    }
    return arg as ArchiveIdentity
  }
  return 'writer'
}

/**
 * The two secrets per identity, EXPORTED so the daily missing-secret guard can
 * derive its list from this map rather than repeat it by hand (L41). A fourth
 * identity added here is covered by that guard without anyone remembering to.
 */
export const ARCHIVE_SECRET_NAMES: Record<ArchiveIdentity, { user: keyof Env; privateKey: keyof Env }> = {
  writer: { user: 'ARCHIVE_WRITER_USER', privateKey: 'ARCHIVE_WRITER_PRIVATE_KEY' },
  reader: { user: 'ARCHIVE_READER_USER', privateKey: 'ARCHIVE_READER_PRIVATE_KEY' },
  eraser: { user: 'ARCHIVE_ERASER_USER', privateKey: 'ARCHIVE_ERASER_PRIVATE_KEY' },
}

/**
 * An unset Worker secret can arrive as an empty string rather than as absent, so
 * both are the same refusal here (L138). The message names the one secret that is
 * missing: "the archive credentials are not set" cannot tell someone which of the
 * two they failed to set (L11).
 */
function requireSecret(env: Env, name: keyof Env): string {
  const value = env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${String(name)} is not set, so the archive cannot authenticate to Snowflake`)
  }
  return value
}

/**
 * The secret a failure says is unset, read back from the wording above, or
 * null. Beside the message it parses, so the alerts that name the secret
 * (identities, archived reads) cannot drift from it separately (#835).
 */
export function unsetSecretNamed(text: string): string | null {
  return /\b([A-Z][A-Z0-9_]+) is not set\b/.exec(text)?.[1] ?? null
}

export function archiveConfig(env: Env, identity: ArchiveIdentity): SnowflakeConfig {
  const names = ARCHIVE_SECRET_NAMES[identity]
  return {
    account: requireSecret(env, 'SNOWFLAKE_ACCOUNT'),
    user: requireSecret(env, names.user),
    privateKeyPem: requireSecret(env, names.privateKey),
    database: ARCHIVE_DATABASE,
    schema: ARCHIVE_SCHEMA,
    warehouse: ARCHIVE_WAREHOUSE,
    role: ARCHIVE_ROLES[identity],
  }
}

export interface VerifyResult {
  ok: boolean
  identity: ArchiveIdentity
  role: string
  /** Present only when a count was genuinely read back. */
  rowCount?: number
  /** Present only when the round trip failed, saying which way it failed. */
  reason?: string
}

export interface ArchiveExecutor {
  execute: (config: SnowflakeConfig, statement: string) => Promise<SnowflakeStatementResponse>
}

/**
 * A trivial authenticated round trip against the archive table. It proves four
 * things at once that a later batch failure would conflate: the key authenticates,
 * the role is granted, the warehouse can resume, and the table is reachable.
 *
 * Success is judged by a count actually parsed out of the response, never by the
 * response mentioning the table: an error message quotes the thing it failed on,
 * so a substring check for the table name is satisfied by the failure about that
 * table (L156).
 */
export async function verifyArchiveIdentity(
  env: Env,
  identity: ArchiveIdentity,
  deps: ArchiveExecutor = { execute: executeStatement },
): Promise<VerifyResult> {
  const config = archiveConfig(env, identity)
  const base: Pick<VerifyResult, 'identity' | 'role'> = { identity, role: config.role }

  const response = await deps.execute(
    config,
    `SELECT COUNT(*) FROM ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`,
  )

  const cell = response.data?.[0]?.[0]
  const count = typeof cell === 'string' || typeof cell === 'number' ? Number(cell) : NaN

  if (!Number.isFinite(count)) {
    const said = response.message ?? 'the response carried no count and no message'
    return { ...base, ok: false, reason: `no count came back from the archive table: ${said}` }
  }

  return { ...base, ok: true, rowCount: count }
}
