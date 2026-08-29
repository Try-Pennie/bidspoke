/**
 * Comparing the archive's Snowflake settings against what the repo declares
 * (#980).
 *
 * The never-delete-without-a-backup guarantee rests on settings that live in
 * Snowflake and are applied BY HAND: the archive table's Time Travel window, its
 * column set, and the account edition that permits a window above one day.
 * Nothing read any of them back. There is a daily check for the Worker's own
 * secrets and there was no equivalent for the Snowflake side.
 *
 * The evidence for why that is not good enough is in this milestone's own
 * history: ADR 0009 recorded the undo window as a MEASURED fact, it was wrong
 * for days because nobody had established the account edition, and it was caught
 * only because somebody happened to probe. A retention change, an account
 * downgrade or a dropped column would be equally silent, and the first sign
 * would be an erasure or a restore not behaving as documented, at the moment it
 * is being relied on (L502).
 *
 * It decides, it does not act.
 */

export interface ObservedSettings {
  /** Effective DATA_RETENTION_TIME_IN_DAYS on the archive table, or null if unreadable. */
  retentionDays: number | null
  /**
   * The windows the archive would fall back to if the table's own setting were
   * ever lost, keyed by the level they were read from. Null when unreadable.
   *
   * This is what replaced reading the parameter's LEVEL (#1050). The level
   * answered 'is the table inheriting this', and no least-privileged identity
   * can see it: reading an object's parameters effectively needs ownership, and
   * ownership of the archive table would let the read path drop it. The
   * surrounding windows answer the question the level was asked for, and every
   * one of them is readable with the privileges the reader already holds.
   */
  surroundingRetentionDays: { level: string; days: number | null }[]
  /** Columns the table actually has, or null if the read failed. */
  columns: string[] | null
  /** Why a reading is null, when it is. */
  unreadable: string[]
}

export interface DeclaredSettings {
  retentionDays: number
  /** Columns the writer names in its INSERT. Every one must exist or every send fails. */
  requiredColumns: string[]
  /**
   * Columns that legitimately exist without the writer setting them.
   *
   * Listed rather than tolerated as a class, so a column added by hand is
   * reported. Being told about a change nobody recorded is the whole point.
   */
  expectedExtraColumns: string[]
}

export interface SettingsDifference {
  code: string
  message: string
}

/** '1 day' / '30 days', so an alert does not say '1 days'. */
function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`
}

export function settingsDifferences(
  observed: ObservedSettings,
  declared: DeclaredSettings,
): SettingsDifference[] {
  const differences: SettingsDifference[] = []

  for (const reason of observed.unreadable) {
    // Its own condition, never folded into "settings are fine". A check that
    // could not read the setting has established nothing, and reporting nothing
    // is what makes an unverified guarantee look verified (L98, L11).
    differences.push({ code: 'unreadable', message: `a setting could not be read: ${reason}` })
  }

  if (observed.retentionDays !== null && observed.retentionDays !== declared.retentionDays) {
    differences.push({
      code: 'retention-changed',
      message:
        `the archive table's Time Travel window is ${days(observed.retentionDays)}, and this repo and ` +
        `ADR 0009 declare ${days(declared.retentionDays)}. Every statement about what an accidental ` +
        'deletion can be undone from is wrong until one of the two changes.',
    })
  }

  for (const surrounding of observed.surroundingRetentionDays) {
    // Only BELOW is a difference. A wider surrounding window takes nothing away:
    // the table still carries its own, and losing that setting would leave more
    // history rather than less, so reporting it would be a difference nobody can
    // act on.
    if (surrounding.days === null || surrounding.days >= declared.retentionDays) continue
    differences.push({
      code: 'surrounding-retention-below',
      message:
        `the ${surrounding.level}'s Time Travel window is ${days(surrounding.days)}, below the ` +
        `${days(declared.retentionDays)} the archive table carries. Nothing is wrong today, and the ` +
        "moment the table's own setting is lost the archive silently falls to that shorter window.",
    })
  }

  if (observed.columns !== null) {
    const have = new Set(observed.columns.map((c) => c.toLowerCase()))
    const missing = declared.requiredColumns.filter((c) => !have.has(c.toLowerCase()))
    if (missing.length > 0) {
      differences.push({
        code: 'columns-missing',
        message:
          `the archive table is missing ${missing.length} column(s) the writer names: ${missing.join(', ')}. ` +
          'Every send fails until this is resolved.',
      })
    }

    const known = new Set(
      [...declared.requiredColumns, ...declared.expectedExtraColumns].map((c) => c.toLowerCase()),
    )
    const extra = observed.columns.filter((c) => !known.has(c.toLowerCase()))
    if (extra.length > 0) {
      // Not a failure, and still reported. A column added by hand is a change
      // nobody recorded, which is the class of thing this check exists to find.
      differences.push({
        code: 'columns-added',
        message:
          `the archive table has ${extra.length} column(s) this repo does not declare: ${extra.join(', ')}. ` +
          'Nothing is broken, but the schema and the code no longer agree about what the table holds.',
      })
    }
  }

  return differences
}
