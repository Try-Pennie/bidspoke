import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { RULES, checkProject, queryProject } from '../../../../../.github/scripts/db-privilege-check.mjs'

/**
 * The live database privilege check (#1709, plan 0.E): CI asks each Supabase
 * project, through the Management API, for every object the browser roles can
 * reach that they should not. These tests hold the reporting; the rule SQL itself
 * was seen red on the real ops project before its first migration and green after
 * (recorded on the pull request).
 */

type Call = { url: string; init: RequestInit }

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: input instanceof Request ? input.url : input.toString(), init: init ?? {} }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { f, calls }
}

describe('queryProject (#1709)', () => {
  it('posts the SQL to the project read only query endpoint with the token', async () => {
    const { f, calls } = fakeFetch(() => Response.json([{ kind: 'inspected', object: '3', problem: null }]))
    const rows = await queryProject(f, 'tok', 'abc123', 'select 1')
    expect(rows).toEqual([{ kind: 'inspected', object: '3', problem: null }])
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abc123/database/query/read-only')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer tok')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'select 1' })
  })

  it('throws with the status and body when the API refuses, rather than reading as no violations', async () => {
    const { f } = fakeFetch(() => new Response('{"message":"unauthorized"}', { status: 401 }))
    await expect(queryProject(f, 'tok', 'abc123', 'select 1')).rejects.toThrow(/abc123.*401.*unauthorized/)
  })

  it('throws when the answer is not a list of rows', async () => {
    const { f } = fakeFetch(() => Response.json({ result: [] }))
    await expect(queryProject(f, 'tok', 'abc123', 'select 1')).rejects.toThrow(/not a list/)
  })
})

describe('checkProject (#1709)', () => {
  it('passes a project with objects inspected and no violation', () => {
    const v = checkProject('ops', [{ kind: 'inspected', object: '4', problem: null }])
    expect(v.ok).toBe(true)
    expect(v.lines).toEqual(['ops: 4 object(s) inspected, no violation'])
  })

  it('fails and names every violation', () => {
    const v = checkProject('ops', [
      { kind: 'inspected', object: '2', problem: null },
      { kind: 'violation', object: 'public.runs', problem: 'anon holds a privilege' },
      { kind: 'violation', object: 'schema public', problem: 'authenticated holds USAGE' },
    ])
    expect(v.ok).toBe(false)
    expect(v.lines).toEqual([
      'ops: 2 object(s) inspected, 2 violation(s)',
      '  public.runs: anon holds a privilege',
      '  schema public: authenticated holds USAGE',
    ])
  })

  it('fails when the rule returned no inspected count, since then it measured nothing (L98)', () => {
    const v = checkProject('main', [])
    expect(v.ok).toBe(false)
    expect(v.lines[0]).toMatch(/main: the rule returned no inspected count/)
  })

  it('fails on a row of a kind it does not know rather than skipping it', () => {
    const v = checkProject('main', [{ kind: 'inspected', object: '1', problem: null }, { kind: 'warning', object: 'x', problem: 'y' }])
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toMatch(/unknown row kind warning/)
  })
})

describe('RULES (#1709)', () => {
  it('holds a rule for each project, each reporting an inspected count and violations', () => {
    expect(Object.keys(RULES).sort()).toEqual(['main', 'ops'])
    for (const sql of Object.values(RULES)) {
      expect(sql).toMatch(/'inspected'/)
      expect(sql).toMatch(/'violation'/)
    }
  })

  it('checks the ops project for browser privileges, RLS, organization_id, functions, schema usage and default grants', () => {
    for (const fragment of ['has_table_privilege', 'relrowsecurity', 'organization_id', 'has_function_privilege', 'has_schema_privilege', 'pg_default_acl']) {
      expect(RULES.ops).toContain(fragment)
    }
  })

  it('checks the main project for browser reachable tables without RLS and for anything in porting', () => {
    expect(RULES.main).toContain('relrowsecurity')
    expect(RULES.main).toContain("'porting'")
  })
})

describe('the script as CI runs it (#1709)', () => {
  it('runs when started by a relative path, and fails by name with no token rather than exiting 0 having checked nothing (L98)', () => {
    const env = { ...process.env, SUPABASE_ACCESS_TOKEN: '', MAIN_PROJECT_REF: '', OPS_PROJECT_REF: '' }
    const r = spawnSync('node', ['.github/scripts/db-privilege-check.mjs'], { cwd: REPO_ROOT, env, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/SUPABASE_ACCESS_TOKEN, MAIN_PROJECT_REF, OPS_PROJECT_REF not set, so nothing was checked/)
  })
})
