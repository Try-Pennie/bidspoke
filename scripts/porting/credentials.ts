/**
 * The Supabase URL and service key the porting scripts read and write the
 * porting schema with (#1710, #2979): SUPABASE_URL and SUPABASE_SECRET_KEY from
 * the environment, else from apps/worker/.dev.vars. One home for every script,
 * so they cannot disagree about where the key comes from. Nothing here prints a
 * value; a missing one stops the script by name.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

export function credentials(): { url: string; key: string } {
  let url = process.env.SUPABASE_URL
  let key = process.env.SUPABASE_SECRET_KEY
  const devVars = path.join(REPO_ROOT, 'apps', 'worker', '.dev.vars')
  if ((!url || !key) && existsSync(devVars)) {
    for (const line of readFileSync(devVars, 'utf8').split('\n')) {
      const m = /^\s*(SUPABASE_URL|SUPABASE_SECRET_KEY)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      const value = m[2].replace(/^(["'])(.*)\1$/, '$2')
      if (m[1] === 'SUPABASE_URL') url ??= value
      else key ??= value
    }
  }
  if (!url || !key) fail('SUPABASE_URL and SUPABASE_SECRET_KEY are required, in the environment or in apps/worker/.dev.vars')
  return { url: url.replace(/\/$/, ''), key }
}
