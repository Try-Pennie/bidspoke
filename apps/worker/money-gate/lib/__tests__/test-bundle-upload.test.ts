/**
 * Reading the script out of the engine's test bundle upload (#1730).
 *
 * The gate answers deployTestCodeBundle's Cloudflare upload locally and hosts
 * what it uploaded. The script is found the way Cloudflare finds it: the part
 * the upload's own metadata names as main_module. An upload that does not carry
 * it must fail by name, never as a TypeError reading a missing part.
 */
import { describe, it, expect } from 'vitest'
import { scriptFromUpload } from '../test-bundle-upload'

function upload(parts: Record<string, string | Blob>): FormData {
  const form = new FormData()
  for (const [name, value] of Object.entries(parts)) {
    if (typeof value === 'string') form.append(name, value)
    else form.append(name, value, name)
  }
  return form
}

const module = (text: string) => new Blob([text], { type: 'application/javascript+module' })

describe('scriptFromUpload', () => {
  it('returns the part the metadata names as main_module, as the engine uploads it today', async () => {
    const form = upload({ metadata: JSON.stringify({ main_module: 'script.js' }), 'script.js': module('export default {}') })
    expect(await scriptFromUpload(form)).toEqual({ script: 'export default {}' })
  })

  it('follows a renamed main module rather than assuming script.js', async () => {
    const form = upload({ metadata: JSON.stringify({ main_module: 'bundle.mjs' }), 'bundle.mjs': module('export default 1') })
    expect(await scriptFromUpload(form)).toEqual({ script: 'export default 1' })
  })

  it('names the part when the main module the metadata names was not uploaded', async () => {
    const form = upload({ metadata: JSON.stringify({ main_module: 'script.js' }), 'other.js': module('x') })
    expect(await scriptFromUpload(form)).toEqual({ problem: 'the upload has no "script.js" part, which its metadata names as main_module' })
  })

  it('names a missing metadata part', async () => {
    expect(await scriptFromUpload(upload({ 'script.js': module('x') }))).toEqual({ problem: 'the upload has no metadata part, so its main module cannot be found' })
  })

  it('names metadata that does not parse or names no main module', async () => {
    expect(await scriptFromUpload(upload({ metadata: '{ nope', 'script.js': module('x') }))).toEqual({ problem: 'the upload metadata is not JSON naming a main_module' })
    expect(await scriptFromUpload(upload({ metadata: JSON.stringify({ body_part: 'script.js' }), 'script.js': module('x') }))).toEqual({ problem: 'the upload metadata is not JSON naming a main_module' })
  })
})
