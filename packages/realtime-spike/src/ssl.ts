/**
 * TLS for the spike's one database connection (#2131). A hosted database is
 * verified against Supabase's root CA and its own host name, because the
 * connection logs in with a temporary password and runs as postgres.
 *
 * certs/supabase-root-2021-ca.crt is Supabase's public "Supabase Root 2021 CA"
 * (the dashboard's SSL certificate download; sha256 80:70:25:AD:...:72:E6:CA:FA),
 * against which db.xvrmivmpfykwwtriqwpg.supabase.co verified with openssl on
 * 2026-10-15. PGSSLROOTCERT names another CA file instead.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const BUNDLED_CA = path.resolve(import.meta.dirname, '..', 'certs', 'supabase-root-2021-ca.crt')
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

export type SslOptions = false | { ca: string; rejectUnauthorized: true; servername: string }

export function sslFor(env: NodeJS.ProcessEnv, readCa: (file: string) => string = (file) => readFileSync(file, 'utf8')): SslOptions {
  const host = env.PGHOST ?? ''
  if (LOCAL_HOSTS.has(host)) return false
  return { ca: readCa(env.PGSSLROOTCERT || BUNDLED_CA), rejectUnauthorized: true, servername: host }
}
