import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * One sha256 for both kinds of runner (#2768).
 *
 * The worker artifact gate, the deploy drift check and the config hash all
 * printed `sha256sum`, which is GNU coreutils: a Mac runner may not have it on
 * its PATH, and a hash that comes back empty reads to the artifact gate as "no
 * comparison happened". The script uses sha256sum where it exists and macOS's
 * `shasum -a 256` otherwise, and each path is run here on its own.
 */
const script = path.join(REPO_ROOT, '.github/scripts/sha256.sh')
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

function which(tool: string): string | null {
  for (const dir of ['/usr/bin', '/bin', '/sbin', '/usr/sbin', '/opt/homebrew/bin', '/usr/local/bin']) {
    if (existsSync(path.join(dir, tool))) return path.join(dir, tool)
  }
  return null
}

/** Run the script with a PATH holding only the named tool. */
function run(tool: string, args: string[], input?: string) {
  const bin = mkdtempSync(path.join(tmpdir(), 'sha256-bin-'))
  const real = which(tool)
  if (real) symlinkSync(real, path.join(bin, tool))
  const res = spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', input, env: { ...process.env, PATH: bin } })
  return { out: (res.stdout ?? '').trim(), status: res.status, err: (res.stderr ?? '').trim() }
}

const file = path.join(mkdtempSync(path.join(tmpdir(), 'sha256-in-')), 'abc.txt')
writeFileSync(file, 'abc')

describe('sha256.sh', () => {
  it.skipIf(which('sha256sum') === null)('hashes a file with sha256sum', () => {
    expect(run('sha256sum', [file])).toEqual({ out: ABC, status: 0, err: '' })
  })

  it.skipIf(which('shasum') === null)('hashes a file with shasum when sha256sum is absent', () => {
    expect(run('shasum', [file])).toEqual({ out: ABC, status: 0, err: '' })
  })

  it.skipIf(which('shasum') === null)('hashes standard input', () => {
    expect(run('shasum', [], 'abc').out).toBe(ABC)
  })

  it('fails and prints nothing when the file cannot be read', () => {
    const r = run('shasum', [path.join(tmpdir(), 'no-such-file-2768')])
    expect(r.status).not.toBe(0)
    expect(r.out).toBe('')
  })

  it('fails and prints nothing when neither tool exists', () => {
    const r = run('no-hasher', [file])
    expect(r.status).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/neither sha256sum nor shasum/)
  })
})
