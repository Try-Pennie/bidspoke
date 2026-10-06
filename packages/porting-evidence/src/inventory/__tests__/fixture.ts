/**
 * Hand written Pipedream exports for the inventory tests (#1710). The real export
 * holds partner code and is never committed, so these carry only the shapes the
 * reader and the classifier look at: a manifest per project, workflow files with
 * triggers, steps, deployments and settings.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface FixtureWorkflow {
  hashid: string
  name?: string
  status?: 'exported' | 'skipped_never_deployed'
  /** The workflow file's body; omitted for a never deployed workflow, which has none. */
  file?: Record<string, unknown>
}

export interface FixtureProject {
  projectHashid: string
  exportedAt?: string
  truncated?: boolean
  workflows: FixtureWorkflow[]
}

/** A minimal switched on HTTP workflow file. */
export function workflowFile(hashid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'workflow.json/2026.01',
    id: hashid,
    name: `Workflow ${hashid}`,
    triggers: [{ type: 'http', runtime: 'nodejs20.x', props: {} }],
    steps: [],
    settings: {},
    ...extra,
  }
}

export const codeStep = (namespace: string, code: string) => ({ namespace, type: 'CodeCell', lang: 'nodejs20.x', component: 'True', uses: { registry: false, code } })
export const registryStep = (namespace: string, key: string, props: Record<string, unknown> = {}) => ({ namespace, type: 'CodeCell', lang: 'nodejs20.x', component: 'True', component_key: key, uses: { key, version: '1.0.0', registry: true }, props })

/** Writes the projects as an export directory and returns its path. */
export function writeExport(projects: FixtureProject[], into?: string): string {
  const root = into ?? mkdtempSync(path.join(tmpdir(), 'pipedream-export-'))
  for (const p of projects) {
    const dir = path.join(root, `project_export-${p.projectHashid}`)
    mkdirSync(dir, { recursive: true })
    const workflows = p.workflows.map((w) => {
      const status = w.status ?? 'exported'
      const entry: Record<string, unknown> = { hashid: w.hashid, name: w.name ?? `Workflow ${w.hashid}`, status }
      if (status === 'exported') {
        const file = `${w.hashid.toLowerCase()}-${w.hashid}.json`
        entry.path = file
        entry.warnings = []
        writeFileSync(path.join(dir, file), JSON.stringify(w.file ?? workflowFile(w.hashid)))
      }
      return entry
    })
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schema: 'project-export/2026.01',
      workflow_schema: 'workflow.json/2026.01',
      project_hashid: p.projectHashid,
      exported_at: p.exportedAt ?? '2026-09-30T19:26:13Z',
      truncated: p.truncated ?? false,
      truncated_reason: null,
      limits: { workflows: 500, bytes: 268435456 },
      workflows,
    }))
  }
  return root
}
