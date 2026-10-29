import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inventoryCredentials } from '../credentials.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function devVars(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-vars-'))
  dirs.push(dir)
  const file = path.join(dir, '.dev.vars')
  writeFileSync(file, text)
  return file
}

describe('inventoryCredentials (#1695)', () => {
  it('takes both values from the environment first, dropping a trailing slash on the address', () => {
    const file = devVars('SUPABASE_URL=https://other.example\nSUPABASE_SECRET_KEY=other\n')
    expect(inventoryCredentials({ SUPABASE_URL: 'https://db.example/', SUPABASE_SECRET_KEY: 'k' }, file)).toEqual({ url: 'https://db.example', key: 'k' })
  })

  it('falls back to the dev vars file for whatever the environment lacks, unquoting values', () => {
    const file = devVars('# comment\nSUPABASE_URL = "https://db.example"\nSUPABASE_SECRET_KEY=\'k2\'\n')
    expect(inventoryCredentials({}, file)).toEqual({ url: 'https://db.example', key: 'k2' })
    expect(inventoryCredentials({ SUPABASE_SECRET_KEY: 'env' }, file)).toEqual({ url: 'https://db.example', key: 'env' })
  })

  it('throws naming both settings, and no value, when either is missing', () => {
    const file = devVars('SUPABASE_URL=https://db.example\n')
    expect(() => inventoryCredentials({}, file)).toThrow(/SUPABASE_URL and SUPABASE_SECRET_KEY are required/)
    expect(() => inventoryCredentials({}, path.join(tmpdir(), 'no-such-dir-1695', '.dev.vars'))).toThrow(/required/)
  })
})
