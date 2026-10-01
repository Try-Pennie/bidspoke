import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Workflow files in a Pipedream export. Recursive, because workflows sit in
 * subfolders and a one level glob saw only 215 of the 346; manifests excluded;
 * the export's numbered duplicate project folder (`... (1)`) skipped, because
 * counting it doubles that project.
 */
export function exportFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry)
      if (statSync(full).isDirectory()) {
        if (/ \(\d+\)$/.test(entry)) continue
        walk(full)
      } else if (entry.endsWith('.json') && entry !== 'manifest.json') {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}
