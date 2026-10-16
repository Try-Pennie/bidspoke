/**
 * The partner click URL's readers outside workflows (#2142), pinned against the
 * code: every Worker source file naming `click_url` is either one of
 * CLICK_URL_READERS_OUTSIDE_WORKFLOWS (shown on the partners page beside the
 * workflows that read the value) or here with the reason it is not one. A new
 * file reading the field fails until it is classified.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'
import { CLICK_URL_READERS_OUTSIDE_WORKFLOWS } from '../../../../../worker/src/lib/workflow-values-shape'

const SRC = WORKER_SRC

const NOT_READERS: Record<string, string> = {
  'lib/buyer-profile-loader.ts': 'the loader the buyer_select and buyer_click_check readers get the URL through',
  'lib/partner-constants-loader.ts': 'builds the Constants node value that the workflow scan covers',
  'routes/api/partners.ts': 'the partner editor that saves the URL',
  'routes/api/buyer-profiles.ts': 'the buyer profile editor, which refuses enabling a buyer with no URL',
  'types/database.ts': 'generated column types',
  'routes/api/partner-workflow-values.ts': 'the workflow values tab, which shows the URL and this list',
  'engine/scripts/engine-bidding/build_response_body.js': 'a mirror of a Code node: a workflow, which the scan covers',
  'engine/scripts/engine-bidding/tripoint_ping.js': 'a mirror of a Code node: a workflow, which the scan covers',
  'engine/scripts/engine-bidding/patch_prospect_body.js': 'a mirror of a Code node: a workflow, which the scan covers',
  'engine/scripts/lead-economy/return_response.js': 'a mirror of a Code node: a workflow, which the scan covers',
  'engine/scripts/rml-gigfi/build_response.js': 'a mirror of a Code node: a workflow, which the scan covers',
  'engine/scripts/rml-lendswift/build_response.js': 'a mirror of a Code node: a workflow, which the scan covers',
  'engine/scripts/bidding-lendswift/build_response.js': 'a mirror of a Code node: a workflow, which the scan covers',
}

/** Every Worker source file, the Code node mirrors (.js) included, tests and declarations left out. */
const sourceFiles = (dir: string) => listFiles(dir, { exts: ['.ts', '.js'] }).filter((f) => !f.endsWith('.d.ts'))

describe('click URL readers outside workflows', () => {
  const naming = sourceFiles(SRC)
    .filter((f) => readFileSync(f, 'utf8').includes('click_url'))
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .sort()

  it('scanned the tree and found the known readers (a positive control)', () => {
    expect(naming).toContain('engine/nodes/buyer-select.ts')
    expect(naming.length).toBeGreaterThan(5)
  })

  it('every file naming click_url is a listed reader or a classified non reader', () => {
    const readers = new Set<string>(CLICK_URL_READERS_OUTSIDE_WORKFLOWS.map((r) => r.file))
    expect(naming.filter((f) => !readers.has(f) && !(f in NOT_READERS))).toEqual([])
  })

  it('every listed reader and non reader still names it', () => {
    const listed = [...CLICK_URL_READERS_OUTSIDE_WORKFLOWS.map((r) => r.file), ...Object.keys(NOT_READERS)]
    expect(listed.filter((f) => !naming.includes(f))).toEqual([])
  })
})
