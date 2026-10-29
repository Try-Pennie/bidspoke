/**
 * The Supabase URL and service key the porting scripts read and write the
 * porting schema with (#1710, #2979). The reading itself is
 * inventoryCredentials (packages/porting-evidence/src/inventory/credentials.ts),
 * the one copy the scripts and the converter share; this only points it at
 * apps/worker/.dev.vars and turns a missing setting into a stop by name.
 * Nothing here prints a value.
 */
import path from 'node:path'
import { inventoryCredentials } from '../../packages/porting-evidence/src/inventory/index.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

export function credentials(): { url: string; key: string } {
  try {
    return inventoryCredentials(process.env, path.join(REPO_ROOT, 'apps', 'worker', '.dev.vars'))
  } catch (e) {
    fail(e instanceof Error ? e.message : 'reading the credentials failed')
  }
}
