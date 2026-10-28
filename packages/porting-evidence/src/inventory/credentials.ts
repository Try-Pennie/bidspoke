/**
 * The Data API address and service key the porting command line tools read the
 * inventory with (#1710, #1695): SUPABASE_URL and SUPABASE_SECRET_KEY from the
 * environment, else from apps/worker/.dev.vars. One copy for every tool, so the
 * loader and the converter cannot come to read different settings. Nothing here
 * prints a value, and the error names only the settings.
 */
import { existsSync, readFileSync } from 'node:fs'

export interface InventoryCredentials {
  url: string
  key: string
}

export function inventoryCredentials(env: Record<string, string | undefined>, devVarsPath: string): InventoryCredentials {
  let url = env.SUPABASE_URL
  let key = env.SUPABASE_SECRET_KEY
  if ((!url || !key) && existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
      const m = /^\s*(SUPABASE_URL|SUPABASE_SECRET_KEY)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      const value = m[2].replace(/^(["'])(.*)\1$/, '$2')
      if (m[1] === 'SUPABASE_URL') url ||= value
      else key ||= value
    }
  }
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required, in the environment or in apps/worker/.dev.vars')
  return { url: url.replace(/\/$/, ''), key }
}
