/**
 * The script inside the engine's test bundle upload (#1730).
 *
 * deployTestCodeBundle uploads a multipart form to Cloudflare: a `metadata` part
 * naming the `main_module`, and the module itself under that name. The gate
 * answers the upload locally and hosts what was uploaded, so it finds the script
 * the way Cloudflare does, through the metadata, rather than assuming the part
 * name the engine happens to use today. An upload that does not carry it is a
 * named problem, never a TypeError reading a part that is not there.
 */

export async function scriptFromUpload(form: FormData): Promise<{ script: string } | { problem: string }> {
  const meta = form.get('metadata')
  if (meta === null) return { problem: 'the upload has no metadata part, so its main module cannot be found' }
  let mainModule: unknown
  try {
    mainModule = (JSON.parse(typeof meta === 'string' ? meta : await meta.text()) as { main_module?: unknown }).main_module
  } catch {
    mainModule = undefined
  }
  if (typeof mainModule !== 'string' || mainModule.length === 0) return { problem: 'the upload metadata is not JSON naming a main_module' }
  const part = form.get(mainModule)
  if (part === null) return { problem: `the upload has no "${mainModule}" part, which its metadata names as main_module` }
  return { script: typeof part === 'string' ? part : await part.text() }
}
