/**
 * Remove what a spike ledger names (#2131, L515), dependants first: the users
 * row, the auth user, the organization, then the allowlist row.
 *
 * A planned entry is removed too, because an interrupt can land after a create
 * reached the server and before its id was written down; a user whose id was
 * never recorded is found by email. Nothing here throws: every entry ends up in
 * removed, absent (asked to remove, nothing was there) or failed, with the reason,
 * and the caller prints all three.
 */
import { keyCarriesMarker, type EntryKind, type Ledger, type LedgerEntry } from './ledger.ts'

export interface CleanupOps {
  /** The users row the signup trigger made has the auth user's id. */
  findUserIdByEmail(email: string): Promise<string | null>
  // Each delete by id also names the marker bearing key, and touches only a
  // row carrying it, so a ledger id pointing at a real row removes nothing.
  deletePublicUser(id: string, email: string): Promise<number>
  deleteAuthUser(id: string, email: string): Promise<'removed' | 'absent'>
  deleteOrganization(id: string, slug: string): Promise<number>
  deleteAllowlist(email: string): Promise<number>
}

export interface CleanupReport {
  removed: string[]
  absent: string[]
  failed: string[]
}

const ORDER: EntryKind[] = ['public_user', 'auth_user', 'organization', 'allowlist']

function describe(entry: LedgerEntry, id: string | null = entry.id): string {
  return id && entry.kind === 'organization' ? `${entry.kind} ${entry.key} (${id})` : `${entry.kind} ${entry.key}`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err)
}

export async function cleanupLedger(ledger: Ledger, ops: CleanupOps): Promise<CleanupReport> {
  const report: CleanupReport = { removed: [], absent: [], failed: [] }
  const entries = [...ledger.entries]

  for (const entry of entries) {
    if (!keyCarriesMarker(entry.key, ledger.marker)) {
      report.failed.push(`${describe(entry)}: refused, the key does not carry the marker ${ledger.marker}`)
    }
  }
  const safe = entries.filter((e) => keyCarriesMarker(e.key, ledger.marker))

  // A user entry with no id: resolve it once, by email, before anything is deleted.
  let resolvedUserId: string | null | undefined
  const userId = async (entry: LedgerEntry): Promise<string | null> => {
    if (entry.id) return entry.id
    if (resolvedUserId === undefined) resolvedUserId = await ops.findUserIdByEmail(entry.key)
    return resolvedUserId
  }

  // The signup trigger makes the users row in the same transaction as the auth
  // user, so a ledger that names an auth user but no users row (an interrupt
  // before the second entry was planned) still has one to remove.
  const authUser = safe.find((e) => e.kind === 'auth_user')
  if (authUser && !safe.some((e) => e.kind === 'public_user')) {
    safe.push({ kind: 'public_user', key: authUser.key, id: authUser.id, state: 'planned' })
  }

  for (const kind of ORDER) {
    for (const entry of safe.filter((e) => e.kind === kind)) {
      try {
        if (kind === 'public_user' || kind === 'auth_user') {
          const id = await userId(entry)
          if (!id) {
            report.absent.push(describe(entry))
            continue
          }
          if (kind === 'public_user') {
            const n = await ops.deletePublicUser(id, entry.key)
            ;(n > 0 ? report.removed : report.absent).push(describe(entry))
          } else {
            const outcome = await ops.deleteAuthUser(id, entry.key)
            ;(outcome === 'removed' ? report.removed : report.absent).push(describe(entry))
          }
        } else if (kind === 'organization') {
          if (!entry.id) {
            report.failed.push(`${describe(entry)}: the ledger holds no id for it`)
            continue
          }
          const n = await ops.deleteOrganization(entry.id, entry.key)
          ;(n > 0 ? report.removed : report.absent).push(describe(entry))
        } else {
          const n = await ops.deleteAllowlist(entry.key)
          ;(n > 0 ? report.removed : report.absent).push(describe(entry))
        }
      } catch (err) {
        report.failed.push(`${describe(entry)}: ${message(err)}`)
      }
    }
  }
  return report
}

export function formatCleanupReport(report: CleanupReport): string[] {
  return [
    ...report.removed.map((r) => `removed: ${r}`),
    ...report.absent.map((r) => `nothing to remove: ${r}`),
    ...report.failed.map((r) => `could not remove: ${r}`),
    report.failed.length === 0 ? 'cleanup complete' : `cleanup INCOMPLETE: ${report.failed.length} could not be removed`,
  ]
}
