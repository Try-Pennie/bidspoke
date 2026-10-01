/**
 * Derives one Pipedream workflow's capture key from the master secret (#1705).
 *
 *   pbpaste | node scripts/porting/derive-capture-key.ts p_XXXXXXX
 *
 * Reads PORTING_CAPTURE_MASTER from stdin (copy it from 1Password first), and
 * puts the derived key on the clipboard for pasting into Pipedream as the
 * environment variable `PORTING_KEY_<hashid>`. The key is never printed, so it
 * cannot land in a terminal transcript or shell history. The receiver derives
 * the same key with the same function (packages/porting-evidence).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { deriveWorkflowKey } from '../../packages/porting-evidence/src/signature.ts'
import { keyEnvName } from '../../packages/porting-evidence/src/instrument/capture-source.ts'

const hashid = process.argv[2]
if (!hashid || !/^p_[A-Za-z0-9]+$/.test(hashid)) {
  process.stderr.write('usage: pbpaste | node scripts/porting/derive-capture-key.ts p_<hashid>\n')
  process.exit(1)
}
const master = readFileSync(0, 'utf8').trim()
if (!master) {
  process.stderr.write('no master secret on stdin\n')
  process.exit(1)
}
const key = await deriveWorkflowKey(master, hashid)
execFileSync('pbcopy', { input: key })
process.stdout.write(`Key for ${hashid} is on the clipboard. Paste it into Pipedream as ${keyEnvName(hashid)}, then clear the clipboard.\n`)
