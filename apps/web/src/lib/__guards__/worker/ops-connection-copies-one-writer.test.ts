/**
 * The committed copy arrives only by a serve of the committed row (#2335, PR 8
 * of phase 5 of #1689; findings F116 and F126).
 *
 * connection_copies is the ops Worker's last good copy of each connection, and
 * the bidding row is its one home (L83). Before F116 and F126 were fixed, the
 * plan had verify and Reconnect write the new generation into it before bidding
 * committed that generation, so a failed verify or a lost compare and set left
 * ops holding a credential the home never committed, and refusing every later
 * serve of the committed one as a lower generation. Now verify and clearReauth
 * hold a candidate in memory for one call, and the one writer is the minute
 * tick saving what the bidding Worker served (ops/connection-serve.ts).
 *
 * So the write (save_connection_copies, through ops-writes.ts's
 * saveConnectionCopies) may be named, outside comments, only where listed below
 * with its reason, and never by the connection modules or the OpsConnections
 * entrypoint. The behaviour is proven in
 * apps/worker/src/ops/connections/__tests__/reconnect-candidate.test.ts; this
 * keeps a later change from adding a second writer that test does not drive.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

const ALLOWED: Readonly<Record<string, string>> = {
  'apps/worker/src/ops/ops-writes.ts': 'the typed wrapper of save_connection_copies, the one .rpc( of it',
  'apps/worker/src/ops/ops-rpcs.ts': 'classifies save_connection_copies as a lane wide write',
  'apps/worker/src/ops/connection-serve.ts': 'the serve: saves the list the bidding Worker served of its committed rows',
  'apps/worker/src/ops/tick-live.ts': 'connects the minute tick\'s serve to the ops database',
}

/** Whether a source names the copy writer outside its comments. */
export function namesCopyWriter(source: string): boolean {
  const code = sanitizeSource(source, { blankStrings: false })
  return /\bsaveConnectionCopies\b|save_connection_copies/.test(code)
}

const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = listTsFiles(WORKER_SRC).map((full) => ({ rel: rel(full), source: readFileSync(full, 'utf8') }))

describe('the committed copy arrives only by a serve (F116, F126)', () => {
  it('scans the Worker\'s source, the connection modules and the entrypoint included (L98)', () => {
    expect(files.length).toBeGreaterThan(100)
    for (const f of ['apps/worker/src/ops/connections/ops-connections.ts', 'apps/worker/src/ops/ops-connections-entrypoint.ts', 'apps/worker/src/ops/ops-connections-live.ts']) {
      expect(files.some((x) => x.rel === f), f).toBe(true)
    }
  })

  it('no module but the listed ones names the copy writer', () => {
    expect(files.filter((f) => !Object.hasOwn(ALLOWED, f.rel) && namesCopyWriter(f.source)).map((f) => f.rel)).toEqual([])
  })

  it('every listed module exists, names it, and says why it may', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      const full = path.join(REPO_ROOT, file)
      expect(existsSync(full), `${file} is listed and does not exist`).toBe(true)
      expect(namesCopyWriter(readFileSync(full, 'utf8')), `${file} is listed and no longer names the copy writer`).toBe(true)
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it('sees a planted writer, and not one named in a comment (seen red)', () => {
    expect(namesCopyWriter('await deps.saveConnectionCopies(servedAt, false, [candidate])')).toBe(true)
    expect(namesCopyWriter('await callOpsRpc(client, \'save_connection_copies\', {})')).toBe(true)
    expect(namesCopyWriter('// never saveConnectionCopies here\nconst x = 1')).toBe(false)
  })
})
