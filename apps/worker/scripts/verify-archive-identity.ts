/**
 * Proves an archive Snowflake identity can actually authenticate (#871, Phase A3).
 *
 * Nothing can prove a key pair works until code opens a connection with it, so
 * this is the first thing that does. It runs the same code path the archiver
 * will use, so a pass here is evidence about the archiver and not about the
 * script (L3: wired is not proven).
 *
 * READ ONLY by default: one SELECT COUNT(*) against the archive table.
 *
 * With --check-delete it also attempts a DELETE whose predicate matches no row,
 * which MUST be refused for the writer and the reader. That is the role check
 * A2 deferred to this phase, performed through the Worker's own credential
 * rather than by a person switching roles by hand (#914). It is opt in because
 * it aims a write shaped statement at production, and it is safe only while
 * nothing depends on the table's contents.
 *
 * Run: npx tsx scripts/verify-archive-identity.ts [writer|reader|eraser] [--check-delete]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { executeStatement } from '../src/lib/snowflake'
import {
  ARCHIVE_DATABASE,
  ARCHIVE_SCHEMA,
  ARCHIVE_TABLE,
  ARCHIVE_ROLES,
  archiveConfig,
  verifyArchiveIdentity,
  type ArchiveIdentity,
} from '../src/lib/archive-snowflake'

const here = dirname(fileURLToPath(import.meta.url))

function devVar(name: string): string {
  const raw = readFileSync(resolve(here, '..', '.dev.vars'), 'utf8')
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    if (t.slice(0, eq).trim() !== name) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    return val
  }
  throw new Error(`${name} is not in apps/worker/.dev.vars`)
}

const IDENTITIES: ArchiveIdentity[] = ['writer', 'reader', 'eraser']
const arg = process.argv[2]
const identity: ArchiveIdentity = arg && IDENTITIES.includes(arg as ArchiveIdentity)
  ? (arg as ArchiveIdentity)
  : 'writer'
if (arg && !IDENTITIES.includes(arg as ArchiveIdentity) && !arg.startsWith('--')) {
  throw new Error(`unknown identity "${arg}", expected one of ${IDENTITIES.join(', ')}`)
}
const checkDelete = process.argv.includes('--check-delete')

// The private key is read from its own file rather than from .dev.vars, because
// a PEM is multi line and the .dev.vars parser is line based, so a key pasted
// there would arrive truncated and the failure would look like a bad key.
const keyFile = process.env.ARCHIVE_KEY_FILE
  ?? resolve(homedir(), '.bidspoke', 'archive-keys', `archive_${identity}.p8`)

const env = {
  SNOWFLAKE_ACCOUNT: devVar('SNOWFLAKE_ACCOUNT'),
  [`ARCHIVE_${identity.toUpperCase()}_USER`]: `bidspoke_archive_${identity}_svc`,
  [`ARCHIVE_${identity.toUpperCase()}_PRIVATE_KEY`]: readFileSync(keyFile, 'utf8'),
} as unknown as Parameters<typeof archiveConfig>[0]

console.log(`identity: ${identity}`)
console.log(`role:     ${ARCHIVE_ROLES[identity]}`)
console.log(`key file: ${keyFile}`)
console.log(`target:   ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`)

const result = await verifyArchiveIdentity(env, identity)
if (!result.ok) {
  console.log(`\nROUND TRIP FAILED: ${result.reason ?? 'no reason given'}`)
  process.exit(1)
}
console.log(`\nround trip OK, archive table holds ${result.rowCount} rows`)

if (checkDelete) {
  // A predicate no row can match, so the only thing this can measure is whether
  // the grant exists. A refusal is the PASS.
  const statement =
    `DELETE FROM ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE} ` +
    `WHERE execution_id = 'archive-identity-probe-matches-nothing'`
  let refused: string | null = null
  let accepted = false
  try {
    const response = await executeStatement(archiveConfig(env, identity), statement)
    accepted = true
    console.log(`\nDELETE was ACCEPTED. rows affected: ${JSON.stringify(response.data ?? [])}`)
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err)
  }

  const shouldHoldDelete = identity === 'eraser'
  if (shouldHoldDelete) {
    console.log(accepted ? '\nexpected: the eraser holds DELETE, and it does' : `\nUNEXPECTED: the eraser was refused DELETE: ${refused ?? ''}`)
    process.exit(accepted ? 0 : 1)
  }
  if (accepted) {
    console.log(`\nFAILED: ${identity} was allowed to run DELETE. It must not hold that grant.`)
    process.exit(1)
  }
  console.log(`\nDELETE refused, as required. Snowflake said: ${refused ?? ''}`)
}
