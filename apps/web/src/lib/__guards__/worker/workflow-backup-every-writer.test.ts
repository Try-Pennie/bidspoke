/**
 * Every workflow version the Worker writes is pushed to the GitHub backup (#2868).
 *
 * The save route pushed each new definition to the backup repo and stamped the
 * commit on the version row; a version restore did not, and neither did the
 * Connections Replace route, which writes a new version of every workflow it
 * moves. After either, the backup held the replaced definition until somebody
 * next saved that workflow on the canvas, so a restore from the backup in that
 * window brought back what the write had replaced.
 *
 * The push now lives in the one definition writer: writeWorkflow
 * (lib/write-workflow.ts) calls backUpWrittenVersion (lib/workflow-backup.ts)
 * for every op that writes a version, and requires a `backup` context of
 * every call. This reads the worker source and fails on any way around that:
 *
 * - a write_workflow call anywhere but writeWorkflow, or a version row written
 *   any other way (an insert, upsert or delete on workflow_versions anywhere,
 *   or an update outside the backup's own commit stamp);
 * - writeWorkflow no longer calling backUpWrittenVersion after its write, or
 *   the backup pushed from anywhere else (a route keeping its own push would
 *   push each version twice);
 * - a writeWorkflow call handing it no backup context (null, undefined, or a
 *   cast, which is how a call would get past the required type);
 * - VERSION_OPS, the ops writeWorkflow backs up, drifting from the ops the
 *   write_workflow function answers with the version it wrote.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listTsFiles, sanitizeSource, chainCallsAfter, consumeParens } from '../../__tests__/_scan-utils'

const WRITER = 'lib/write-workflow.ts'
const BACKUP = 'lib/workflow-backup.ts'

interface Finding { file: string; what: string }

/** Every call of `name(` in comment free source that is not its own declaration, with the source of its arguments. */
function callsOf(src: string, name: string): Array<{ at: number; args: string }> {
  const out: Array<{ at: number; args: string }> = []
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g'))) {
    const at = m.index ?? 0
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue
    const open = at + m[0].length - 1
    out.push({ at, args: src.slice(open + 1, consumeParens(src, open) - 1) })
  }
  return out
}

/** The value written for the `backup` key of a writeWorkflow call's object, or null when the key is absent. */
function backupValueOf(args: string): string | null {
  const m = /(?<![\w$])backup\s*:/.exec(args)
  if (m) {
    // The value runs to the comma or brace that closes it at its own depth.
    let depth = 0
    let end = m.index + m[0].length
    for (; end < args.length; end++) {
      const ch = args[end]
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth-- }
      else if (ch === ',' && depth === 0) break
    }
    return args.slice(m.index + m[0].length, end).trim()
  }
  // Shorthand `{ ..., backup }` passes a variable of that name.
  return /[{,]\s*backup\s*[,}]/.test(args) ? 'backup' : null
}

/** What one worker source file does that this guard refuses. */
function scanSource(file: string, raw: string): { findings: Finding[]; pushesFromWriter: boolean } {
  const src = sanitizeSource(raw, { blankStrings: false })
  const findings: Finding[] = []
  let pushesFromWriter = false

  if (file !== WRITER && /\.rpc\(\s*(['"`])write_workflow\1/.test(src)) {
    findings.push({ file, what: 'calls write_workflow outside writeWorkflow' })
  }
  for (const m of src.matchAll(/\.from\(\s*(['"`])workflow_versions\1\s*\)/g)) {
    const calls = chainCallsAfter(src, (m.index ?? 0) + m[0].length)
    const writes = calls.filter((c) => ['insert', 'upsert', 'delete', 'update'].includes(c.name))
    for (const w of writes) {
      const stamp = w.name === 'update' && file === BACKUP && /^\s*\{\s*commit_sha\s*:/.test(w.args)
      if (!stamp) findings.push({ file, what: `${w.name}s workflow_versions outside write_workflow` })
    }
  }
  if (file !== BACKUP && callsOf(src, 'pushWorkflowToGitHub').length > 0) {
    findings.push({ file, what: 'pushes the GitHub backup itself rather than through writeWorkflow' })
  }
  const backups = callsOf(src, 'backUpWrittenVersion')
  if (file !== WRITER && backups.length > 0) {
    findings.push({ file, what: 'calls backUpWrittenVersion outside writeWorkflow' })
  }
  if (file === WRITER) {
    const rpc = src.search(/\.rpc\(\s*(['"`])write_workflow\1/)
    pushesFromWriter = rpc >= 0 && backups.some((b) => b.at > rpc)
  }
  for (const call of callsOf(src, 'writeWorkflow')) {
    const value = backupValueOf(call.args)
    if (value === null) findings.push({ file, what: 'calls writeWorkflow with no backup' })
    else if (/^(?:null|undefined|void\b)|\bas\b/.test(value)) findings.push({ file, what: `calls writeWorkflow with backup: ${value}` })
  }
  return { findings, pushesFromWriter }
}

function scan(): { findings: Finding[]; pushesFromWriter: boolean; writeWorkflowCalls: number } {
  const findings: Finding[] = []
  let pushesFromWriter = false
  let writeWorkflowCalls = 0
  for (const full of listTsFiles(WORKER_SRC)) {
    const file = path.relative(WORKER_SRC, full)
    const raw = readFileSync(full, 'utf8')
    const one = scanSource(file, raw)
    findings.push(...one.findings)
    pushesFromWriter ||= one.pushesFromWriter
    writeWorkflowCalls += callsOf(sanitizeSource(raw, { blankStrings: false }), 'writeWorkflow').length
  }
  return { findings, pushesFromWriter, writeWorkflowCalls }
}

/** The ops whose branch of the newest write_workflow definition answers with the version it wrote. */
function opsAnsweringAVersion(): string[] {
  const dir = path.join(REPO_ROOT, 'supabase/migrations')
  const defining = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .filter((f) => /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?write_workflow\s*\(/i.test(readFileSync(path.join(dir, f), 'utf8')))
  const sql = readFileSync(path.join(dir, defining[defining.length - 1]), 'utf8')
  const branches = [...sql.matchAll(/IF\s+p_op\s*=\s*'(\w+)'\s+THEN/g)]
  return branches.flatMap((b, i) => {
    const body = sql.slice(b.index ?? 0, branches[i + 1]?.index ?? sql.length)
    return /'version_id'\s*,\s*v_version_id/.test(body) ? [b[1]] : []
  }).sort()
}

describe('every workflow version the Worker writes is pushed to the GitHub backup (#2868)', () => {
  const result = scan()

  it('reads the writers it exists to check (a scan that found none would pass on nothing)', () => {
    expect(result.writeWorkflowCalls).toBeGreaterThanOrEqual(6)
  })

  it('pushes the backup from writeWorkflow, after its write', () => {
    expect(result.pushesFromWriter).toBe(true)
  })

  it('has no version written, and no backup pushed, any other way, and every writeWorkflow call hands it a backup', () => {
    expect(result.findings).toEqual([])
  })

  it('backs up exactly the ops write_workflow answers with the version it wrote', () => {
    const declared = /VERSION_OPS[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(readFileSync(path.join(WORKER_SRC, WRITER), 'utf8'))
    expect(declared, 'VERSION_OPS is no longer declared as a literal set in lib/write-workflow.ts').not.toBeNull()
    const ops = [...(declared?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()
    expect(opsAnsweringAVersion()).toEqual(['restore', 'save'])
    expect(ops).toEqual(opsAnsweringAVersion())
  })
})

// The scanner itself, on text it must judge both ways.
describe('the scanner', () => {
  const route = 'routes/api/x.ts'
  const findings = (file: string, lines: string[]) => scanSource(file, lines.join('\n')).findings.map((f) => f.what)

  it('passes a writeWorkflow call that hands it the request\'s backup, in either form', () => {
    expect(findings(route, ["  await writeWorkflow(supabase, { op: 'save', orgId, backup: backupOf(c) })"])).toEqual([])
    expect(findings(route, ["  await writeWorkflow(supabase, {\n    op: 'save',\n    actor,\n    backup,\n  })"])).toEqual([])
  })

  it('fails a writeWorkflow call with no backup, or one cast or emptied past the type', () => {
    expect(findings(route, ["  await writeWorkflow(supabase, { op: 'save', orgId, actor })"])).toEqual(['calls writeWorkflow with no backup'])
    expect(findings(route, ["  await writeWorkflow(supabase, { op: 'restore', backup: undefined as never })"])).toHaveLength(1)
    expect(findings(route, ["  await writeWorkflow(supabase, { op: 'restore', backup: null! })"])).toHaveLength(1)
    expect(findings(route, ["  await writeWorkflow(supabase, { op: 'save', backup: {} as WorkflowBackupContext })"])).toHaveLength(1)
  })

  it('fails a version written around write_workflow', () => {
    expect(findings(route, ["  await supabase.rpc('write_workflow', args)"])).toEqual(['calls write_workflow outside writeWorkflow'])
    expect(findings(route, ["  await supabase.from('workflow_versions').insert({ definition })"])).toEqual(['inserts workflow_versions outside write_workflow'])
    expect(findings(route, ["  await supabase.from('workflow_versions').update({ commit_sha: sha }).eq('id', v)"])).toEqual(['updates workflow_versions outside write_workflow'])
  })

  it('allows the backup\'s own commit stamp, and nothing else it might write', () => {
    expect(findings(BACKUP, ["  supabase.from('workflow_versions').update({ commit_sha: commitSha }).eq('id', versionId).select('id')"])).toEqual([])
    expect(findings(BACKUP, ["  supabase.from('workflow_versions').update({ definition }).eq('id', versionId)"])).toHaveLength(1)
  })

  it('fails a route that pushes the backup itself, or calls the backup helper', () => {
    expect(findings(route, ['  c.executionCtx.waitUntil(pushWorkflowToGitHub(token, repo, id, name, def, 3))'])).toEqual(['pushes the GitHub backup itself rather than through writeWorkflow'])
    expect(findings(route, ['  backUpWrittenVersion(supabase, backup, written)'])).toEqual(['calls backUpWrittenVersion outside writeWorkflow'])
  })

  it('reads writeWorkflow as pushing only when it calls the helper after its write, and not from a comment', () => {
    const rpc = "  answer = await supabase.rpc('write_workflow', {})"
    expect(scanSource(WRITER, [rpc, '  if (VERSION_OPS.has(call.op)) backUpWrittenVersion(supabase, call.backup, w)'].join('\n')).pushesFromWriter).toBe(true)
    expect(scanSource(WRITER, [rpc, '  // backUpWrittenVersion(supabase, call.backup, w)'].join('\n')).pushesFromWriter).toBe(false)
    expect(scanSource(WRITER, ['  backUpWrittenVersion(supabase, call.backup, w)', rpc].join('\n')).pushesFromWriter).toBe(false)
  })
})
