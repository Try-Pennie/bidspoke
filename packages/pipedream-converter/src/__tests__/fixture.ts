/**
 * The committed fixture export (#1695): one project, built from the real export's
 * SHAPE with invented content, since the repository is public and the real export
 * holds partner code. p_Fx1Lead carries one step of every kind (code, a code step
 * that does not parse, registry, private component, if/else with its deployment,
 * a disabled step kept only as text); p_Fx2Daily carries a registry trigger and an
 * unknown trigger; p_Fx3Never was never deployed.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { StoredRow } from '@bidspoke/porting-evidence/inventory'

export const EXPORT_DIR = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'export')
export const PROJECT = 'proj_Fx7Demo'
export const EXPORTED_AT = '2026-09-30T19:26:13Z'

/** The file's sha256, measured here from its bytes rather than taken from the code under test. */
export function fileSha(hashid: string): string {
  const file = path.join(EXPORT_DIR, `project_export-${PROJECT}`, `${hashid.toLowerCase()}-${hashid}.json`)
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The inventory row a load of this very export would have written. */
export function recordedRow(hashid: string, over: Partial<StoredRow> = {}): StoredRow {
  return {
    organization_id: '00000000-0000-4000-8000-000000000001',
    pipedream_hashid: hashid,
    project_hashid: PROJECT,
    name: hashid,
    pipedream_state: 'on',
    trigger_types: ['http'],
    step_count: 8,
    deployment_count: 1,
    first_seen_export_at: '2026-09-01T00:00:00Z',
    last_seen_export_at: EXPORTED_AT,
    absent_since_export_at: null,
    ...over,
    definition_sha256: 'definition_sha256' in over ? (over.definition_sha256 ?? null) : fileSha(hashid),
  }
}
