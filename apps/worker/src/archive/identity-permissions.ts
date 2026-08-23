/**
 * Judging what each archive identity can actually do (#914).
 *
 * Phase A2 created three Snowflake identities split by what each may DESTROY:
 * the writer and reader hold no DELETE, and the eraser is the only one that
 * does. The three roles and users exist and were confirmed on the live account.
 * What was never checked is the GRANTS. The least-privilege claim rested on the
 * statements written in a SQL file, not on anything read back.
 *
 * THE GAP IS ASYMMETRIC, which is why it would never surface on its own. A
 * MISSING grant fails loudly the first time the archiver runs. An EXCESSIVE
 * grant never surfaces at all, because the archiver never attempts the thing it
 * should not be permitted to do (L503). If the writer held DELETE on
 * `execution_archive`, nothing in the system would discover it, and the control
 * protecting 13 months of unredacted identity data would be a sentence in a SQL
 * file.
 *
 * So this judges two kinds of evidence, and the second is the one that matters:
 *
 * 1. What `SHOW GRANTS` says the role holds. A description.
 * 2. What happened when the identity actually ATTEMPTED a delete. A refusal
 *    observed, not a refusal described (L1, L3).
 *
 * It decides, it does not act.
 */

export type IdentityName = 'writer' | 'reader' | 'eraser'

/** Whether an identity is supposed to be able to destroy archived rows. */
export const MAY_DELETE: Record<IdentityName, boolean> = {
  writer: false,
  reader: false,
  eraser: true,
}

export interface IdentityObservation {
  identity: IdentityName
  /** Privileges SHOW GRANTS reported on the archive table, upper-cased. */
  tablePrivileges: string[] | null
  /** What CURRENT_SECONDARY_ROLES() returned in that identity's own session. */
  secondaryRoles: string | null
  /**
   * What happened when the identity ran a constant-false DELETE.
   *
   * 'allowed' means the statement RAN, which for the writer and reader is the
   * failure this whole check exists to find. 'refused' means Snowflake rejected
   * it with a code that means insufficient privileges, which is the control
   * working.
   *
   * 'ambiguous' is Snowflake's own doing: code 002003 means "does not exist OR
   * not authorized", so on its own it cannot tell a refusal from a table that is
   * not there. It is resolved below using the OTHER identities in the same run.
   */
  deleteProbe: 'allowed' | 'refused' | 'ambiguous' | 'unknown'
  /** Why any of the above is null or unknown. */
  unreadable: string[]
}

export interface IdentityFinding {
  code: string
  identity: IdentityName
  message: string
}

export function identityFindings(observations: IdentityObservation[]): IdentityFinding[] {
  const findings: IdentityFinding[] = []

  /**
   * Whether anything in this run reached the table at all.
   *
   * Snowflake's 002003 means "does not exist OR not authorized", so a single
   * identity's ambiguous answer proves nothing. But if ANOTHER identity deleted
   * successfully in the same run, the table demonstrably exists and is
   * reachable, and the ambiguous answer can only be the authorization half. That
   * is a real inference from evidence collected here, not an assumption, and
   * without it the whole check reports "unreadable" on the commonest way
   * Snowflake refuses a reader.
   */
  const tableProvenReachable = observations.some((o) => o.deleteProbe === 'allowed')

  for (const raw of observations) {
    const o: IdentityObservation =
      raw.deleteProbe === 'ambiguous' && tableProvenReachable
        ? { ...raw, deleteProbe: 'refused' }
        : raw
    if (raw.deleteProbe === 'ambiguous' && !tableProvenReachable) {
      findings.push({
        code: 'unreadable',
        identity: raw.identity,
        message:
          `the ${raw.identity} identity's delete was rejected as "does not exist or not authorized", and no ` +
          'other identity reached the table in this run, so whether it was refused or the table is missing ' +
          'cannot be told apart',
      })
    }
    const mayDelete = MAY_DELETE[o.identity]

    for (const reason of o.unreadable) {
      // Its own finding. A permission model that could not be read has not been
      // verified, and reporting nothing would make an unchecked control look
      // checked, which is precisely the state this replaces (L98).
      findings.push({
        code: 'unreadable',
        identity: o.identity,
        message: `the ${o.identity} identity could not be verified: ${reason}`,
      })
    }

    // THE OBSERVED REFUSAL. Judged before the grant listing, because it is the
    // stronger evidence: a grant listing is a description of what should
    // happen, and this is what did.
    if (o.deleteProbe === 'allowed' && !mayDelete) {
      findings.push({
        code: 'delete-allowed',
        identity: o.identity,
        message:
          `the ${o.identity} identity was ALLOWED to run a delete against the archive. It is supposed to hold ` +
          'no DELETE at all, so the split that keeps 13 months of unredacted identity data safe from a bug or a ' +
          'leaked credential on the ingest path is not in force.',
      })
    }
    if (o.deleteProbe === 'refused' && mayDelete) {
      // The positive control. Without it, every assertion above is satisfied by
      // an account where NOBODY can delete, and the erasure hook and the expiry
      // job would both fail the first time they were needed, months from now
      // (L159).
      findings.push({
        code: 'delete-refused',
        identity: o.identity,
        message:
          `the ${o.identity} identity was REFUSED a delete against the archive. It is the only identity that ` +
          'can carry out an erasure request or the expiry job, so neither can run.',
      })
    }

    if (o.tablePrivileges !== null) {
      const has = new Set(o.tablePrivileges.map((p) => p.toUpperCase()))
      if (has.has('DELETE') !== mayDelete) {
        findings.push({
          code: mayDelete ? 'grant-missing' : 'grant-excessive',
          identity: o.identity,
          message: mayDelete
            ? `the ${o.identity} role is not granted DELETE on the archive table, so an erasure cannot be carried out`
            : `the ${o.identity} role is granted DELETE on the archive table, which it must never hold`,
        })
      }
      // OWNERSHIP is DELETE by another name, and a grant listing that shows no
      // DELETE while showing OWNERSHIP would read as least privilege.
      if (has.has('OWNERSHIP') && !mayDelete) {
        findings.push({
          code: 'grant-ownership',
          identity: o.identity,
          message:
            `the ${o.identity} role OWNS the archive table, which carries every privilege including DELETE ` +
            'however the individual grants read',
        })
      }
    }

    if (o.secondaryRoles !== null && !isNoSecondaryRoles(o.secondaryRoles)) {
      // What makes the split structural rather than circumstantial. Two of the
      // three were found loose when this was first checked by hand: with
      // secondary roles active, an identity holds whatever any of them holds and
      // the primary role's grants stop describing what it can do.
      findings.push({
        code: 'secondary-roles',
        identity: o.identity,
        message:
          `the ${o.identity} identity has secondary roles active (${o.secondaryRoles}), so what it can do is no ` +
          'longer described by its own role and the least-privilege split is circumstantial rather than structural',
      })
    }
  }

  return findings
}

/**
 * Snowflake reports "no roles active" in more than one spelling depending on
 * version and how the session was opened, and an empty string is the commonest.
 * Anything else is treated as roles being active, which is the fail-safe
 * direction: over-reporting a permission concern costs a look, under-reporting
 * it costs the control.
 */
function isNoSecondaryRoles(value: string): boolean {
  const normalised = value.trim().toUpperCase()
  if (normalised === '' || normalised === 'NULL' || normalised === '[]' || normalised === 'NONE') return true

  // The spelling the live account actually uses is a JSON object, measured on
  // 2026-08-23 as {"roles":"","value":""} for all three identities. It is PARSED
  // rather than pattern matched, because a substring test for an empty roles list
  // would also be satisfied by a populated one that happens to contain the same
  // characters, and this is the field that decides whether the least-privilege
  // split means anything.
  //
  // Anything that does not parse into that shape stays a concern. That is the
  // fail-safe direction: over-reporting costs a look, under-reporting costs the
  // control (L11).
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const roles = (parsed as { roles?: unknown }).roles
    return typeof roles === 'string' && roles.trim() === ''
  } catch {
    return false
  }
}
