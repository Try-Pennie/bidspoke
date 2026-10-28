import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every entry in the incident registry (apps/worker/src/lib/incident-signals.ts,
 * #2099) is armed by some check.
 *
 * The compiler holds the other direction: the recovery functions take the
 * registry's type, so a check cannot arm a prefix the registry does not name.
 * Nothing in the type system notices an entry whose check was deleted, and a
 * dead entry would be offered to the dashboard as a signal that can never
 * appear.
 *
 * The signal's words appearing somewhere is not enough: most of them are also
 * an alert key or a log tag. So a signal counts as armed only where a file
 * passes it as the signal of a call that arms a marker (markAlerted or
 * keepAlerted), or opens an incident on a marker the check keeps in its own
 * state (a writeIncidentEvent of type 'opened', the cron heartbeat, #2103),
 * either as the literal itself, as a constant that same file declares equal to
 * it, or (the field presence tiers) as a tier's `prefix:` in a file whose
 * arming calls take `cfg.prefix`. A connection check arms through the shared
 * bookkeeping in lib/standing-connection-incidents.ts, a daily one through
 * settleStandingConnections (#2761) and a minute one through
 * settleConnectionIncidents (#2947), so the `signal:` it passes there counts,
 * once that helper is itself seen to arm a marker with the signal it is given.
 */
const REGISTRY = path.join(WORKER_SRC, 'lib', 'incident-signals.ts')

const registered = [...readFileSync(REGISTRY, 'utf8').matchAll(/signal: '([a-z-]+)'/g)].map((m) => m[1])

const files = listTsFiles(WORKER_SRC)
  .filter((full) => full !== REGISTRY && !full.replace(/\\/g, '/').includes('/__tests__/'))
  .map((full) => sanitizeSource(readFileSync(full, 'utf8'), { blankStrings: false }))

/** The signal of every arming call in `src`, as written. */
function armedArgs(src: string): string[] {
  const recovery = [...src.matchAll(/\b(?:markAlerted|keepAlerted)\(\s*[\w.]+\s*,\s*([\w.]+|'[^']*')/g)].map((m) => m[1])
  const opened = [...src.matchAll(/\bwriteIncidentEvent\(\s*[\w.]+\s*,\s*\{\s*type:\s*'opened',\s*signal:\s*([\w.]+|'[^']*')/g)].map((m) => m[1])
  const standing = [...src.matchAll(/\b(?:settleStandingConnections|settleConnectionIncidents)\(\{[^}]*?\bsignal:\s*([\w.]+|'[^']*')/g)].map((m) => m[1])
  return [...recovery, ...opened, ...standing]
}

const STANDING = path.join(WORKER_SRC, 'lib', 'standing-connection-incidents.ts')

function armedIn(src: string, signal: string): boolean {
  const args = armedArgs(src)
  if (args.includes(`'${signal}'`)) return true
  const constants = [...src.matchAll(new RegExp(`\\b(?:const|let)\\s+(\\w+)(?:\\s*:[^=]+)?\\s*=\\s*'${signal}'`, 'g'))].map((m) => m[1])
  if (constants.some((c) => args.includes(c))) return true
  return args.includes('cfg.prefix') && new RegExp(`\\bprefix:\\s*'${signal}'`).test(src)
}

describe('incident registry entries are armed', () => {
  it('reads the registry', () => {
    expect(registered.length).toBe(29)
  })

  it('counts a signal passed to settleStandingConnections or settleConnectionIncidents only because that helper arms a marker with it', () => {
    const helper = sanitizeSource(readFileSync(STANDING, 'utf8'), { blankStrings: false })
    expect(helper).toMatch(/\bmarkAlerted\(\s*kv\s*,\s*signal\s*,/)
    // The daily form reaches the arming only through the shared core.
    expect(helper).toMatch(/\bfunction settleStandingConnections\([\s\S]*?\breturn settleConnectionIncidents</)
    expect(armedIn(`const S = 'http-money-host'\nawait settleStandingConnections({\n  kv: deps.kv,\n  signal: S,\n  stateKey: K,\n})`, 'http-money-host')).toBe(true)
    expect(armedIn(`const S = 'ops-connection-login'\nsettle: (o) => settleConnectionIncidents({ signal: S, ...o })`, 'ops-connection-login')).toBe(true)
    expect(armedIn(`const S = 'http-money-host'\nawait somethingElse({ signal: S })`, 'http-money-host')).toBe(false)
  })

  it.each(registered)('%s is armed by a marker call outside the registry', (signal) => {
    expect(files.some((src) => armedIn(src, signal)), `${signal} is registered but no check arms a marker with it`).toBe(true)
  })

  it('does not count a signal named only as an alert key or a log tag', () => {
    expect(armedIn(`const key = 'volume-cliff:cooldown'\nconsole.log('[volume-cliff] tick')\nawait markAlerted(kv, OTHER, id, ctx)`, 'volume-cliff')).toBe(false)
    expect(armedIn(`const P = 'volume-cliff'\nawait markAlerted(kv, P, id, ctx)`, 'volume-cliff')).toBe(true)
  })

  it('counts an incident opened on a check\'s own marker, and not one only paged or ended', () => {
    expect(armedIn(`const S = 'cron-heartbeat'\nawait writeIncidentEvent(kv, { type: 'opened', signal: S, subject: id, startedAt }, ctx, now)`, 'cron-heartbeat')).toBe(true)
    expect(armedIn(`const S = 'cron-heartbeat'\nawait writeIncidentEvent(kv, { type: 'paged', signal: S, subject: id, startedAt }, ctx, now)`, 'cron-heartbeat')).toBe(false)
  })
})
