import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { consumeParens, listFiles, REPO_ROOT } from '../../__tests__/_scan-utils'

/**
 * Issue #764. `deploy.yml` checks that migrations are APPLIED, never that the
 * database objects the shipping code depends on actually exist and carry the
 * permissions it assumes. Those are different questions, and both near misses on
 * 2026-08-13 were in the gap: a migration's comment asserted `anon` was excluded
 * from a security-definer function while Postgres had granted EXECUTE to PUBLIC
 * anyway, and only a live privilege query caught it (LESSONS L124).
 *
 * It matters because `apps/web/src/middleware.ts` calls `is_allowlisted()` on
 * every protected request. If that function were missing or its grant wrong,
 * every employee would hit /access-denied with `gate_unavailable` while the
 * pipeline reported a clean deploy throughout.
 *
 * The check runs against the LIVE database with nothing but the public anon key,
 * which is already a repo variable. PostgREST distinguishes the two failure
 * modes cleanly, measured against prod on 2026-08-14:
 *
 *   exists, anon EXECUTE revoked -> HTTP 401, code 42501
 *   not present (or wrong args)  -> HTTP 404, code PGRST202
 *   anon may execute it          -> HTTP 2xx
 *
 * This complements `security-definer-grants.test.ts`, which reads the
 * migrations. That guard cannot see a function no migration in this repo creates
 * (it says so about `rls_auto_enable`), and it cannot see a REVOKE that was
 * written but did not take effect. The live side sees both.
 *
 * THE ARGUMENT NAMES MATTER, and this is the trap that would otherwise make the
 * whole check useless. Measured: `auth_user_with_allowlist` probed with an empty
 * body returns PGRST202, indistinguishable from missing, and returns 42501 only
 * when given its real `p_user_id`. A prober that sends `{}` would therefore
 * report most of the app's own RPCs as absent. So the manifest carries the
 * argument shape the app actually sends.
 */
const scriptPath = path.join(REPO_ROOT, '.github/scripts/db-object-decision.sh')
const MANIFEST = path.join(REPO_ROOT, 'supabase/required-live-objects.json')

function decide(httpCode: string, pgCode: string, expectedAnon: string): string {
  return execFileSync('bash', [scriptPath, httpCode, pgCode, expectedAnon], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('db-object-decision: the object exists and carries the expected grant (#764)', () => {
  it('passes a function that exists and correctly denies anon', () => {
    expect(decide('401', '42501', 'denied')).toBe('ok')
  })

  it('passes a function that exists and is deliberately callable by anon', () => {
    expect(decide('200', '', 'allowed')).toBe('ok')
  })

  it('fails when the function is not present', () => {
    expect(decide('404', 'PGRST202', 'denied')).toBe('missing')
  })

  it('fails when a function meant to deny anon can be executed by anon', () => {
    // The #764 case: a REVOKE that was written but did not take effect, which is
    // invisible in review because the evidence is an absent line.
    expect(decide('200', '', 'denied')).toBe('anon_can_execute')
  })

  it('fails when the function is missing even though anon was allowed to call it', () => {
    // A deliberately-callable function still has to exist.
    expect(decide('404', 'PGRST202', 'allowed')).toBe('missing')
  })
})

describe('db-object-decision: an object that must be GONE (#1145)', () => {
  /**
   * The inverse assertion. `20260910220000` dropped three ungated expiry
   * routines, each of which deleted a day of execution history without asking
   * the archive gate whether that day was backed up.
   *
   * A DROP needs a guard that outlives the migration performing it. There is
   * already a scan over migration TEXT, and it cannot see a routine somebody
   * recreates by hand in the database, which is the likelier way one comes back:
   * under a name that reads like the right one, recorded in no file (L29, L346).
   * This half watches the live database instead.
   */
  it('passes when the dropped function is not there', () => {
    expect(decide('404', 'PGRST202', 'absent')).toBe('ok')
  })

  it('fails when a dropped function answers, even with a privilege error', () => {
    // 42501 proves the object EXISTS. Everywhere else that is the reassurance;
    // here it is the whole finding, and it is the likelier of the two answers
    // because anything recreated arrives with the same REVOKEs around it.
    expect(decide('401', '42501', 'absent')).toBe('still_present')
  })

  it('fails when a dropped function is back AND anon can run it', () => {
    expect(decide('200', '', 'absent')).toBe('still_present')
  })

  it('still reports unreachable rather than a pass when it cannot ask', () => {
    // The direction that matters most for an absence claim: a probe that never
    // reached the database has measured nothing, and reporting `ok` would turn
    // every outage into proof the object is gone (L98, L345).
    expect(decide('', '', 'absent')).toBe('unreachable')
    expect(decide('000', '', 'absent')).toBe('unreachable')
    expect(decide('503', '', 'absent')).toBe('unreachable')
  })

  it('does not treat an unrecognised answer as absence', () => {
    expect(decide('401', 'PGRST301', 'absent')).toBe('probe_rejected')
  })
})

describe('db-object-decision: an unreadable probe is its own outcome (#764)', () => {
  it('reports unreachable rather than ok when there is no HTTP status', () => {
    // Finding nothing must never read as success (LESSONS L98). This job runs
    // AFTER the deploy, so it is an alarm rather than a gate, and a database it
    // cannot reach at all is itself worth waking someone for.
    expect(decide('', '', 'denied')).toBe('unreachable')
    expect(decide('000', '', 'denied')).toBe('unreachable')
  })

  it('reports unreachable on a gateway error from the platform, not a missing object', () => {
    // A 502 from in front of PostgREST says nothing about whether the function
    // exists, so it must not be reported as missing.
    expect(decide('502', '', 'denied')).toBe('unreachable')
    expect(decide('503', '', 'denied')).toBe('unreachable')
    expect(decide('504', '', 'denied')).toBe('unreachable')
  })

  it('reports an unexpected shape distinctly instead of guessing', () => {
    // A 401 that is NOT a privilege error (a rejected apikey, say) means the
    // probe never reached the question. Claiming the grant is correct on that
    // basis would be a message claiming more than it measured (LESSONS L11).
    expect(decide('401', 'PGRST301', 'denied')).toBe('probe_rejected')
  })

  it('never exits non-zero itself, so the caller owns the verdict', () => {
    for (const args of [['401', '42501', 'denied'], ['404', 'PGRST202', 'denied'], ['', '', 'denied'], []]) {
      expect(() => execFileSync('bash', [scriptPath, ...args], { stdio: 'pipe' })).not.toThrow()
    }
  })

  it('prints exactly one word', () => {
    for (const args of [['401', '42501', 'denied'], ['200', '', 'denied'], ['', '', 'allowed'], ['401', '42501', 'absent'], ['404', 'PGRST202', 'absent']]) {
      const out = execFileSync('bash', [scriptPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(out.trim().split('\n')).toHaveLength(1)
      expect(['ok', 'missing', 'anon_can_execute', 'still_present', 'unreachable', 'probe_rejected']).toContain(out.trim())
    }
  })
})

// ── The manifest has to stay complete ────────────────────────────────────────

interface ManifestEntry {
  name: string
  args: Record<string, unknown>
  anon: 'denied' | 'allowed' | 'absent'
  reason?: string
  note?: string
}

function manifest(): ManifestEntry[] {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[]
}

/**
 * Every `.rpc('name')` in shipping source, which is what the app depends on.
 *
 * The walk goes through the shared `listFiles`, which knows which directories
 * hold tests. It used to carry its own copy of that list, and the copy went
 * stale the moment a second test directory existed: it read a fake client out of
 * a guard's own fixture and reported an RPC called `name` as a live dependency
 * (#502). One implementation, so there is nothing left to drift.
 */
function rpcsCalledByTheApp(): Set<string> {
  const found = new Set<string>()
  const roots = [path.join(REPO_ROOT, 'apps/worker/src'), path.join(REPO_ROOT, 'apps/web/src')]
  for (const root of roots) {
    for (const file of listFiles(root, { exts: ['.ts', '.tsx'] })) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\.rpc\(\s*['"`]([a-z0-9_]+)['"`]/gi)) found.add(m[1])
    }
  }
  return found
}

/**
 * One `.rpc('name', ...)` call in shipping source, with the argument names it
 * sends, or null when they cannot be read from the source (a variable, a spread,
 * a computed key). Read through the TypeScript parser rather than a pattern,
 * because the names sit inside an object literal that spans lines and can hold
 * nested objects of its own (#2930).
 */
interface RpcCall {
  name: string
  args: string[] | null
  at: string
}

function unwrapped(node: ts.Expression): ts.Expression {
  let n = node
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression
  return n
}

function argumentNames(arg: ts.Expression | undefined): string[] | null {
  if (arg === undefined) return []
  const obj = unwrapped(arg)
  if (!ts.isObjectLiteralExpression(obj)) return null
  const names: string[] = []
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p)) names.push(p.name.text)
    else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) names.push(p.name.text)
    else return null
  }
  return names
}

function rpcCallsIn(file: string, src: string): RpcCall[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
  const calls: RpcCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'rpc') {
      const [first, second] = node.arguments
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        calls.push({ name: first.text, args: argumentNames(second), at: `${path.relative(REPO_ROOT, file)}:${line}` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return calls
}

function rpcCallsByTheApp(): RpcCall[] {
  const roots = [path.join(REPO_ROOT, 'apps/worker/src'), path.join(REPO_ROOT, 'apps/web/src')]
  return roots.flatMap((root) => listFiles(root, { exts: ['.ts', '.tsx'] }).flatMap((f) => rpcCallsIn(f, readFileSync(f, 'utf8'))))
}

/**
 * Whether a call could be answered by an overload with these parameters.
 *
 * PostgREST picks an overload by the argument NAMES a call sends (its
 * `matchesParams` in src/library/PostgREST/Plan.hs, read 2026-10-28): a function
 * matches when the names sent, less its parameters that have a default, equal its
 * parameters without one. So a call can only reach an overload whose parameters
 * include every name it sends. An absent entry names that overload's parameters
 * but not which of them have defaults, so a call whose names are all among them
 * is taken as reaching it, and a call whose names cannot be read reaches any.
 */
function callCanReach(sent: string[] | null, params: string[]): boolean {
  return sent === null || sent.every((n) => params.includes(n))
}

/** Each absent entry the app could still call, keyed on the name plus the argument names (#2930). */
function absentButCalled(entries: ManifestEntry[], calls: RpcCall[]): string[] {
  return entries
    .filter((e) => e.anon === 'absent')
    .flatMap((e) => {
      const params = Object.keys(e.args)
      return calls
        .filter((c) => c.name === e.name && callCanReach(c.args, params))
        .map((c) => `${e.name}(${params.join(', ')}) is called at ${c.at}`)
    })
}

/** The parameter list of a function as a migration creates it: each name and whether it has a default. */
function createdParams(migration: string, fn: string): Array<{ name: string; hasDefault: boolean }> {
  const sql = readFileSync(path.join(REPO_ROOT, 'supabase/migrations', migration), 'utf8')
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i').exec(sql)
  if (!head) throw new Error(`${migration} does not create ${fn}`)
  const open = head.index + head[0].length - 1
  const list = sql.slice(open + 1, consumeParens(sql, open) - 1)
  return list.split(',').map((p) => p.trim()).filter(Boolean).map((p) => ({
    name: p.split(/\s+/)[0],
    hasDefault: /\bDEFAULT\b|=/i.test(p),
  }))
}

const SLACK_SAVE = 'save_slack_alert_settings'
// The four argument form #2896 dropped, and the five argument form the Worker calls.
const SLACK_SAVE_FOUR = '20261027170000_slack_alert_config_own_keys_2643.sql'
const SLACK_SAVE_FIVE = '20261027230000_slack_alert_settings_changed_by_2870.sql'

function absentEntry(name: string, args: string[]): ManifestEntry {
  return { name, args: Object.fromEntries(args.map((a) => [a, null])), anon: 'absent', note: 'planted by the test' }
}

describe('an absent entry is keyed on the overload, not the name alone (#2930)', () => {
  const calls = rpcCallsByTheApp()
  const four = createdParams(SLACK_SAVE_FOUR, SLACK_SAVE)
  const five = createdParams(SLACK_SAVE_FIVE, SLACK_SAVE)

  it('reads the migrations as four and five arguments, so the cases below are the real ones', () => {
    expect(four.map((p) => p.name)).toEqual(['p_organization_id', 'p_connection_id', 'p_settings', 'p_actor'])
    expect(five.map((p) => p.name)).toEqual([...four.map((p) => p.name), 'p_actor_email'])
  })

  it('finds every rpc the name scan finds, so keying on arguments drops no call', () => {
    const read = new Set(calls.map((c) => c.name))
    expect([...rpcsCalledByTheApp()].filter((n) => !read.has(n))).toEqual([])
  })

  it('reads the argument names the Worker sends to the Slack settings save', () => {
    const sent = calls.filter((c) => c.name === SLACK_SAVE).map((c) => c.args)
    expect(sent).toEqual([five.map((p) => p.name)])
  })

  it('refuses an absent entry for the overload the app calls', () => {
    const planted = absentEntry(SLACK_SAVE, five.map((p) => p.name))
    expect(absentButCalled([planted], calls)).toHaveLength(1)
  })

  it('accepts an absent entry for an overload of the same name that nothing calls', () => {
    const planted = absentEntry(SLACK_SAVE, four.map((p) => p.name))
    expect(absentButCalled([planted], calls)).toEqual([])
  })

  it("refuses when the call sends only some of the entry's names, since defaults could fill the rest", () => {
    const call: RpcCall = { name: 'f', args: ['p_a'], at: 'planted' }
    expect(absentButCalled([absentEntry('f', ['p_a', 'p_b'])], [call])).toHaveLength(1)
  })

  it("refuses when a call's argument names cannot be read", () => {
    const call: RpcCall = { name: 'f', args: null, at: 'planted' }
    expect(absentButCalled([absentEntry('f', ['p_a'])], [call])).toHaveLength(1)
  })

  it('reads a call passing a variable as unreadable, and a call with no arguments as sending none', () => {
    const src = "db.rpc('f', args)\ndb.rpc('g')\ndb.rpc('h', { p_a: 1, p_b } as X)\ndb.rpc('i', { ...base, p_a: 1 })\n"
    expect(rpcCallsIn('planted.ts', src).map((c) => [c.name, c.args])).toEqual([
      ['f', null],
      ['g', []],
      ['h', ['p_a', 'p_b']],
      ['i', null],
    ])
  })

  it('asserts the four argument Slack settings save absent, probed with exactly its own names', () => {
    // The probe has to send the dropped form's names: PostgREST answers PGRST202
    // to a call no overload matches, so a probe with any other names would report
    // an absence it never measured.
    const entries = manifest().filter((e) => e.name === SLACK_SAVE)
    expect(entries.map((e) => [e.anon, Object.keys(e.args)])).toEqual([
      ['denied', five.map((p) => p.name)],
      ['absent', four.map((p) => p.name)],
    ])
  })

  it('cannot have the four name probe answered by the five argument form', () => {
    // The five argument form matches a call only when every parameter without a
    // default is sent. p_actor_email has none, so a call sending the four names
    // misses it, and the probe can only be answered by a four argument form.
    const required = five.filter((p) => !p.hasDefault).map((p) => p.name)
    const probe = Object.keys(manifest().find((e) => e.name === SLACK_SAVE && e.anon === 'absent')?.args ?? {})
    expect(required).toContain('p_actor_email')
    expect(required.every((n) => probe.includes(n))).toBe(false)
  })
})

describe('the required-objects manifest is derived, not remembered (#764)', () => {
  it('finds the app RPC calls at all, so this cannot pass vacuously', () => {
    // A broken matcher would report an empty set and every completeness check
    // below would pass while covering nothing.
    const called = rpcsCalledByTheApp()
    expect(called.size).toBeGreaterThan(5)
    expect(called).toContain('is_allowlisted')
    expect(called).toContain('auth_user_with_allowlist')
  })

  it('lists every RPC the shipping code calls', () => {
    // The code-to-manifest direction, which is the one a hand-written registry
    // always gets wrong: the entries you remembered are the ones already safe
    // (LESSONS L96).
    const listed = new Set(manifest().map((e) => e.name))
    const missing = [...rpcsCalledByTheApp()].filter((n) => !listed.has(n))
    expect(missing, `these RPCs are called but not in ${path.basename(MANIFEST)}`).toEqual([])
  })

  it('never asserts an object is absent while the app still calls it', () => {
    // The two halves of the manifest can contradict each other, and this is the
    // shape it takes: a routine dropped as unsafe, then reached for again by
    // name from shipping code. The deploy would report it absent, which is true
    // and reads as a database fault rather than as the caller being wrong.
    // Keyed on the name plus the argument names a call sends, since that is how
    // PostgREST picks an overload, so a dropped overload of a function the app
    // still calls in another form can be asserted absent (#2930).
    expect(absentButCalled(manifest(), rpcCallsByTheApp()), 'the manifest says these must not exist, but the app calls them').toEqual([])
  })

  it('carries an argument shape for every entry, since an empty body reads as missing', () => {
    for (const e of manifest()) {
      expect(e.args, `${e.name} has no args object`).toBeDefined()
      expect(typeof e.args).toBe('object')
    }
  })

  it('states a reason for every entry that anon is allowed to call', () => {
    // An exemption with no stated reason is how a guard quietly stops guarding
    // (LESSONS L65).
    for (const e of manifest().filter((x) => x.anon === 'allowed')) {
      expect(e.reason?.length ?? 0, `${e.name} is anon-allowed with no reason`).toBeGreaterThan(20)
    }
  })

  it('only uses the expectations the decision script understands', () => {
    // Derived from the script rather than retyped here, because a vocabulary
    // maintained by hand beside its source drifts silently and the drift lands
    // in `probe_rejected`, which reads as a database problem (L41).
    const script = readFileSync(path.join(REPO_ROOT, '.github/scripts/db-object-decision.sh'), 'utf8')
    const understood = new Set(
      [...script.matchAll(/EXPECTED_ANON"\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]),
    )
    expect(understood, 'the script stopped naming its expectations the way this reads them').toEqual(
      new Set(['denied', 'allowed', 'absent']),
    )
    for (const e of manifest()) {
      expect([...understood], `${e.name} expects ${e.anon}`).toContain(e.anon)
    }
  })

  it('states why, for every entry asserted to be absent', () => {
    // An entry saying an object must NOT exist is a decision somebody will one
    // day want to reverse, and a bare name gives them nothing to weigh. Same
    // rule as the anon-allowed exemptions above (L65, L233).
    const absent = manifest().filter((e) => e.anon === 'absent')
    expect(absent.length, 'no absence assertions at all, so this check covers nothing').toBeGreaterThan(0)
    for (const e of absent) {
      expect(e.note?.length ?? 0, `${e.name} is asserted absent with no note saying why`).toBeGreaterThan(40)
    }
  })
})

describe('deploy.yml runs the live assertion after deploying (#764)', () => {
  function stripYamlComments(yml: string): string {
    return yml.split('\n').map((l) => {
      const m = /^(\s*)#/.exec(l)
      return m ? m[1] : l.replace(/\s+#.*$/, '')
    }).join('\n')
  }

  function jobBlock(name: string): string {
    const wf = stripYamlComments(readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'))
    const start = wf.search(new RegExp(`^  ${name}:$`, 'm'))
    expect(start, `deploy.yml has no job named ${name}`).toBeGreaterThan(-1)
    const rest = wf.slice(start + 1)
    const next = rest.search(/^ {2}[A-Za-z_][\w-]*:$/m)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('has a job that runs the assertion script', () => {
    expect(jobBlock('assert-db-objects')).toContain('assert-live-db-objects')
  })

  it('runs after the deploys, so it checks what actually shipped', () => {
    // Asserting before the deploy would measure the previous release.
    const job = jobBlock('assert-db-objects')
    expect(job).toMatch(/needs:\s*\[[^\]]*deploy-worker[^\]]*\]/)
    expect(job).toContain('always()')
  })

  it('reads the manifest rather than an inline list', () => {
    expect(jobBlock('assert-db-objects')).toContain('required-live-objects.json')
  })
})

describe('the assertion refuses a manifest it cannot read (#764)', () => {
  const assertScript = path.join(REPO_ROOT, '.github/scripts/assert-live-db-objects.sh')

  function runAgainst(contents: string): number {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dbobj-'))
    const file = path.join(dir, 'manifest.json')
    writeFileSync(file, contents)
    try {
      execFileSync('bash', [assertScript, file], {
        stdio: 'pipe',
        env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x' },
      })
      return 0
    } catch (e) {
      return (e as { status?: number }).status ?? -1
    }
  }

  it.each([
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an object rather than an array', '{}'],
    ['not JSON at all', 'not json at all'],
  ])('exits non-zero for %s rather than reporting success', (_label, contents) => {
    // A manifest that parses to nothing, or does not parse, must never read as a
    // clean pass. `jq length` prints `null` for some of these, and `[ "null" -lt 1 ]`
    // is a bash arithmetic ERROR rather than a false, which without this guard let
    // the loop run zero times and the script report success (LESSONS L50, L98).
    expect(runAgainst(contents)).not.toBe(0)
  })

  it('exits non-zero for a missing manifest file', () => {
    let code = 0
    try {
      execFileSync('bash', [assertScript, '/nonexistent/manifest.json'], {
        stdio: 'pipe',
        env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x' },
      })
    } catch (e) {
      code = (e as { status?: number }).status ?? -1
    }
    expect(code).not.toBe(0)
  })
})

describe('the assertion names the overload it probed (#2930)', () => {
  // Two entries can now share a function name, one present and one asserted
  // absent, so a line naming only the function would not say which form
  // answered. Run against a local server answering as the live database does
  // for a function that exists with anon refused.
  const assertScript = path.join(REPO_ROOT, '.github/scripts/assert-live-db-objects.sh')

  it('keeps each run\'s probe answers in a file of its own, never a fixed path', () => {
    // A fixed /tmp path is shared with every other run and user on the machine.
    // On the self hosted runner Mac one left by the runner user could not be
    // overwritten, so curl failed and that run's stale 42501 body was read as
    // this probe's answer. The test below caught it there; on a fresh Linux
    // runner it cannot, so the shape is held here as well.
    const code = readFileSync(assertScript, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).toMatch(/BODY=\$\(mktemp /)
    expect(code).not.toMatch(/-o \/tmp\//)
    expect(code).toContain('${http:-000}')
  })

  it('prints the argument names of a recreated overload in its verdict and its error', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: '42501' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dbobj-'))
    const file = path.join(dir, 'manifest.json')
    writeFileSync(file, JSON.stringify([absentEntry('f', ['p_a', 'p_b'])]))
    try {
      const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile('bash', [assertScript, file], {
          env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_ANON_KEY: 'x' },
        }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout }))
      })
      expect(result.code).toBe(1)
      expect(result.stdout).toMatch(/^f\(p_a, p_b\)\s+expect_anon=absent .*-> still_present$/m)
      expect(result.stdout).toContain('::error::f(p_a, p_b) answered a probe')
    } finally {
      server.close()
    }
  })
})
