/**
 * Reads a Pipedream export directory into its projects and workflows (#1710).
 *
 * Pipedream exports one project at a time; each export is a folder holding a
 * `manifest.json` and the workflow files it names. A directory may hold any number
 * of them, nested at any depth (the 2026-09-30 export has its first project's
 * manifest at the root and the rest in subfolders). A folder ending in ` (1)`, the
 * copy a repeated download leaves, is skipped, as the instrumenter does.
 *
 * The manifest is the record of what the project holds: it lists never deployed
 * workflows, which have no file, and only it can say a workflow is gone. So
 * everything it cannot vouch for is refused by name rather than guessed:
 * - a truncated manifest (an absent workflow then means nothing);
 * - the same project twice, or one workflow listed by two projects (L521);
 * - a listed file that is missing, or whose id is another workflow's;
 * - a status other than the two known ones;
 * - a workflow file no manifest lists;
 * - a directory with no manifest at all, which would read as an empty account.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { PipedreamWorkflow } from '../instrument/instrument.ts'

export type ExportStatus = 'exported' | 'skipped_never_deployed'

export interface ExportedWorkflow {
  hashid: string
  name: string
  projectHashid: string
  status: ExportStatus
  /** The parsed workflow file; null for a never deployed workflow. */
  workflow: PipedreamWorkflow | null
  /** SHA-256 of the file's bytes, the snapshot a port is built from; null without a file. */
  sha256: string | null
  /** The file, relative to the export directory; null without one. */
  file: string | null
}

export interface ExportedProject {
  projectHashid: string
  exportedAt: string
  workflows: ExportedWorkflow[]
}

interface ManifestEntry { hashid?: unknown; name?: unknown; status?: unknown; path?: unknown }
interface Manifest { project_hashid?: unknown; exported_at?: unknown; truncated?: unknown; workflows?: unknown }

const STATUSES: readonly string[] = ['exported', 'skipped_never_deployed']

function walk(dir: string, manifests: string[], files: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (/ \(\d+\)$/.test(entry)) continue
      walk(full, manifests, files)
    } else if (entry === 'manifest.json') {
      manifests.push(full)
    } else if (entry.endsWith('.json')) {
      files.push(full)
    }
  }
}

const text = (v: unknown, what: string, where: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: ${what} is missing or not text`)
  return v
}

export function readExport(dir: string): ExportedProject[] {
  const root = path.resolve(dir)
  const manifests: string[] = []
  const files: string[] = []
  walk(root, manifests, files)
  if (manifests.length === 0) throw new Error(`${root}: no manifest.json found, so this is not a Pipedream export`)

  const projects: ExportedProject[] = []
  const projectAt = new Map<string, string>()
  const workflowProject = new Map<string, string>()
  const claimed = new Set<string>()

  for (const manifestPath of manifests) {
    const where = path.relative(root, manifestPath) || 'manifest.json'
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const projectHashid = text(m.project_hashid, 'project_hashid', where)
    const exportedAt = text(m.exported_at, 'exported_at', where)
    if (Number.isNaN(Date.parse(exportedAt))) throw new Error(`${where}: exported_at ${exportedAt} is not a time`)
    if (m.truncated !== false) throw new Error(`${where}: project ${projectHashid} is truncated (or does not say it is not), so a workflow missing from it cannot be read as gone`)
    const seenAt = projectAt.get(projectHashid)
    if (seenAt !== undefined) throw new Error(`project ${projectHashid} is exported twice, in ${seenAt} and ${where}; keep one`)
    projectAt.set(projectHashid, where)
    if (!Array.isArray(m.workflows)) throw new Error(`${where}: workflows is not a list`)

    const workflows: ExportedWorkflow[] = []
    for (const raw of m.workflows as ManifestEntry[]) {
      const hashid = text(raw.hashid, 'a workflow hashid', where)
      const name = typeof raw.name === 'string' ? raw.name : ''
      const rawStatus = text(raw.status, `the status of ${hashid}`, where)
      if (!STATUSES.includes(rawStatus)) throw new Error(`${where}: ${hashid} has status ${rawStatus}, which this reader does not know`)
      const status = rawStatus as ExportStatus
      const other = workflowProject.get(hashid)
      if (other !== undefined) throw new Error(`workflow ${hashid} is listed by project ${other} and by project ${projectHashid}`)
      workflowProject.set(hashid, projectHashid)

      if (status === 'skipped_never_deployed') {
        workflows.push({ hashid, name, projectHashid, status, workflow: null, sha256: null, file: null })
        continue
      }
      const rel = text(raw.path, `the path of ${hashid}`, where)
      const full = path.resolve(path.dirname(manifestPath), rel)
      if (!existsSync(full)) throw new Error(`${where}: the file for ${hashid} (${rel}) is missing`)
      const bytes = readFileSync(full)
      const workflow = JSON.parse(bytes.toString('utf8')) as PipedreamWorkflow
      if (workflow.id !== hashid) throw new Error(`${where}: ${rel} is listed as ${hashid} but its id is ${workflow.id}`)
      claimed.add(full)
      workflows.push({
        hashid,
        name,
        projectHashid,
        status,
        workflow,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        file: path.relative(root, full),
      })
    }
    projects.push({ projectHashid, exportedAt, workflows })
  }

  const stray = files.filter((f) => !claimed.has(f)).map((f) => path.relative(root, f))
  if (stray.length > 0) throw new Error(`${stray.join(', ')}: workflow file(s) no manifest lists`)

  return projects.sort((a, b) => (a.projectHashid < b.projectHashid ? -1 : a.projectHashid > b.projectHashid ? 1 : 0))
}
