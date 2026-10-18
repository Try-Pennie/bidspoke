import { beforeAll, describe, expect, it } from 'vitest'
import { RESTORE_DRILL_CANARY, restoreDrillAad, seal } from '../index'
import { KEYGEN_TIMEOUT_MS, rsaPair, type PemPair } from './fixtures'
import { runRestoreDrill, type DrillIo } from '../../../../scripts/restore-drill/open-seal-canary'

/**
 * scripts/restore-drill/open-seal-canary.ts, the laptop half of the ops key
 * restore drill (#2333). It opens an envelope POST /api/admin/seal-canary
 * returned with the escrowed private key piped in on stdin, and says whether it
 * opened to the canary.
 *
 * What matters beyond pass and fail: the key comes from stdin and nowhere else,
 * and nothing the script prints carries the key or what the envelope opened to,
 * since a drill transcript is pasted into issues and docs.
 */

const KID = 'ops-2026-10'
let pair: PemPair
let other: PemPair
let drillId: string
let canaryResponse: string
let bareEnvelope: string
let wrongText: string

beforeAll(async () => {
  ;[pair, other] = await Promise.all([rsaPair(4096), rsaPair(4096)])
  const ring = { [KID]: pair.publicPem }
  const envelope = await seal(ring, RESTORE_DRILL_CANARY, restoreDrillAad(KID))
  // The route's whole answer, as saved from the response.
  drillId = crypto.randomUUID()
  canaryResponse = JSON.stringify({ drill_id: drillId, kid: KID, envelope, audited: true })
  bareEnvelope = JSON.stringify(envelope)
  wrongText = JSON.stringify(await seal(ring, 'some other planted text 2333', restoreDrillAad(KID)))
}, KEYGEN_TIMEOUT_MS)

function io(overrides: Partial<DrillIo> = {}, files: Record<string, string> = {}): DrillIo {
  return {
    argv: ['canary.json'],
    stdin: () => pair.privatePem,
    stdinIsTty: false,
    readFile: (path: string) => {
      if (path === 'canary.json') return files['canary.json'] ?? canaryResponse
      if (Object.hasOwn(files, path)) return files[path]
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
    },
    ...overrides,
  }
}

/** Nothing printed may carry key material or the text the envelope held. */
function expectClean(line: string) {
  expect(line).not.toContain('PRIVATE KEY')
  for (const chunk of pair.privatePem.split('\n').filter((l) => l.length > 20)) expect(line).not.toContain(chunk)
  expect(line).not.toContain(RESTORE_DRILL_CANARY)
  expect(line).not.toContain('some other planted text 2333')
  expect(line.split('\n').filter(Boolean)).toHaveLength(1)
}

describe('the restore drill script (#2333)', () => {
  it('passes when the key on stdin opens the route\'s answer to the canary, naming the kid and the drill id', async () => {
    const r = await runRestoreDrill(io())
    expect(r.exitCode).toBe(0)
    expect(r.line).toMatch(/^PASS: /)
    expect(r.line).toContain(KID)
    expect(r.line).toContain(drillId)
    expectClean(r.line)
  })

  it('takes a bare envelope as well as the route\'s whole answer', async () => {
    const r = await runRestoreDrill(io({}, { 'canary.json': bareEnvelope }))
    expect(r.exitCode).toBe(0)
    expectClean(r.line)
  })

  it('fails by the seal\'s reason when the key on stdin is a different key', async () => {
    const r = await runRestoreDrill(io({ stdin: () => other.privatePem }))
    expect(r.exitCode).toBe(1)
    expect(r.line).toMatch(/^FAIL: .*seal_unwrap_failed/)
    expectClean(r.line)
    for (const chunk of other.privatePem.split('\n').filter((l) => l.length > 20)) expect(r.line).not.toContain(chunk)
  })

  it('fails without printing it when the envelope opens to something other than the canary', async () => {
    const r = await runRestoreDrill(io({}, { 'canary.json': wrongText }))
    expect(r.exitCode).toBe(1)
    expect(r.line).toMatch(/^FAIL: .*not the canary/)
    expectClean(r.line)
  })

  it('fails by name when stdin holds something that is not a private key', async () => {
    const r = await runRestoreDrill(io({ stdin: () => pair.publicPem }))
    expect(r.exitCode).toBe(1)
    expect(r.line).toMatch(/^FAIL: .*seal_key_/)
    expectClean(r.line)
  })

  it('refuses to wait on a terminal, so the key is never typed or echoed', async () => {
    let read = false
    const r = await runRestoreDrill(io({ stdinIsTty: true, stdin: () => { read = true; return '' } }))
    expect(r.exitCode).toBe(2)
    expect(r.line).toMatch(/pipe/)
    expect(read).toBe(false)
  })

  it('refuses an empty stdin', async () => {
    const r = await runRestoreDrill(io({ stdin: () => '  \n' }))
    expect(r.exitCode).toBe(2)
    expect(r.line).toMatch(/stdin/)
  })

  it('refuses a key on the command line without echoing it, and never reads one from a path', async () => {
    let read = false
    const r = await runRestoreDrill(io({ argv: [pair.privatePem], stdin: () => { read = true; return pair.privatePem } }))
    expect(r.exitCode).toBe(2)
    expectClean(r.line)
    expect(read).toBe(false)

    // A path to the key file is just a file that is not an envelope: refused, its contents never printed.
    const viaPath = await runRestoreDrill(io({ argv: ['key.pem'] }, { 'key.pem': pair.privatePem }))
    expect(viaPath.exitCode).toBe(2)
    expectClean(viaPath.line)
  })

  it('refuses a missing argument, an extra one, an unreadable file and a file that is not an envelope', async () => {
    for (const argv of [[], ['canary.json', 'extra']]) {
      const r = await runRestoreDrill(io({ argv }))
      expect(r.exitCode, JSON.stringify(argv)).toBe(2)
      expect(r.line).toMatch(/usage/)
    }
    const missing = await runRestoreDrill(io({ argv: ['nope.json'] }))
    expect(missing.exitCode).toBe(2)
    expect(missing.line).toContain('nope.json')
    for (const bad of ['not json', '{"drill_id":"x"}', '[]']) {
      const r = await runRestoreDrill(io({}, { 'canary.json': bad }))
      expect(r.exitCode, bad).toBe(2)
    }
  })
})
