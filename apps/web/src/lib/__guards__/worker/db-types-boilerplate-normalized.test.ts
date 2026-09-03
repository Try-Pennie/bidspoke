/**
 * #1105. On 2026-09-02 the nightly DB Types Drift check went red, and stayed red for
 * three runs across two days, on five added parentheses in the generated file's
 * boilerplate helper types. No table, column, function or enum differed.
 *
 * The pinned Supabase CLI is not the variable and cannot be: `supabase gen types
 * --project-id` asks Supabase's Management API to generate the file, so the
 * formatting is decided server-side. The pinned 2.107.0 produced one format at
 * 09:00 UTC and another at 12:22 the same day, on the identical commit (LESSONS
 * L552). The check compares byte for byte, so a purely cosmetic upstream change
 * fires a Slack alert whose text blames a migration that never happened, and while
 * it is red it cannot report a real schema change either (L36, L538).
 *
 * gen-db-types.sh therefore substitutes that whole region with a canonical copy the
 * repo owns. The region is safe to freeze because it carries NO schema information:
 * it is the same text for every Supabase project. The schema-bearing parts (the
 * `Database` type and the `Constants` block) still pass through untouched, so a real
 * schema change still fails the check, which the positive control below asserts.
 *
 * Freezing text found by matching is only safe if a miss is LOUD (L100), so every
 * way the substitution can fail to find what it expects has its own message and its
 * own test here: a missing start anchor, a missing end anchor, and, the one that
 * matters most, a declaration inside the region that the frozen copy does not have.
 * That last one is what stops an upstream ADDITION being silently discarded.
 *
 * Seams (L284): the generator is replaced by a fake `supabase` on PATH and the
 * script runs in a temp working directory, so this touches no network and no
 * database. Everything else the script uses (grep, awk, mktemp) is deliberately
 * real, because the normalisation is what is under test.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const SCRIPT = path.join(REPO_ROOT, 'apps/worker/scripts/gen-db-types.sh')
const FRAGMENT = path.join(REPO_ROOT, 'apps/worker/scripts/db-types-helpers.ts.txt')
const COMMITTED = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

interface Run {
  status: number | null
  stderr: string
  file: string | null
}

function runGenerator(generatorOutput: string, opts: { exitCode?: number; existing?: string } = {}): Run {
  const work = mkdtempSync(path.join(tmpdir(), 'db-types-'))
  const typesDir = path.join(work, 'src', 'types')
  mkdirSync(typesDir, { recursive: true })
  const target = path.join(typesDir, 'database.ts')
  if (opts.existing !== undefined) writeFileSync(target, opts.existing)

  const binDir = path.join(work, 'bin')
  mkdirSync(binDir)
  const outFile = path.join(work, 'generator-output.txt')
  writeFileSync(outFile, generatorOutput)
  writeFileSync(
    path.join(binDir, 'supabase'),
    [
      '#!/usr/bin/env bash',
      'if [ "${FAKE_SUPABASE_EXIT:-0}" != "0" ]; then',
      '  echo "gen types: upstream 504" >&2',
      '  exit "$FAKE_SUPABASE_EXIT"',
      'fi',
      'cat "$FAKE_SUPABASE_OUTPUT"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const res = spawnSync('bash', [SCRIPT], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      SUPABASE_PROJECT_ID: 'test-project',
      FAKE_SUPABASE_OUTPUT: outFile,
      ...(opts.exitCode === undefined ? {} : { FAKE_SUPABASE_EXIT: String(opts.exitCode) }),
    },
  })

  return {
    status: res.status,
    stderr: res.stderr ?? '',
    file: existsSync(target) ? readFileSync(target, 'utf8') : null,
  }
}

/** The two lines the hosted generator emits inconsistently; the script already strips them. */
const NONDETERMINISTIC_COMMENTS = [
  '// Allows to automatically instantiate createClient with right options',
  "// instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)",
].join('\n')

const JSON_TYPE = `export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]
`

function databaseBlock(opts: { extraColumn?: string; partitionChild?: string } = {}): string {
  const extra = opts.extraColumn ? `\n          ${opts.extraColumn}: string | null` : ''
  const partition = opts.partitionChild
    ? `      ${opts.partitionChild}: {
        Row: {
          id: string
        }
      }
`
    : ''
  return `export type Database = {
  public: {
    Tables: {
${partition}      widgets: {
        Row: {
          id: string${extra}
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
`
}

/**
 * The boilerplate region, in the two formats the hosted generator has emitted. They
 * differ only in the parentheses, which is exactly the change that went red.
 */
function boilerplate(opts: { parenthesised: boolean; extraDeclaration?: boolean } = { parenthesised: false }): string {
  const open = opts.parenthesised ? '(' : ''
  const close = opts.parenthesised ? ')' : ''
  const helper = (name: string, key: string) =>
    `export type ${name}<
  Name extends ${open}keyof DefaultSchema["${key}"]${close} = never,
> = DefaultSchema["${key}"][Name]
`
  const extra = opts.extraDeclaration
    ? `export type Relationships<Name extends keyof DefaultSchema["Tables"]> = DefaultSchema["Tables"][Name]
`
    : ''
  return [
    'type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">',
    '',
    'type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]',
    '',
    helper('Tables', 'Tables'),
    helper('TablesInsert', 'Tables'),
    helper('TablesUpdate', 'Tables'),
    helper('Enums', 'Enums'),
    helper('CompositeTypes', 'CompositeTypes'),
    extra,
  ].join('\n')
}

const CONSTANTS = `export const Constants = {
  public: {
    Enums: {},
  },
} as const
`

function generatorOutput(
  opts: {
    parenthesised?: boolean
    extraColumn?: string
    extraDeclaration?: boolean
    partitionChild?: string
    omitStartAnchor?: boolean
    omitEndAnchor?: boolean
  } = {},
): string {
  const region = boilerplate({
    parenthesised: opts.parenthesised ?? false,
    extraDeclaration: opts.extraDeclaration,
  })
  return [
    NONDETERMINISTIC_COMMENTS,
    JSON_TYPE,
    databaseBlock({ extraColumn: opts.extraColumn, partitionChild: opts.partitionChild }),
    opts.omitStartAnchor
      ? region.split('\n').filter((l) => !l.startsWith('type DatabaseWithoutInternals')).join('\n')
      : region,
    opts.omitEndAnchor ? '' : CONSTANTS,
  ].join('\n')
}

describe('gen-db-types normalises the boilerplate the generator reformats (#1105)', () => {
  it('produces the same file whether the generator parenthesises the helpers or not', () => {
    const oldFormat = runGenerator(generatorOutput({ parenthesised: false }))
    const newFormat = runGenerator(generatorOutput({ parenthesised: true }))

    expect(oldFormat.status).toBe(0)
    expect(newFormat.status).toBe(0)
    expect(newFormat.file).toBe(oldFormat.file)
  })

  it('writes the repo-owned helper text rather than whatever the generator sent', () => {
    const run = runGenerator(generatorOutput({ parenthesised: false }))

    expect(run.status).toBe(0)
    expect(run.file).toContain(readFileSync(FRAGMENT, 'utf8').trim())
  })
})

describe('gen-db-types still reports a real schema change (#1105 positive control)', () => {
  // Without this, every assertion above is satisfied by a script that emits a constant.
  it('produces a different file when a column is added', () => {
    const before = runGenerator(generatorOutput({ parenthesised: true }))
    const after = runGenerator(generatorOutput({ parenthesised: true, extraColumn: 'nickname' }))

    expect(after.status).toBe(0)
    expect(after.file).not.toBe(before.file)
    expect(after.file).toContain('nickname')
  })
})

describe('gen-db-types refuses rather than guessing when the region is not what it expects (L100)', () => {
  it('fails loudly, naming the declaration, when the generator adds a helper the frozen copy lacks', () => {
    const run = runGenerator(generatorOutput({ parenthesised: true, extraDeclaration: true }))

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Relationships')
  })

  it('fails with its own message when the region start anchor is missing', () => {
    const run = runGenerator(generatorOutput({ omitStartAnchor: true }))

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('DatabaseWithoutInternals')
  })

  it('fails with its own message when the region end anchor is missing', () => {
    const run = runGenerator(generatorOutput({ omitEndAnchor: true }))

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Constants')
  })
})

describe('gen-db-types preserves the behaviour it already had', () => {
  it('strips dated partition child tables (#322)', () => {
    const run = runGenerator(generatorOutput({ partitionChild: 'execution_steps_2026_06_14' }))

    expect(run.status).toBe(0)
    expect(run.file).not.toContain('execution_steps_2026_06_14')
    expect(run.file).toContain('widgets')
  })

  it('leaves the committed file untouched when the generator fails', () => {
    const run = runGenerator(generatorOutput(), { exitCode: 1, existing: 'PREVIOUS CONTENT\n' })

    expect(run.status).not.toBe(0)
    expect(run.file).toBe('PREVIOUS CONTENT\n')
  })
})

describe('the committed types match the frozen helper text (#1105)', () => {
  // Keeps the artifact and the fragment in sync without needing the network.
  it('contains the fragment verbatim', () => {
    expect(readFileSync(COMMITTED, 'utf8')).toContain(readFileSync(FRAGMENT, 'utf8').trim())
  })
})
