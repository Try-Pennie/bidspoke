/**
 * The laptop half of the ops key restore drill (#2333, phase 3 of #1689).
 *
 * Opens an envelope that POST /api/admin/seal-canary returned with the escrowed
 * copy of an ops private key, and says whether it opened to the canary. A pass
 * proves the 1Password copy opens what production seals, before any real ops
 * login depends on it (L535, L1). Steps: docs/disaster-recovery.md, Drills.
 *
 *   op read "op://<vault>/Bidspoke recovery keys/ops-connections-private.pem" \
 *     | npx tsx scripts/restore-drill/open-seal-canary.ts seal-canary.json
 *
 * The argument is the file holding the route's answer (or the bare envelope).
 * The PRIVATE KEY COMES FROM STDIN ONLY: never from an argument, which shell
 * history and the process list keep, and never from a path, which leaves the
 * key in a file. A terminal on stdin is refused rather than waited on, so the
 * key is never typed and echoed. It prints ONE line, PASS or FAIL with the
 * seal's reason, and never the key or what the envelope opened to.
 *
 * It calls `open`, so it is on the closed list of openers in
 * apps/web/src/lib/__guards__/worker/connection-seal-open-callers.test.ts.
 * Exit 0 on a pass, 1 when the envelope did not open to the canary, 2 when the
 * drill could not be run as asked.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { KID_PATTERN, open, RESTORE_DRILL_CANARY, restoreDrillAad, SealError } from '../../packages/connection-seal/src/index'

export interface DrillIo {
  /** The arguments after the script's own path. */
  argv: string[]
  /** Reads all of stdin. Called only once every other check has passed. */
  stdin: () => string
  stdinIsTty: boolean
  readFile: (path: string) => string
}

export interface DrillResult {
  exitCode: 0 | 1 | 2
  line: string
}

const USAGE = 'usage: op read "op://<vault>/Bidspoke recovery keys/ops-connections-private.pem" | npx tsx scripts/restore-drill/open-seal-canary.ts <seal-canary.json>'

const cannot = (why: string): DrillResult => ({ exitCode: 2, line: `CANNOT RUN: ${why}` })

/** The envelope inside the route's answer, or the answer itself when it is a bare envelope. */
function envelopeFrom(text: string): { envelope: Record<string, unknown>; drillId: string | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const inner = record.envelope
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
    return { envelope: inner as Record<string, unknown>, drillId: typeof record.drill_id === 'string' ? record.drill_id : null }
  }
  return 'v' in record && 'kid' in record ? { envelope: record, drillId: null } : null
}

export async function runRestoreDrill(io: DrillIo): Promise<DrillResult> {
  if (io.argv.some((arg) => /-----BEGIN|PRIVATE KEY/.test(arg))) {
    return cannot('a key was given on the command line, and it is read only from stdin. Pipe it in, and clear it from your shell history')
  }
  if (io.argv.length !== 1) return cannot(USAGE)
  if (io.stdinIsTty) return cannot(`pipe the private key in on stdin rather than typing it. ${USAGE}`)

  const path = io.argv[0]
  let text: string
  try {
    text = io.readFile(path)
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'unreadable'
    return cannot(`could not read ${path} (${code})`)
  }
  const found = envelopeFrom(text)
  if (!found) return cannot(`${path} holds neither the seal-canary answer nor an envelope`)
  const kid = found.envelope.kid
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) return cannot(`the envelope in ${path} names no kid`)

  const key = io.stdin().trim()
  if (!key) return cannot(`nothing arrived on stdin. ${USAGE}`)

  const drill = found.drillId ? ` (drill ${found.drillId})` : ''
  let opened: string
  try {
    opened = await open({ [kid]: key }, found.envelope, restoreDrillAad(kid))
  } catch (err) {
    // A SealError's message carries kids, field names and sizes only (errors.ts).
    const reason = err instanceof SealError ? err.message : `an unexpected ${err instanceof Error ? err.name : typeof err}`
    return { exitCode: 1, line: `FAIL: the private key on stdin did not open the canary sealed under kid ${kid}${drill}: ${reason}` }
  }
  if (opened !== RESTORE_DRILL_CANARY) {
    return { exitCode: 1, line: `FAIL: the envelope opened under kid ${kid}${drill}, but to text that is not the canary` }
  }
  return { exitCode: 0, line: `PASS: the private key on stdin opened the canary sealed under kid ${kid}${drill}` }
}

const runDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (runDirectly) {
  const result = await runRestoreDrill({
    argv: process.argv.slice(2),
    stdin: () => readFileSync(0, 'utf8'),
    stdinIsTty: process.stdin.isTTY === true,
    readFile: (p) => readFileSync(p, 'utf8'),
  })
  ;(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.line}\n`)
  process.exitCode = result.exitCode
}
