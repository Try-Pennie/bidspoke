// Helpers for the duplicate-migration-version guard (#336). Supabase migration
// files are named `<version>_<name>.sql`; the version is a hand-typed
// YYYYMMDDNNNNNN timestamp that is the primary key in schema_migrations, so two
// files sharing a version collide at `supabase db push`.

/** The numeric version prefix of a migration filename, or null if it has none. */
export function migrationVersion(filename: string): string | null {
  const m = /^(\d{8,})_/.exec(filename)
  return m ? m[1] : null
}

/** Versions that appear in more than one `.sql` migration filename, sorted. */
export function findDuplicateMigrationVersions(filenames: string[]): string[] {
  const counts = new Map<string, number>()
  for (const f of filenames) {
    if (!f.endsWith('.sql')) continue
    const version = migrationVersion(f)
    if (!version) continue
    counts.set(version, (counts.get(version) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([version]) => version)
    .sort()
}
