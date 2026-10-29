import { describe, expect, it } from 'vitest'
import { convertExport, type ConvertResult, type Draft } from '../index.ts'
import { EXPORTED_AT, EXPORT_DIR, PROJECT, fileSha, recordedRow } from './fixture.ts'

function draftOf(result: ConvertResult): Draft {
  if (!result.ok) throw new Error(`refused: ${result.reason}: ${result.message}`)
  return result.draft
}

describe('convertExport: a workflow becomes a draft listing its steps (#1695, 9.1)', () => {
  const draft = draftOf(convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead')))

  it('carries the workflow identity', () => {
    expect(draft.workflow).toEqual({ hashid: 'p_Fx1Lead', name: 'Demo lead intake', projectHashid: PROJECT, pipedreamState: 'on' })
  })

  it('lists every step in order, the main pipeline first and then each deployment, with its kind, uses key and version', () => {
    expect(draft.steps.map((s) => [s.pipeline, s.namespace, s.kind, s.uses, s.disabled])).toEqual([
      ['main', 'normalize', 'code', null, false],
      ['main', 'broken_step', 'code', null, false],
      ['main', 'send_request', 'registry', { key: 'http-custom-request', version: '0.0.2' }, false],
      ['main', 'shared_helper', 'private_component', { key: 'demo-private-helper', version: '0.0.3' }, false],
      ['main', 'branch_on_score', 'control_flow', null, false],
      ['main', 'return_response', 'registry', { key: 'http-return-http-response', version: '0.0.6' }, false],
      ['main', 'old_note', 'unrecognised', null, true],
      ['d_Fx1Else', 'wait_a_bit', 'registry', { key: 'delay-workflow-delay', version: '0.0.2' }, false],
    ])
  })

  it('parses every step whose code is its own, and says whether it parsed', () => {
    expect(Object.fromEntries(draft.steps.map((s) => [s.namespace, s.parsed]))).toEqual({
      normalize: true,
      broken_step: false,
      send_request: null,
      shared_helper: true,
      branch_on_score: null,
      return_response: null,
      old_note: null,
      wait_a_bit: null,
    })
  })

  it('names a code step that does not parse, with its line, rather than dropping it', () => {
    const named = draft.unconverted.filter((u) => u.where === 'main/broken_step')
    expect(named.map((u) => u.reason)).toEqual(['unparseable_code'])
    expect(named[0].detail).toMatch(/^does not parse at line 4: /)
  })

  it('names a step it cannot recognise', () => {
    expect(draft.unconverted).toContainEqual({ where: 'main/old_note', reason: 'unrecognised_step', detail: 'has no uses, only code_raw' })
    expect(draft.unconverted).toHaveLength(2)
  })

  it('lists the triggers with their type', () => {
    expect(draft.triggers).toEqual([{ index: 0, type: 'http', disabled: false, uses: null }])
  })

  it('never carries code or prop values, only names, so printing it shows no partner data', () => {
    const text = JSON.stringify(draft)
    expect(text).not.toContain('defineComponent')
    expect(text).not.toContain('redacted')
    expect(text).not.toContain('delayDurationUnits')
  })
})

describe('convertExport: triggers (#1695, 9.1)', () => {
  it('records a registry trigger by its key and version, and names one of a type it does not know', () => {
    const draft = draftOf(convertExport(EXPORT_DIR, 'p_Fx2Daily', recordedRow('p_Fx2Daily')))
    expect(draft.triggers).toEqual([
      { index: 0, type: 'timer', disabled: false, uses: null },
      { index: 1, type: 'source', disabled: false, uses: { key: 'demo_sheets-new-row', version: '0.1.0' } },
      { index: 2, type: 'carrier_pigeon', disabled: true, uses: null },
    ])
    expect(draft.unconverted).toEqual([{ where: 'trigger 2', reason: 'unrecognised_trigger', detail: 'type carrier_pigeon' }])
  })
})

describe('convertExport: the newest recorded snapshot only (#1695, Hard Rule 7)', () => {
  it('stamps the snapshot hash and export time on the draft', () => {
    const draft = draftOf(convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead')))
    expect(draft.snapshot).toEqual({
      sha256: fileSha('p_Fx1Lead'),
      exportedAt: EXPORTED_AT,
      file: `project_export-${PROJECT}/p_fx1lead-p_Fx1Lead.json`,
    })
  })

  it('refuses by name an export older than the newest recorded for the workflow', () => {
    const result = convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead', { last_seen_export_at: '2026-10-20T12:00:00Z', definition_sha256: 'a'.repeat(64) }))
    expect(result).toMatchObject({ ok: false, reason: 'snapshot_older_than_recorded' })
    expect(!result.ok && result.message).toMatch(/^p_Fx1Lead: .*2026-09-30T19:26:13Z.*older than.*2026-10-20T12:00:00Z/)
  })

  it('refuses a workflow the inventory has no record of', () => {
    expect(convertExport(EXPORT_DIR, 'p_Fx1Lead', null)).toMatchObject({ ok: false, reason: 'snapshot_not_recorded' })
  })

  it('refuses an export newer than the one recorded, until the inventory records it', () => {
    const result = convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead', { last_seen_export_at: '2026-09-01T00:00:00Z' }))
    expect(result).toMatchObject({ ok: false, reason: 'snapshot_newer_than_recorded' })
    expect(!result.ok && result.message).toMatch(/load-inventory/)
  })

  it('refuses an export of the recorded time whose file hash is not the recorded one', () => {
    const result = convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead', { definition_sha256: 'b'.repeat(64) }))
    expect(result).toMatchObject({ ok: false, reason: 'snapshot_differs_from_recorded' })
  })

  it('refuses a workflow the newest recorded export of its project no longer lists', () => {
    const result = convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead', { absent_since_export_at: '2026-10-20T12:00:00Z' }))
    expect(result).toMatchObject({ ok: false, reason: 'absent_from_newest_export' })
  })

  it('refuses a stored time that is not a time rather than letting it compare false (L50)', () => {
    expect(() => convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx1Lead', { last_seen_export_at: 'yesterday' }))).toThrow(/not a time/)
  })

  it('refuses a stored row of another workflow, which would vouch for the wrong snapshot', () => {
    expect(() => convertExport(EXPORT_DIR, 'p_Fx1Lead', recordedRow('p_Fx2Daily'))).toThrow(/p_Fx2Daily.*p_Fx1Lead/)
  })
})

describe('convertExport: what it cannot draft at all (#1695)', () => {
  it('refuses a workflow the export does not list', () => {
    expect(convertExport(EXPORT_DIR, 'p_Fx9Gone', null)).toMatchObject({ ok: false, reason: 'workflow_not_in_export' })
  })

  it('refuses a never deployed workflow, which has no file to draft from', () => {
    expect(convertExport(EXPORT_DIR, 'p_Fx3Never', recordedRow('p_Fx3Never', { definition_sha256: null }))).toMatchObject({ ok: false, reason: 'never_deployed' })
  })
})
