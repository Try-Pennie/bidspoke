import { mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readExport } from '../read-export.ts'
import { workflowFile, writeExport } from './fixture.ts'

describe('readExport (#1710)', () => {
  it('reads every project manifest and pairs each exported workflow with its file', () => {
    const dir = writeExport([
      { projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }, { hashid: 'p_two', status: 'skipped_never_deployed' }] },
      { projectHashid: 'proj_B', exportedAt: '2026-10-01T10:00:00Z', workflows: [{ hashid: 'p_three', file: workflowFile('p_three', { inactive: true }) }] },
    ])
    const projects = readExport(dir)
    expect(projects.map((p) => p.projectHashid)).toEqual(['proj_A', 'proj_B'])
    const a = projects[0]
    expect(a.exportedAt).toBe('2026-09-30T19:26:13Z')
    expect(a.workflows.map((w) => [w.hashid, w.status, w.workflow === null])).toEqual([
      ['p_one', 'exported', false],
      ['p_two', 'skipped_never_deployed', true],
    ])
    expect(a.workflows[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.workflows[1].sha256).toBeNull()
    expect(projects[1].workflows[0].workflow?.inactive).toBe(true)
  })

  it('skips the duplicate folders a repeated download leaves, named with a trailing (1)', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }])
    cpSync(path.join(dir, 'project_export-proj_A'), path.join(dir, 'project_export-proj_A (1)'), { recursive: true })
    expect(readExport(dir).map((p) => p.projectHashid)).toEqual(['proj_A'])
  })

  it('refuses a truncated project, since absence there means nothing', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', truncated: true, workflows: [{ hashid: 'p_one' }] }])
    expect(() => readExport(dir)).toThrow(/proj_A.*truncated/)
  })

  it('refuses a workflow listed by two projects rather than choosing one (L521)', () => {
    const dir = writeExport([
      { projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] },
      { projectHashid: 'proj_B', workflows: [{ hashid: 'p_one' }] },
    ])
    expect(() => readExport(dir)).toThrow(/p_one.*proj_A.*proj_B|p_one.*proj_B.*proj_A/)
  })

  it('refuses one project exported twice, which would let either copy decide absence', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }])
    cpSync(path.join(dir, 'project_export-proj_A'), path.join(dir, 'nested', 'project_export-proj_A'), { recursive: true })
    expect(() => readExport(dir)).toThrow(/proj_A.*twice/)
  })

  it('refuses an exported workflow whose file is missing', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }])
    rmSync(path.join(dir, 'project_export-proj_A', 'p_one-p_one.json'))
    expect(() => readExport(dir)).toThrow(/p_one.*missing/)
  })

  it('refuses a file whose id is not the hashid its manifest names', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one', file: workflowFile('p_other') }] }])
    expect(() => readExport(dir)).toThrow(/p_one.*p_other/)
  })

  it('refuses a workflow file no manifest lists, which no row would ever record', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }])
    writeFileSync(path.join(dir, 'project_export-proj_A', 'stray-p_stray.json'), JSON.stringify(workflowFile('p_stray')))
    expect(() => readExport(dir)).toThrow(/stray-p_stray\.json.*no manifest/)
  })

  it('refuses a status it does not know rather than guessing a state', () => {
    const dir = writeExport([{ projectHashid: 'proj_A', workflows: [{ hashid: 'p_one' }] }])
    const m = path.join(dir, 'project_export-proj_A', 'manifest.json')
    writeFileSync(m, JSON.stringify({ project_hashid: 'proj_A', exported_at: '2026-09-30T19:26:13Z', truncated: false, workflows: [{ hashid: 'p_one', name: 'x', status: 'skipped_paused' }] }))
    expect(() => readExport(dir)).toThrow(/skipped_paused/)
  })

  it('refuses a directory holding no manifest at all, which would read as an empty account', () => {
    const dir = writeExport([])
    mkdirSync(path.join(dir, 'empty'))
    expect(() => readExport(dir)).toThrow(/no manifest/)
  })
})
