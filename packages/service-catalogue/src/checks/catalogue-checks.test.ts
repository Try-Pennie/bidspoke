import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkCatalogue, scanForIdempotentHints, type CatalogueUnderCheck } from './catalogue-checks'
import { collectModuleImports } from './module-graph'
import { FIXTURE_CATALOGUE } from '../__fixtures__/catalogue'
import type { ActionSchema, ServiceSchema } from '../schema/types'
import type { RuntimeAction } from '../runtime/types'

/**
 * The checks every catalogue is held to, proven against the test only fixture
 * catalogue: it is clean as committed, and each way of breaking it is reported
 * by its own named problem. The shipped catalogue is held to the same function
 * in ../catalogue.test.ts, so these red cases are the proof that test can fail.
 */

const codes = async (catalogue: CatalogueUnderCheck) => (await checkCatalogue(catalogue)).map((p) => p.code)

/** The fixture with one of its schema actions rewritten. */
function withSchemaAction(key: string, version: number, edit: (a: ActionSchema) => ActionSchema): CatalogueUnderCheck {
  const services: ServiceSchema[] = FIXTURE_CATALOGUE.services.map((s) => ({
    ...s,
    actions: s.actions.map((a) => (a.key === key && a.version === version ? edit(a) : a)),
  }))
  const runtime: RuntimeAction[] = FIXTURE_CATALOGUE.runtime.map((r) => {
    if (r.key !== key || r.version !== version) return r
    return { ...edit(r), run: r.run }
  })
  return { ...FIXTURE_CATALOGUE, services, runtime }
}

/** A temporary copy of the fixture lockfile with one edit applied, which must change it. */
function lockfileCopy(edit: (text: string) => string): string {
  const original = readFileSync(FIXTURE_CATALOGUE.lockfile, 'utf8')
  const edited = edit(original)
  expect(edited, 'the lockfile edit matched nothing').not.toBe(original)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'catalogue-lockfile-')), 'pnpm-lock.yaml')
  writeFileSync(file, edited)
  return file
}

describe('the fixture catalogue is clean as committed', () => {
  it('has no problems', async () => {
    expect(await checkCatalogue(FIXTURE_CATALOGUE)).toEqual([])
  })

  it('has actions to check, so a clean result cannot be vacuous', () => {
    expect(FIXTURE_CATALOGUE.runtime.length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(FIXTURE_CATALOGUE.fingerprints).length).toBeGreaterThanOrEqual(2)
  })

  it('has a run that reaches an npm package, so the dependency checks below are not vacuous', () => {
    const { packages } = collectModuleImports(path.join(FIXTURE_CATALOGUE.actionsDir, 'fixture.echo.v2.ts'))
    expect(packages.map((p) => p.name)).toEqual(['@eslint/js'])
  })
})

describe('versioning is enforced by committed fingerprints (#1689 D1)', () => {
  it('fails when a released version no longer matches its fingerprint, and asks for a new version', async () => {
    const problems = await checkCatalogue({
      ...FIXTURE_CATALOGUE,
      fingerprints: { ...FIXTURE_CATALOGUE.fingerprints, 'fixture.echo@1': '0'.repeat(64) },
    })
    expect(problems.map((p) => p.code)).toEqual(['fingerprint_changed'])
    expect(problems[0].subject).toBe('fixture.echo@1')
    expect(problems[0].message).toContain('version 3')
  })

  it('treats a change to the argument schema as a change to the version', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({
      ...a,
      arguments: a.arguments.map((arg) => ({ ...arg, required: !arg.required })),
    }))
    expect(await codes(edited)).toEqual(['fingerprint_changed'])
  })

  it('treats a change to a trait as a change to the version', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, sideEffect: true, idempotent: true }))
    expect(await codes(edited)).toEqual(['fingerprint_changed'])
  })

  it('treats a change to the Google scopes an action asks for as a change to the version (#2335)', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, googleScopes: ['https://www.googleapis.com/auth/spreadsheets'] }))
    expect(await codes(edited)).toEqual(['fingerprint_changed'])
  })

  it('lets a display only field change without a new version', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({
      ...a,
      name: 'Echo, renamed',
      idempotentBecause: `${a.idempotentBecause} Reworded.`,
    }))
    expect(await codes(edited)).toEqual([])
  })

  it('names a version with no committed fingerprint, giving the line to add', async () => {
    const fingerprints = { ...FIXTURE_CATALOGUE.fingerprints }
    const expected = fingerprints['fixture.echo@2']
    delete fingerprints['fixture.echo@2']
    const problems = await checkCatalogue({ ...FIXTURE_CATALOGUE, fingerprints })
    expect(problems.map((p) => p.code)).toEqual(['fingerprint_missing'])
    expect(problems[0].message).toContain(`"fixture.echo@2": "${expected}"`)
  })

  it('treats an upgrade of an npm package the run reaches as a change to the version', async () => {
    const problems = await checkCatalogue({
      ...FIXTURE_CATALOGUE,
      // As pnpm writes an upgrade: the importer's version and the snapshot's key move together.
      lockfile: lockfileCopy((text) => text.replace('version: 10.0.1(eslint', 'version: 10.0.2(eslint').replace("'@eslint/js@10.0.1(", "'@eslint/js@10.0.2(")),
    })
    expect(problems.map((p) => p.code)).toEqual(['fingerprint_changed'])
    expect(problems[0].subject).toBe('fixture.echo@2')
    expect(problems[0].message).toContain('resolved version of an npm package')
  })

  it("treats a transitive dependency moving within its range as a change to the version (the package's closure)", async () => {
    // @eslint/js -> eslint -> esquery -> estraverse: only the last moves.
    const problems = await checkCatalogue({
      ...FIXTURE_CATALOGUE,
      lockfile: lockfileCopy((text) =>
        text.replace('      estraverse: 5.3.0', '      estraverse: 5.3.1').replace('  estraverse@5.3.0: {}', '  estraverse@5.3.1: {}'),
      ),
    })
    expect(problems.map((p) => p.code)).toEqual(['fingerprint_changed'])
    expect(problems[0].subject).toBe('fixture.echo@2')
  })

  it('lets a snapshot no run reaches change without a new version', async () => {
    const lockfile = lockfileCopy((text) => text.replace('  typescript@6.0.3: {}', '  typescript@6.0.4: {}'))
    expect(await codes({ ...FIXTURE_CATALOGUE, lockfile })).toEqual([])
  })

  it('refuses, by name, a dependency of a reached package that the lockfile holds no snapshot for', async () => {
    const lockfile = lockfileCopy((text) => text.replace('  estraverse@5.3.0: {}\n', ''))
    const problems = await checkCatalogue({ ...FIXTURE_CATALOGUE, lockfile })
    expect(problems.map((p) => p.code)).toEqual(['dependency_unresolved'])
    expect(problems[0].message).toContain('estraverse@5.3.0')
  })

  it('lets an npm package no run reaches change without a new version', async () => {
    const lockfile = lockfileCopy((text) => text.replace('version: 6.0.3', 'version: 6.0.4'))
    expect(await codes({ ...FIXTURE_CATALOGUE, lockfile })).toEqual([])
  })

  it('refuses, by name, a run reaching an npm package the lockfile does not resolve', async () => {
    const lockfile = lockfileCopy((text) =>
      text.replace("      '@eslint/js':\n        specifier: ^10.0.1\n        version: 10.0.1(eslint@10.6.0(jiti@2.7.0))\n", ''),
    )
    const problems = await checkCatalogue({ ...FIXTURE_CATALOGUE, lockfile })
    expect(problems.map((p) => p.code)).toEqual(['dependency_unresolved'])
    expect(problems[0].subject).toBe('fixture.echo@2')
    expect(problems[0].message).toContain('@eslint/js')
  })

  it('fails when the lockfile cannot be read, rather than fingerprinting without versions', async () => {
    const problems = await checkCatalogue({ ...FIXTURE_CATALOGUE, lockfile: '/nonexistent/pnpm-lock.yaml' })
    expect(problems.map((p) => p.code)).toEqual(['lockfile_unreadable'])
    const wrongImporter = await checkCatalogue({ ...FIXTURE_CATALOGUE, importer: 'packages/missing' })
    expect(wrongImporter.map((p) => p.code)).toEqual(['lockfile_unreadable'])
  })

  it('names a committed fingerprint whose action version is gone', async () => {
    const problems = await checkCatalogue({
      ...FIXTURE_CATALOGUE,
      fingerprints: { ...FIXTURE_CATALOGUE.fingerprints, 'fixture.gone@1': '0'.repeat(64) },
    })
    expect(problems.map((p) => p.code)).toEqual(['fingerprint_orphaned'])
    expect(problems[0].subject).toBe('fixture.gone@1')
  })
})

describe('every action decides its own traits (R11)', () => {
  it('refuses a trait that is not a decided boolean', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, idempotent: undefined as unknown as boolean }))
    expect(await codes(edited)).toContain('trait_not_decided')
  })

  it('refuses an idempotent decision with no recorded reason', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, idempotentBecause: '  ' }))
    expect(await codes(edited)).toEqual(['idempotent_reason_missing'])
  })

  it('refuses a read that claims it is unsafe to repeat', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, sideEffect: false, idempotent: false }))
    expect(await codes(edited)).toContain('read_not_idempotent')
  })
})

describe('catalogue structure', () => {
  it('refuses two registrations of one (key, version)', async () => {
    const [service] = FIXTURE_CATALOGUE.services
    const services = [{ ...service, actions: [...service.actions, service.actions[0]] }]
    expect(await codes({ ...FIXTURE_CATALOGUE, services })).toContain('duplicate_action_version')
  })

  it('refuses an action key that does not start with its service key', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, key: 'other.echo' }))
    expect(await codes(edited)).toContain('action_key_outside_service')
  })

  it('refuses a version that is not a positive whole number', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, version: 1.5 }))
    expect(await codes(edited)).toContain('version_not_positive_integer')
  })

  it('refuses two arguments with one key', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, arguments: [...a.arguments, a.arguments[0]] }))
    expect(await codes(edited)).toContain('argument_duplicate_key')
  })

  it('refuses an argument that depends on one the action does not have', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({
      ...a,
      arguments: a.arguments.map((arg) => ({ ...arg, dependsOn: ['missing'] })),
    }))
    expect(await codes(edited)).toContain('argument_depends_on_unknown')
  })

  it('refuses a Google scope the Workspace grant does not hold, and an empty scope list (#2335, F129)', async () => {
    const outside = withSchemaAction('fixture.echo', 1, (a) => ({
      ...a,
      googleScopes: ['https://www.googleapis.com/auth/admin.directory.user' as 'https://www.googleapis.com/auth/drive'],
    }))
    expect(await codes(outside)).toContain('google_scope_not_granted')
    const empty = withSchemaAction('fixture.echo', 1, (a) => ({ ...a, googleScopes: [] }))
    expect(await codes(empty)).toContain('google_scope_not_granted')
  })

  it('refuses a dropdown with no lookup to fill it', async () => {
    const edited = withSchemaAction('fixture.echo', 1, (a) => ({
      ...a,
      arguments: a.arguments.map((arg) => ({ ...arg, type: 'dropdown' as const })),
    }))
    expect(await codes(edited)).toContain('dropdown_without_source')
  })
})

describe('schema and runtime pair one to one, and each run comes from its own file', () => {
  it('names a schema action with no run', async () => {
    const runtime = FIXTURE_CATALOGUE.runtime.filter((r) => r.version !== 2)
    expect(await codes({ ...FIXTURE_CATALOGUE, runtime })).toEqual(['schema_without_run'])
  })

  it('names a run with no schema action', async () => {
    const services = FIXTURE_CATALOGUE.services.map((s) => ({ ...s, actions: s.actions.filter((a) => a.version !== 2) }))
    const problems = await codes({ ...FIXTURE_CATALOGUE, services })
    expect(problems).toContain('run_without_schema')
  })

  it('names a registered run that is not the one exported by its action file', async () => {
    const runtime = FIXTURE_CATALOGUE.runtime.map((r) =>
      r.version === 1 ? { ...r, run: () => Promise.resolve({ echo: 'inline' }) } : r,
    )
    expect(await codes({ ...FIXTURE_CATALOGUE, runtime })).toEqual(['run_not_from_its_file'])
  })

  it('names an action whose run file is missing', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'catalogue-empty-'))
    expect(await codes({ ...FIXTURE_CATALOGUE, actionsDir: empty })).toContain('run_file_missing')
  })

  it('names an action file that nothing registers', async () => {
    const services = FIXTURE_CATALOGUE.services.map((s) => ({ ...s, actions: s.actions.filter((a) => a.version !== 2) }))
    const runtime = FIXTURE_CATALOGUE.runtime.filter((r) => r.version !== 2)
    const fingerprints = { ...FIXTURE_CATALOGUE.fingerprints }
    delete fingerprints['fixture.echo@2']
    expect(await codes({ ...FIXTURE_CATALOGUE, services, runtime, fingerprints })).toEqual(['run_file_unregistered'])
  })
})

describe('idempotent is never taken from a Pipedream annotation', () => {
  it('finds the annotation wherever it is written', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'catalogue-hint-'))
    mkdirSync(path.join(dir, 'nested'))
    const hint = 'idempotent' + 'Hint'
    writeFileSync(path.join(dir, 'nested', 'copied.ts'), `export const annotations = { ${hint}: true }\n`)
    writeFileSync(path.join(dir, 'clean.ts'), 'export const x = 1\n')
    expect(scanForIdempotentHints(dir)).toEqual([path.join(dir, 'nested', 'copied.ts')])
  })
})
