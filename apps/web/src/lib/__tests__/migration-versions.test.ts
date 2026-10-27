/**
 * Guard against duplicate migration version numbers (#336).
 *
 * Supabase migration files are named `<version>_<name>.sql` with a hand-typed
 * YYYYMMDDNNNNNN version that is the primary key in schema_migrations. Two files
 * sharing a version collide: `supabase db push` fails with a duplicate-key error
 * (and one migration can silently shadow the other). It happened 2026-06-23. This
 * test fails the build if any version prefix appears in more than one filename.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationVersion, findDuplicateMigrationVersions } from '../migration-versions'

describe('migrationVersion', () => {
  it('extracts the numeric version prefix', () => {
    expect(migrationVersion('20260623000001_gate_auth_provisioning.sql')).toBe('20260623000001')
    expect(migrationVersion('20240406000001_auth_user_trigger.sql')).toBe('20240406000001')
  })
  it('is null for a filename without a version prefix', () => {
    expect(migrationVersion('README.md')).toBeNull()
    expect(migrationVersion('seed.sql')).toBeNull()
  })
})

describe('findDuplicateMigrationVersions', () => {
  it('returns versions that appear in more than one file', () => {
    expect(
      findDuplicateMigrationVersions([
        '20260623000001_a.sql',
        '20260623000001_b.sql',
        '20260101000001_c.sql',
      ]),
    ).toEqual(['20260623000001'])
  })
  it('returns empty when every version is unique', () => {
    expect(
      findDuplicateMigrationVersions(['20260101000001_a.sql', '20260102000001_b.sql']),
    ).toEqual([])
  })
  it('ignores non-.sql files and unversioned names', () => {
    expect(findDuplicateMigrationVersions(['20260101000001_a.sql', 'notes.md', '.DS_Store'])).toEqual([])
  })
})

// Both projects record their migrations by version: the bidding project's
// supabase/migrations and the ops project's supabase-ops/supabase/migrations
// (#2876, after two branches both added an ops migration at 20261027150000).
const MIGRATION_DIRS = ['supabase/migrations', 'supabase-ops/supabase/migrations']

describe.each(MIGRATION_DIRS)('no duplicate migration versions in %s', (relDir) => {
  it('every migration file has a unique version prefix', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const migrationsDir = path.resolve(dir, '../../../../..', relDir)
    const files = readdirSync(migrationsDir)
    // A folder that moved or emptied would pass with no duplicates to find.
    expect(files.filter((f) => migrationVersion(f) !== null).length).toBeGreaterThan(0)
    const dups = findDuplicateMigrationVersions(files)
    expect(
      dups,
      `Duplicate migration version prefix(es) in ${relDir}: ${dups.join(', ')}. ` +
        `Each ${relDir} file must have a unique version, so renumber the newer one.`,
    ).toEqual([])
  })
})
