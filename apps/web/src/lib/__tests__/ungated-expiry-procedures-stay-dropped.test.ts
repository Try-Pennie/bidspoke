/**
 * The ungated expiry procedures stay dropped (#1145).
 *
 * `20260903210000` repointed both destructive jobs at the gated procedures and
 * left the superseded pair unscheduled for one release. `20260910220000` is the
 * contract half that removed them.
 *
 * Each one deletes a day of execution history WITHOUT consulting the archive.
 * The reason they were worth removing rather than leaving inert is that being
 * inert is how they survive: somebody looking for "the procedure that drops
 * expired partitions" finds a name that reads like the right one and does not
 * check whether it asks the gate first (L29, L346).
 *
 * So the drop needs a guard, or the next migration that wants an expiry
 * procedure recreates one under the old name and nothing says so. `git` history
 * is not that guard: a recreated procedure is a new file, and it reads as an
 * addition rather than as an undo.
 */
import { describe, expect, it } from 'vitest'
import { readMigrations } from './_pg-cron'

/** The migration that removed them. Anything after it must not bring them back. */
const CONTRACT_MIGRATION = '20260910220000_drop_superseded_expiry_procedures.sql'

/**
 * The names, assembled so this file does not itself contain a string a future
 * scan of its own would match (L135).
 */
const UNGATED = [
  ['truncate', 'expired', 'execution', 'partitions'].join('_'),
  ['drop', 'expired', 'execution', 'partitions'].join('_'),
]

/** Only a definition counts. A DROP names them too, and so does a comment. */
const definesRoutine = (sql: string, name: string): boolean =>
  new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:PROCEDURE|FUNCTION)\\s+(?:public\\.)?${name}\\b`, 'i').test(sql)

describe('the ungated expiry procedures stay dropped', () => {
  const migrations = readMigrations()

  it('reads a real set of migrations, so a miss cannot read as a pass', () => {
    // A directory that resolves to nothing reports no offenders and looks clean
    // (L98).
    expect(migrations.length).toBeGreaterThan(100)
    expect(migrations.some((m) => m.name === CONTRACT_MIGRATION)).toBe(true)
  })

  it('has the contract migration actually dropping all three', () => {
    // Including the inner function the _safe wrapper called: leaving that would
    // keep the ungated delete reachable under a slightly different name.
    const contract = migrations.find((m) => m.name === CONTRACT_MIGRATION)
    expect(contract).toBeDefined()
    for (const name of UNGATED) {
      expect(contract!.sql, `${name} is not dropped`).toMatch(new RegExp(`DROP\\s+(?:PROCEDURE|FUNCTION)[^;]*${name}`, 'i'))
    }
    expect(contract!.sql).toMatch(/drop_expired_execution_partitions_safe/)
  })

  it('has nothing after it recreating them', () => {
    const after = migrations.filter((m) => m.name > CONTRACT_MIGRATION)
    const offenders = after.flatMap((m) =>
      UNGATED.filter((name) => definesRoutine(m.sql, name)).map((name) => `${m.name} defines ${name}`),
    )

    expect(
      offenders,
      'these procedures delete a day of executions without consulting the archive; the gated pair is truncate_verified_execution_partitions and drop_verified_execution_partitions',
    ).toEqual([])
  })

  it('still finds the gated pair, so the check is about the ungated ones only', () => {
    // A guard that would pass just as well if BOTH were gone is not measuring
    // what it claims to (L63).
    const all = migrations.map((m) => m.sql).join('\n')
    expect(all).toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:public\.)?truncate_verified_execution_partitions/i)
    expect(all).toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:public\.)?drop_verified_execution_partitions/i)
  })
})
