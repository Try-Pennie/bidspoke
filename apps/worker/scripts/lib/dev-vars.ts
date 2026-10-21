/**
 * Reads apps/worker/.dev.vars into a plain map, for the read-only operator
 * scripts in this directory. Extracted so a new script does not add a sixth
 * copy of the same parser (the five existing diagnose/measure scripts each
 * carry their own; they are left alone rather than churned).
 *
 * .dev.vars is gitignored and holds the production Supabase service key, so
 * nothing here prints a value: callers pass them straight to createClient.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** `path` names another .dev.vars, for a script run from a worktree that has none of its own. */
export function loadDevVars(path?: string): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(path ?? resolve(here, '..', '..', '.dev.vars'), 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[t.slice(0, eq).trim()] = val
  }
  return out
}
