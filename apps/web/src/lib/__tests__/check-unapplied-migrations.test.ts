import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody } from './_scan-utils'

/**
 * The unapplied migration check, one script for both databases (#1829).
 *
 * Migrations are applied by hand, so a deploy must refuse while one merged in
 * the repository has not reached its database. The bidding database had this
 * check inline in deploy.yml; the ops database (#1709) had none. Both now run
 * .github/scripts/check-unapplied-migrations.sh.
 *
 * The Supabase CLI is stubbed through SUPABASE_BIN: the stub records every call
 * and answers `migration list` with a table in the CLI's real shape (copied from
 * a Deploy log of 2026-09-14), or fails the step a test names.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/check-unapplied-migrations.sh')

const HEADER = '  \n   Local          | Remote         | Time (UTC)          \n  ----------------|----------------|---------------------\n'
const applied = (v: string) => `   ${v} | ${v} | 2026-04-02 00:00:01 \n`
const unapplied = (v: string) => `   ${v} |                | 2026-04-02 00:00:01 \n`

interface Setup {
  /** Migration versions present in the repository. */
  local: string[]
  /** What `migration list --linked` prints. */
  table: string
  /** A CLI step that exits non zero. */
  failOn?: 'link' | 'list'
  workdir?: string
  ref?: string
}

function run(s: Setup) {
  const dir = mkdtempSync(path.join(tmpdir(), 'unapplied-'))
  const workdir = s.workdir ?? '.'
  const migrations = path.join(dir, workdir, 'supabase', 'migrations')
  mkdirSync(migrations, { recursive: true })
  for (const v of s.local) writeFileSync(path.join(migrations, `${v}_step.sql`), 'select 1;\n')
  const calls = path.join(dir, 'calls')
  writeFileSync(calls, '')
  const table = path.join(dir, 'table')
  writeFileSync(table, s.table)
  const stub = path.join(dir, 'supabase-stub.sh')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${calls}"`,
      'case "$*" in',
      `  *" link "*) ${s.failOn === 'link' ? 'echo "failed to connect to postgres: FATAL: password authentication failed for user \\"cli_login_postgres\\"" >&2; exit 1' : 'echo "Finished supabase link."'} ;;`,
      `  *"migration list"*) ${s.failOn === 'list' ? 'echo "unexpected list error" >&2; exit 1' : `cat "${table}"`} ;;`,
      '  *) echo "unexpected call: $*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
  const args = s.ref === undefined ? ['proj_ref', workdir] : [s.ref, workdir]
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: dir,
    env: { ...process.env, SUPABASE_BIN: stub },
    encoding: 'utf8',
  })
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
  }
}

describe('check-unapplied-migrations.sh (#1829)', () => {
  it('passes when every migration in the repository is applied, and prints the table', () => {
    const r = run({ local: ['20260402000001', '20260402000002'], table: HEADER + applied('20260402000001') + applied('20260402000002') })
    expect(r.status).toBe(0)
    expect(r.out).toContain('20260402000002 | 20260402000002')
    expect(r.out).toMatch(/All 2 migration\(s\) .* applied/)
  })

  it('refuses by name when a migration has a blank Remote column', () => {
    const r = run({ local: ['20260402000001', '20260402000002'], table: HEADER + applied('20260402000001') + unapplied('20260402000002') })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*20260402000002/)
    expect(r.out).not.toMatch(/::error::.*20260402000001/)
  })

  it('refuses a migration the table does not list at all, because only a matching applied row counts as applied (L156)', () => {
    const r = run({ local: ['20260402000001', '20260402000003'], table: HEADER + applied('20260402000001') })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*20260402000003/)
  })

  it('ignores a migration applied in the database but absent from the repository', () => {
    const r = run({ local: ['20260402000001'], table: HEADER + applied('20260402000001') + applied('20260101000009') })
    expect(r.status).toBe(0)
  })

  it('fails by name, with the remedy, when the link step fails', () => {
    const r = run({ local: ['20260402000001'], table: '', failOn: 'link' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*could not link/)
    expect(r.out).toContain('cli_login_postgres')
    expect(r.calls.some((c) => c.includes('migration list'))).toBe(false)
  })

  it('fails by name when listing the migrations fails, rather than passing on no output (L98)', () => {
    const r = run({ local: ['20260402000001'], table: '', failOn: 'list' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*could not list/)
  })

  it('fails by name when the table cannot be read, rather than finding nothing unapplied', () => {
    const r = run({ local: ['20260402000001'], table: 'Some new CLI output format\n' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*20260402000001/)
  })

  it('refuses when the repository holds no migrations, because that is a wrong directory, not a clean one', () => {
    const r = run({ local: [], table: HEADER })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*no migrations/)
  })

  it('refuses an empty project ref rather than linking to nothing (a missing repo variable)', () => {
    const r = run({ local: ['20260402000001'], table: HEADER + applied('20260402000001'), ref: '' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/usage/)
    expect(r.calls).toEqual([])
  })

  it('links and lists in the workdir it was given, and names that workdir in the remedy', () => {
    const r = run({ local: ['20261006210000'], table: HEADER + unapplied('20261006210000'), workdir: 'supabase-ops', ref: 'ops_ref' })
    expect(r.status).toBe(1)
    expect(r.calls).toEqual(['--workdir supabase-ops link --project-ref ops_ref', '--workdir supabase-ops migration list --linked'])
    expect(r.out).toContain('supabase --workdir supabase-ops db push --linked')
  })

  it.each(['supabase/migrations', 'supabase-ops/supabase/migrations'])(
    'reads versions the way every real migration in %s is named',
    (dir) => {
      const files = readdirSync(path.join(REPO_ROOT, dir)).filter((f) => f.endsWith('.sql'))
      expect(files.length).toBeGreaterThan(0)
      expect(files.filter((f) => !/^\d{14}_/.test(f))).toEqual([])
    },
  )
})

describe('deploy.yml runs the check against both databases (#1829)', () => {
  const deploy = readWorkflow('.github/workflows/deploy.yml')

  it('checks the bidding database in Verify, so every deploy waits on it', () => {
    const job = workflowJobBody(deploy, 'verify-release')
    expect(job).toMatch(/check-unapplied-migrations\.sh "\$SUPABASE_PROJECT_ID" \./)
    expect(job).toMatch(/SUPABASE_PROJECT_ID:\s*\$\{\{\s*vars\.SUPABASE_PROJECT_ID\s*\}\}/)
  })

  it('checks the ops database in Deploy Ops Worker, before it deploys anything', () => {
    const job = workflowJobBody(deploy, 'deploy-ops-worker')
    const check = job.indexOf('check-unapplied-migrations.sh "$SUPABASE_OPS_PROJECT_ID" supabase-ops')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(job.indexOf('ensure-compare-namespace.sh'))
    expect(check).toBeLessThan(job.indexOf('pnpm --filter=worker exec wrangler deploy --config wrangler.ops.toml'))
    expect(job).toMatch(/SUPABASE_OPS_PROJECT_ID:\s*\$\{\{\s*vars\.SUPABASE_OPS_PROJECT_ID\s*\}\}/)
    expect(job).toMatch(/SUPABASE_ACCESS_TOKEN:\s*\$\{\{\s*secrets\.SUPABASE_ACCESS_TOKEN\s*\}\}/)
  })

  it('installs the same pinned CLI in both jobs', () => {
    const pin = (job: string) => /supabase\/setup-cli@v3\s*\n\s*with:[\s\S]*?version:\s*([\d.]+)/.exec(workflowJobBody(deploy, job))?.[1]
    expect(pin('verify-release')).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pin('deploy-ops-worker')).toBe(pin('verify-release'))
  })

  it('keeps no inline copy of the table parse anywhere in the workflow', () => {
    expect(deploy).not.toContain('migration list --linked')
  })
})
