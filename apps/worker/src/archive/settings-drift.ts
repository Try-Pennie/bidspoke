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
   * Where that parameter is set. 'TABLE' means the table owns it; anything else
   * means it is inherited, so a change to the schema or account default silently
   * moves it.
   */
  retentionLevel: string | null
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
        `the archive table's Time Travel window is ${observed.retentionDays} days, and this repo and ` +
        `ADR 0009 declare ${declared.retentionDays}. Every statement about what an accidental deletion ` +
        'can be undone from is wrong until one of the two changes.',
    })
  }

  if (observed.retentionLevel !== null && observed.retentionLevel !== 'TABLE') {
    // Caught BEFORE the value moves. Inherited, the window changes whenever
    // somebody edits the schema or account default, with nothing naming the
    // archive at the moment of the change.
    differences.push({
      code: 'retention-inherited',
      message:
        `the archive table's Time Travel window is set at level ${observed.retentionLevel}, not TABLE, ` +
        'so it is inherited and will move silently the next time the schema or account default changes',
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
