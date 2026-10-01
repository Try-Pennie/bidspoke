/**
 * Exports what the money gate's fixtures are built from (#1704).
 *
 * Hand run against production. It writes three things under money-gate/fixtures:
 *   shapes.json           the SHAPE of recent real trigger payloads per live
 *                         workflow (field paths, value classes, formats, small
 *                         enumerated domains), never a value (money-gate/lib/shape.ts);
 *   config-snapshot.json  the config tables the engine reads, with real structure
 *                         and synthetic numbers, env var NAMES with placeholder
 *                         values (money-gate/lib/snapshot.ts);
 *   definitions/<id>.json each live workflow's definition, read from the
 *                         bidspoke-workflows backup and refused unless it equals
 *                         what production runs.
 *
 * It reads through a client whose insert, update, upsert, delete, rpc and schema
 * throw (money-gate/lib/read-only-client.ts), and prints names and counts only.
 * Its output guard is money-gate/lib/__tests__/export-script.test.ts, which must
 * pass before this is run.
 *
 * Run (from apps/worker, with SUPABASE_URL and SUPABASE_SECRET_KEY in the
 * environment or in .dev.vars):
 *   npx tsx scripts/export-money-fixture-shapes.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readOnlyClient } from '../money-gate/lib/read-only-client'
import { buildWorkflowShape, renderShapesFile, summarizeShapes, type ShapesFile, type WorkflowShape } from '../money-gate/lib/shape'
import {
  snapshotBuyerProfile,
  snapshotEnvVar,
  snapshotPartnerConfig,
  snapshotUuidMapRow,
  type ConfigSnapshot,
  type EnvVarRow,
} from '../money-gate/lib/snapshot'

/** How many recent payloads per workflow, and how far back. Under PostgREST's 1,000 row cap. */
export const SAMPLE_SIZE = 300
export const SAMPLE_DAYS = 2

export interface ExportDeps {
  client: Pick<SupabaseClient, 'from'>
  fetchBackupDefinition: (workflowId: string) => Promise<unknown>
  /** Path relative to apps/worker. */
  write: (relativePath: string, text: string) => void
  log: (line: string) => void
  now: () => Date
}

interface WorkflowRow {
  id: string
  name: string
  organization_id: string
  slack_channel: string | null
  definition: unknown
}

async function read<T>(label: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q
  if (error) throw new Error(`money gate export: reading ${label} failed: ${error.message}`)
  return (data ?? []) as T[]
}

/** Canonical JSON (sorted keys), so a backup and the live row compare by meaning, not key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * JSON text with every character outside ASCII written as a \u escape. Production
 * copy carries typographic dashes and the occasional emoji, which the repository's
 * style hook refuses in a new line; escaped, the file parses to exactly the same
 * values, so the definitions still equal what production runs.
 */
export function asciiOnly(json: string): string {
  return json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export async function runExport(deps: ExportDeps): Promise<void> {
  const { client, log } = deps
  const write = (path: string, text: string) => deps.write(path, asciiOnly(text))
  const now = deps.now()
  const since = new Date(now.getTime() - SAMPLE_DAYS * 86_400_000).toISOString()

  const workflows = await read<WorkflowRow>('workflows', client
    .from('workflows')
    .select('id, name, organization_id, slack_channel, definition')
    .eq('is_active', true)
    .is('deleted_at', null))

  const shapes: WorkflowShape[] = []
  const live: WorkflowRow[] = []
  for (const wf of [...workflows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const rows = await read<{ trigger_payload: unknown; source: string | null }>(`executions of ${wf.name}`, client
      .from('workflow_executions')
      .select('trigger_payload, source')
      .eq('workflow_id', wf.id)
      .eq('is_test', false)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(SAMPLE_SIZE))
    if (rows.length === 0) {
      log(`${wf.name}: no live runs in ${SAMPLE_DAYS} days, not exported`)
      continue
    }
    const shape = buildWorkflowShape({ workflow_id: wf.id, workflow_name: wf.name, payloads: rows.map((r) => r.trigger_payload) })
    // The source name is an API key's label (engine, lendswift), config rather than a
    // person, and it passes through the same domain rule as any payload field.
    const sourceShape = buildWorkflowShape({ workflow_id: wf.id, workflow_name: wf.name, payloads: rows.map((r) => ({ source: r.source })) })
    shape.sources = sourceShape.fields.source?.domain
    shapes.push(shape)
    live.push(wf)
  }

  for (const wf of live) {
    const backup = await deps.fetchBackupDefinition(wf.id)
    if (canonical(backup) !== canonical(wf.definition)) {
      throw new Error(`money gate export: the backup of ${wf.name} differs from what production runs; re-save it or wait for the backup, then rerun`)
    }
    write(`money-gate/fixtures/definitions/${wf.id}.json`, `${JSON.stringify({ id: wf.id, name: wf.name, definition: backup }, null, 2)}\n`)
  }

  const orgIds = [...new Set(live.map((w) => w.organization_id))]
  const tables: ConfigSnapshot['tables'] = {
    workflows: live.map((w) => ({ id: w.id, name: w.name, organization_id: w.organization_id, slack_channel: null, is_active: true, deleted_at: null })),
    workflow_versions: [],
    partner_configs: [],
    buyer_profiles: [],
    partner_uuid_map: [],
    environment_variables: [],
    buyer_pricing_tiers: [],
    buyer_operating_windows: [],
    buyer_blackout_dates: [],
  }
  for (const w of live) {
    const versions = await read<{ id: string; version_number: number }>(`versions of ${w.name}`, client
      .from('workflow_versions').select('id, version_number').eq('workflow_id', w.id).order('version_number', { ascending: false }).limit(1))
    tables.workflow_versions.push(...versions.map((v) => ({ id: v.id, workflow_id: w.id, version_number: v.version_number })))
  }
  for (const org of orgIds) {
    tables.partner_configs.push(...(await read<Record<string, unknown>>('partner_configs', client.from('partner_configs').select('*').eq('organization_id', org))).map(snapshotPartnerConfig))
    tables.buyer_profiles.push(...(await read<Record<string, unknown>>('buyer_profiles', client.from('buyer_profiles').select('*').eq('organization_id', org))).map(snapshotBuyerProfile))
    tables.partner_uuid_map.push(...(await read<Record<string, unknown>>('partner_uuid_map', client.from('partner_uuid_map').select('*').eq('org_id', org))).map(snapshotUuidMapRow))
    // Prices are synthesized like every other number; operating hours and blackout dates
    // are when a buyer takes leads, structure the fixtures' fixed clock is judged against.
    tables.buyer_pricing_tiers.push(...(await read<Record<string, unknown>>('buyer_pricing_tiers', client.from('buyer_pricing_tiers').select('*').eq('organization_id', org))).map(snapshotBuyerProfile))
    tables.buyer_operating_windows.push(...(await read<Record<string, unknown>>('buyer_operating_windows', client.from('buyer_operating_windows').select('*').eq('organization_id', org))))
    tables.buyer_blackout_dates.push(...(await read<Record<string, unknown>>('buyer_blackout_dates', client.from('buyer_blackout_dates').select('*').eq('organization_id', org))))
    tables.environment_variables.push(...(await read<EnvVarRow>('environment_variables', client
      .from('environment_variables').select('key, value, is_secret, scope, organization_id, workflow_id').eq('organization_id', org))).map((r) => snapshotEnvVar(r) as unknown as Record<string, unknown>))
  }
  for (const rows of Object.values(tables)) rows.sort((a, b) => canonical(a) < canonical(b) ? -1 : 1)

  const exportedAt = now.toISOString()
  const shapesFile: ShapesFile = { version: 1, exported_at: exportedAt, workflows: shapes }
  const snapshot: ConfigSnapshot = { version: 1, exported_at: exportedAt, tables }
  write('money-gate/fixtures/shapes.json', renderShapesFile(shapesFile))
  write('money-gate/fixtures/config-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`)

  log(summarizeShapes(shapesFile))
  log(`config snapshot: ${Object.entries(tables).map(([t, r]) => `${t} ${r.length}`).join(', ')}`)
}

export function makeExportClient(url: string, key: string): Pick<SupabaseClient, 'from'> {
  return readOnlyClient(createClient(url, key, { auth: { persistSession: false } }))
}

function fetchBackupDefinitionWithGh(workflowId: string): Promise<unknown> {
  const b64 = execFileSync('gh', ['api', `repos/Try-Pennie/bidspoke-workflows/contents/workflows/${workflowId}.json`, '--jq', '.content'], { encoding: 'utf8' })
  const doc = JSON.parse(Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8')) as { definition?: unknown }
  return Promise.resolve(doc.definition ?? doc)
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const workerRoot = resolve(here, '..')
  let url = process.env.SUPABASE_URL
  let key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    const { loadDevVars } = await import('./lib/dev-vars')
    const vars = loadDevVars()
    url = vars.SUPABASE_URL
    key = vars.SUPABASE_SECRET_KEY
  }
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required')
  await runExport({
    client: makeExportClient(url, key),
    fetchBackupDefinition: fetchBackupDefinitionWithGh,
    write: (rel, text) => {
      const abs = resolve(workerRoot, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    },
    log: (line) => console.log(line),
    now: () => new Date(),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : 'export failed')
    process.exit(1)
  })
}
